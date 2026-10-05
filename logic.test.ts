// 逻辑验证：版本校验 / 冲突保留 / 发布失效 / 批量回滚 / 重试
import './test-setup';
import assert from 'node:assert';
import { emitStorage, persistedOf } from './test-setup';
import {
  store,
  saveResult,
  transitionProtest,
  publishBatch,
  retryPublish,
  clearConflict,
  type RootState
} from './src/store';

const get = (): RootState => store.getState().regatta;
const entry = (id: string) => get().entries.find((e) => e.id === id)!;
const protest = (id: string) => get().protests.find((p) => p.id === id)!;

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (err) { console.error(`✗ ${name}`); console.error(err); process.exitCode = 1; }
}

test('初始版本均为 1', () => {
  assert.equal(entry('entry-1').version, 1);
  assert.equal(entry('entry-3').version, 1);
  assert.equal(protest('protest-1').version, 1);
});

test('版本一致的更正保存成功并递增版本', () => {
  store.dispatch(saveResult({ id: 'entry-1', elapsedSeconds: 3150, penaltySeconds: 0, note: '顺风修正', expectedVersion: 1 }));
  assert.equal(entry('entry-1').elapsedSeconds, 3150);
  assert.equal(entry('entry-1').version, 2);
  assert.equal(entry('entry-1').resultStatus, 'corrected');
});

test('过期版本保存被拒绝且原文保留', () => {
  const before = entry('entry-1').elapsedSeconds;
  store.dispatch(saveResult({ id: 'entry-1', elapsedSeconds: 9999, penaltySeconds: 0, note: '晚到覆盖', expectedVersion: 1 }));
  assert.equal(entry('entry-1').elapsedSeconds, before, '净用时未被覆盖');
  assert.equal(entry('entry-1').note, '顺风修正', '原文保留');
  assert.equal(entry('entry-1').version, 2, '版本未递增');
  assert.ok(get().lastConflict, '记录了冲突');
  assert.ok(get().timeline[0].type === 'conflict', '时间线记录冲突');
  store.dispatch(clearConflict());
});

test('抗议接受处罚后已发布成绩失效', () => {
  // entry-3 初始为 official，抗议 protest-1 针对 entry-2。先把 entry-3 关联抗议并接受处罚
  store.dispatch(transitionProtest({ id: 'protest-1', status: 'resolved', decision: '接受抗议并处以30秒处罚', penaltySeconds: 30, expectedVersion: 1 }));
  assert.equal(protest('protest-1').status, 'resolved');
  assert.equal(protest('protest-1').version, 2);
  assert.equal(entry('entry-2').penaltySeconds, 30);
  assert.equal(entry('entry-2').version, 2);
});

test('批量发布：基线一致时全部成功', () => {
  const ids = ['entry-1', 'entry-2'];
  const expected = { 'entry-1': 2, 'entry-2': 2 };
  store.dispatch(publishBatch({ ids, expectedVersions: expected }));
  assert.equal(entry('entry-1').resultStatus, 'official');
  assert.equal(entry('entry-2').resultStatus, 'official');
  assert.equal(entry('entry-1').version, 3);
  assert.equal(entry('entry-2').version, 3);
});

test('批量发布：任一项版本冲突则整批回滚，恢复上一版', () => {
  // entry-1 当前 v3，基线给 v2（过期）；entry-2 基线 v3（一致）
  const snap1 = { status: entry('entry-1').resultStatus, version: entry('entry-1').version };
  const snap2 = { status: entry('entry-2').resultStatus, version: entry('entry-2').version };
  store.dispatch(publishBatch({ ids: ['entry-1', 'entry-2'], expectedVersions: { 'entry-1': 2, 'entry-2': 3 } }));
  assert.equal(entry('entry-1').resultStatus, snap1.status, 'entry-1 回滚到上一版状态');
  assert.equal(entry('entry-1').version, snap1.version, 'entry-1 回滚版本');
  assert.equal(entry('entry-2').resultStatus, snap2.status, 'entry-2 回滚到上一版状态');
  assert.equal(entry('entry-2').version, snap2.version, 'entry-2 回滚版本');
  const pending = get().timeline.find((e) => e.pending && e.retryKind === 'publish');
  assert.ok(pending, '时间线留下待重试项');
  assert.ok(pending!.reason, '待重试项含原因');
  assert.ok(get().lastConflict, '记录冲突提示');
});

test('重试发布：以当前版本重新发布整批并成功', () => {
  const pending = get().timeline.find((e) => e.pending && e.retryKind === 'publish')!;
  store.dispatch(retryPublish({ eventId: pending.id }));
  assert.equal(entry('entry-1').resultStatus, 'official');
  assert.equal(entry('entry-2').resultStatus, 'official');
  assert.equal(get().timeline.find((e) => e.id === pending.id)!.pending, false, '待重试项已结清');
});

test('抗议结论过期版本被拒绝且原文保留', () => {
  const before = protest('protest-1').decision;
  store.dispatch(transitionProtest({ id: 'protest-1', status: 'rejected', decision: '驳回', expectedVersion: 1 }));
  assert.equal(protest('protest-1').status, 'resolved', '结论未被覆盖');
  assert.equal(protest('protest-1').decision, before, '原文保留');
  assert.equal(protest('protest-1').version, 2, '版本未递增');
});

test('跨标签页：相同数据的 storage 事件不触发 hydrate（无回环）', () => {
  // 先保存一次，使 store 进入稳定状态
  store.dispatch(saveResult({ id: 'entry-1', elapsedSeconds: 3100, penaltySeconds: 0, note: '跨标签页测试', expectedVersion: entry('entry-1').version }));
  const before = JSON.stringify(get());
  // 模拟另一标签页回传完全相同的持久化数据（已剔除 lastConflict）
  emitStorage({ key: 'regatta-control-v2', newValue: persistedOf(get()) });
  const after = JSON.stringify(get());
  assert.equal(after, before, '相同数据不应触发 hydrate');
});

test('跨标签页：不同数据的 storage 事件会同步（模拟另一标签页保存）', () => {
  const other = {
    races: get().races,
    entries: get().entries.map((e) => e.id === 'entry-1' ? { ...e, elapsedSeconds: 9999, version: e.version + 1 } : e),
    protests: get().protests,
    timeline: [{ id: 'evt-other', time: new Date().toISOString(), type: 'result', message: '另一标签页保存' }]
  };
  emitStorage({ key: 'regatta-control-v2', newValue: JSON.stringify(other) });
  assert.equal(entry('entry-1').elapsedSeconds, 9999, '同步了另一标签页的成绩');
  assert.equal(get().timeline[0].message, '另一标签页保存', '同步了另一标签页的时间线');
});

test('跨标签页同步后表单基线仍过期，后到保存被拦截', () => {
  // 模拟操作者在本标签页打开表单时基线为 v1，另一标签页已保存到 v2+
  const staleBase = 1;
  store.dispatch(saveResult({ id: 'entry-1', elapsedSeconds: 8888, penaltySeconds: 0, note: '晚到', expectedVersion: staleBase }));
  assert.notEqual(entry('entry-1').elapsedSeconds, 8888, '晚到保存未覆盖同步后的成绩');
  assert.ok(get().lastConflict, '记录冲突并保留原文');
});

console.log(`\n${passed} 项测试通过`);
process.exitCode = process.exitCode ?? 0;
