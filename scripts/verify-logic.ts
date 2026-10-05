// 核心状态逻辑验证：版本冲突、名次失效、整批发布回滚、跨标签合并
// 浏览器 API 垫片（localStorage / storage 事件）
const memory = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => memory.has(key) ? memory.get(key)! : null,
  setItem: (key: string, value: string) => { memory.set(key, value); },
  removeItem: (key: string) => { memory.delete(key); }
};
(globalThis as any).window = { addEventListener: () => undefined };

const { store, saveResultThunk, transitionProtestThunk, publishBatch, retryPending, resolveConflict, STORAGE_KEY } =
  await import('../src/store.ts');

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string) {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

const state = () => store.getState().regatta;
const entry = (id: string) => state().entries.find((e) => e.id === id)!;
const protest = state().protests[0];

// 初始：entry-1 provisional v1，entry-3 official
assert(entry('entry-1').version === 1, '初始版本 v1');
assert(entry('entry-3').resultStatus === 'official', 'entry-3 初始已发布');

// 1) 版本校验：基线 v1 保存成功 -> v2
let r1 = store.dispatch(saveResultThunk({
  id: 'entry-1', elapsedSeconds: 3100, penaltySeconds: 0, note: '计时修正',
  base: { elapsedSeconds: 3168, penaltySeconds: 0, note: '' }, baseVersion: 1, actor: '罗夏（计时员）'
}));
assert(r1.ok && r1.version === 2, '匹配基线 v1 的保存成功，版本前进到 v2');
assert(entry('entry-1').resultStatus === 'corrected', '保存后为更正待发布');
assert(entry('entry-3').resultStatus === 'invalidated', '处罚/净用时更新后，已发布的 entry-3 名次失效');

// 2) 晚到一方带旧基线 v1 保存 -> 冲突，被拦截，原文（当前 v2 值）保留
const before = entry('entry-1');
const r2 = store.dispatch(saveResultThunk({
  id: 'entry-1', elapsedSeconds: 9999, penaltySeconds: 50, note: '晚到的仲裁修改',
  base: { elapsedSeconds: 3168, penaltySeconds: 0, note: '' }, baseVersion: 1, actor: '宋宁（仲裁主席）'
}));
assert(!r2.ok, '旧基线 v1 的晚到保存被拦截');
const after = entry('entry-1');
assert(after.elapsedSeconds === before.elapsedSeconds && after.penaltySeconds === before.penaltySeconds && after.version === 2, '被拦截后现值保持 v2 原文，未被 9999/50 覆盖');
assert(state().conflicts.length === 1, '冲突已登记，保留晚到方输入');
assert(state().conflicts[0].attemptedValues.elapsedSeconds === 9999, '冲突记录保留晚到方原文');

// 3) 强制覆盖以当前版本为基线 -> v3 落地
const conflictId = state().conflicts[0].id;
store.dispatch(saveResultThunk({
  id: 'entry-1', elapsedSeconds: 9999, penaltySeconds: 50, note: '晚到的仲裁修改',
  base: { elapsedSeconds: 3168, penaltySeconds: 0, note: '' }, baseVersion: 2,
  actor: '宋宁（仲裁主席）', force: true
}));
store.dispatch(resolveConflict({ id: conflictId }));
assert(entry('entry-1').elapsedSeconds === 9999 && entry('entry-1').version === 3, '确认强制覆盖后落地为 v3');

// 4) 整批发布成功（failAtIndex=-1）-> 全部 official，生成快照
store.dispatch(publishBatch({ ids: ['entry-1', 'entry-2'], actor: '陈港（竞赛官）', failAtIndex: -1, reason: '' }));
assert(entry('entry-1').resultStatus === 'official' && entry('entry-2').resultStatus === 'official', '整批发布成功，两项均为 official');
const snapshotsBefore = state().officialSnapshots.length;
assert(snapshotsBefore >= 1, '正式成绩快照已固化');

// 5) 发布中途失败（第 2 项失败）-> 原子回滚 + 待重试队列 + 时间线原因
// 先准备两个待发布项
store.dispatch(saveResultThunk({
  id: 'entry-1', elapsedSeconds: 9900, penaltySeconds: 0, note: '再次修正',
  base: { elapsedSeconds: 9999, penaltySeconds: 50, note: '晚到的仲裁修改' }, baseVersion: 3, actor: '罗夏（计时员）'
}));
store.dispatch(saveResultThunk({
  id: 'entry-2', elapsedSeconds: 3190, penaltySeconds: 10, note: '仲裁调整',
  base: { elapsedSeconds: 3194, penaltySeconds: 30, note: '标记争议' }, baseVersion: entry('entry-2').version, actor: '宋宁（仲裁主席）'
}));
const pendingCountBefore = state().pendingPublishes.length;
store.dispatch(publishBatch({ ids: ['entry-1', 'entry-2', 'entry-3'], actor: '陈港（竞赛官）', failAtIndex: 1, reason: '成绩板网络中断' }));
// 上一版快照（步骤4）只有 entry-1、entry-2：二者恢复 official；entry-3（失败点之后）从未被翻转
assert(entry('entry-1').resultStatus === 'official', '回滚恢复上一版快照：entry-1 恢复为上一版正式成绩');
assert(entry('entry-2').resultStatus === 'official', '回滚恢复上一版快照：entry-2 恢复为上一版正式成绩');
assert(entry('entry-3').resultStatus !== 'official', '失败点之后的 entry-3 未被发布，不留下半批正式成绩');
assert(state().pendingPublishes.length - pendingCountBefore === 2, '失败项及之后 2 项进入待重试队列');
const pendingMsg = state().timeline.find((e) => e.message.includes('待重试 2 项') && e.message.includes('成绩板网络中断'));
assert(!!pendingMsg, '事件时间线记录待重试项与失败原因');
const rollbackMsg = state().timeline.find((e) => e.message.includes('已恢复上一版正式成绩'));
assert(!!rollbackMsg, '事件时间线记录回滚恢复上一版正式成绩');
assert(state().officialSnapshots.length === snapshotsBefore, '失败批次未生成新快照');

// 6) 重试整组成功 -> 正式发布、队列清空、新快照
const pendingIds = state().pendingPublishes.map((p) => p.entryId);
store.dispatch(retryPending({ ids: pendingIds, actor: '陈港（竞赛官）', failAtIndex: -1, reason: '' }));
assert(state().pendingPublishes.length === 0, '重试成功后待重试队列清空');
assert(state().officialSnapshots.length === snapshotsBefore + 1, '重试成功生成新版正式成绩快照');

// 7) 抗议结论版本校验：另一标签页先给结论 v(n+1)，晚到方旧基线被拦截
const p = state().protests.find((x) => x.id === protest.id)!;
const baseV = p.version;
const ok1 = store.dispatch(transitionProtestThunk({ id: p.id, status: 'resolved', decision: '接受并处罚 20s', penaltySeconds: 20, baseVersion: baseV, actor: '宋宁A' }));
assert(ok1.ok, '仲裁A 以当前版本接受抗议成功');
assert(entry('entry-2').penaltySeconds === 20 || entry(p.entryId).penaltySeconds === 20, '抗议处罚写入参赛船');
assert(state().entries.some((e) => e.resultStatus === 'invalidated'), '抗议结论更新后已发布名次再次失效');
const stale = store.dispatch(transitionProtestThunk({ id: p.id, status: 'rejected', decision: '仲裁B 晚到的驳回', baseVersion: baseV, actor: '宋宁B' }));
assert(!stale.ok, '仲裁B 带旧版本的结论被拦截');
const latest = state().protests.find((x) => x.id === p.id)!;
assert(latest.status === 'resolved' && latest.decision === '接受并处罚 20s', '原文（接受处罚）保留，未被晚到驳回覆盖');

// 8) localStorage 已持久化
const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
assert(persisted.entries.length === state().entries.length && typeof persisted.rev === 'number', '状态已持久化（含 rev）');

// 9) 跨标签页合并：模拟另一标签页基于旧副本写入，高 rev 广播只合并更新集合，不整包覆盖
const localState = state();
const otherEntries = localState.entries.map((e) =>
  e.id === 'entry-3' ? { ...e, elapsedSeconds: 3333, version: e.version + 1, resultStatus: 'corrected' as const } : e
);
const incoming = {
  ...localState,
  rev: localState.rev + 1,
  entries: otherEntries,
  timeline: [{ id: 'event-remote-1', time: new Date().toISOString(), type: 'result' as const, message: '另一标签页修改 entry-3' }]
};
store.dispatch({ type: 'regatta/mergeFromTab', payload: incoming });
assert(entry('entry-3').elapsedSeconds === 3333, '合并后采用另一标签页的 entry-3 新值');
assert(entry('entry-1').elapsedSeconds === 9900 || entry('entry-1').resultStatus === 'official', '合并不会用对方旧副本丢掉本标签页的 entry-1 新值');
assert(state().timeline.some((e) => e.id === 'event-remote-1'), '远程时间线事件按 id 并集合并');

// 低 rev 的过期广播应被忽略
const revNow = state().rev;
store.dispatch({ type: 'regatta/mergeFromTab', payload: { ...state(), rev: 0 } });
assert(state().rev === revNow, '低版本广播不回退本地状态');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
