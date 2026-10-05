import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { OfficialSnapshot, PendingPublish, Protest, ProtestStatus, Race, RaceEntry, ResultConflict, TimelineEvent } from './types';
import { raceApi } from './api';

export interface AppState {
  rev: number;
  races: Race[];
  entries: RaceEntry[];
  protests: Protest[];
  timeline: TimelineEvent[];
  officialSnapshots: OfficialSnapshot[];
  pendingPublishes: PendingPublish[];
  conflicts: ResultConflict[];
}

export const STORAGE_KEY = 'regatta-control-v1';

const now = new Date();
const initialStart = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

const initialEntries: RaceEntry[] = [
  { id: 'entry-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', elapsedSeconds: 3168, penaltySeconds: 0, resultStatus: 'provisional', note: '', version: 1 },
  { id: 'entry-2', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', elapsedSeconds: 3194, penaltySeconds: 30, resultStatus: 'provisional', note: '标记争议', version: 1 },
  { id: 'entry-3', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', elapsedSeconds: 3210, penaltySeconds: 0, resultStatus: 'official', note: '', version: 1 }
];

const initialState: AppState = {
  rev: 1,
  races: [{ id: 'race-1', name: '海湾长距离赛 第1轮', fleet: '统一级', course: 'W2 / 东北风 12节', startsAt: initialStart, status: 'scheduled', updatedAt: now.toISOString() }],
  entries: initialEntries,
  protests: [{ id: 'protest-1', raceId: 'race-1', entryId: 'entry-2', reason: '起航后发生舷侧接触', rule: 'RRS 14', status: 'reviewing', decision: '', createdAt: now.toISOString(), version: 1 }],
  timeline: [
    { id: 'event-1', time: now.toISOString(), type: 'race', message: '航线 W2 已发布' },
    { id: 'event-2', time: new Date(now.getTime() + 2000).toISOString(), type: 'protest', message: '远岚号抗议进入复核' }
  ],
  officialSnapshots: [
    {
      publishedAt: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
      publishedBy: '陈港（竞赛官）',
      ranking: [
        { rank: 1, boat: '北辰号', sailNo: 'CHN 077', totalSeconds: 3210 }
      ]
    }
  ],
  pendingPublishes: [],
  conflicts: []
};

// 旧版本 localStorage 数据迁移：补齐并发版本字段与新集合
export function migrate(raw: Partial<AppState> | null): AppState {
  if (!raw || !Array.isArray(raw.entries)) return initialState;
  return {
    rev: typeof raw.rev === 'number' ? raw.rev : 1,
    races: raw.races ?? initialState.races,
    entries: raw.entries.map((entry) => ({ ...entry, version: entry.version ?? 1 })),
    protests: (raw.protests ?? []).map((protest) => ({ ...protest, version: protest.version ?? 1 })),
    timeline: raw.timeline ?? [],
    officialSnapshots: raw.officialSnapshots ?? [],
    pendingPublishes: raw.pendingPublishes ?? [],
    conflicts: raw.conflicts ?? []
  };
}

function readPersisted(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return migrate(raw ? (JSON.parse(raw) as Partial<AppState>) : null);
  } catch {
    return initialState;
  }
}

export function totalOf(entry: { elapsedSeconds: number; penaltySeconds: number }) {
  return entry.elapsedSeconds + entry.penaltySeconds;
}

function currentRanking(entries: RaceEntry[]): OfficialSnapshot['ranking'] {
  return [...entries]
    .filter((entry) => entry.resultStatus === 'official')
    .sort((a, b) => totalOf(a) - totalOf(b))
    .map((entry, index) => ({ rank: index + 1, boat: entry.boat, sailNo: entry.sailNo, totalSeconds: totalOf(entry) }));
}

// 处罚/抗议结论更新后，全部已发布名次失效，等待重新发布
function invalidateOfficialResults(state: AppState, reason: string) {
  const hasOfficial = state.entries.some((entry) => entry.resultStatus === 'official');
  if (!hasOfficial) return false;
  for (const entry of state.entries) {
    if (entry.resultStatus === 'official') entry.resultStatus = 'invalidated';
  }
  state.timeline.unshift({
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    type: 'system',
    message: `基础数据变更（${reason}）：上一版正式名次全部失效，需重算后重新发布`
  });
  return true;
}

interface CommitResultPayload {
  id: string;
  elapsedSeconds: number;
  penaltySeconds: number;
  note: string;
  actor: string;
}

interface CommitProtestPayload {
  id: string;
  status: ProtestStatus;
  decision?: string;
  penaltySeconds: number | null;
  actor: string;
  version: number;
}

interface PublishBatchPayload {
  ids: string[];
  actor: string;
  failAtIndex: number; // -1 表示整批成功
  reason: string;
}

interface RetryPublishPayload {
  ids: string[];
  actor: string;
  failAtIndex: number;
  reason: string;
}

const slice = createSlice({
  name: 'regatta',
  initialState,
  reducers: {
    setRaceStatus(state, action: PayloadAction<{ id: string; status: Race['status'] }>) {
      const race = state.races.find((item) => item.id === action.payload.id);
      if (race) {
        race.status = action.payload.status;
        race.updatedAt = new Date().toISOString();
        state.rev += 1;
        state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'race', message: `${race.name} 状态更新为 ${race.status}` });
      }
    },
    commitResult(state, action: PayloadAction<CommitResultPayload>) {
      const entry = state.entries.find((item) => item.id === action.payload.id);
      if (!entry) return;
      const { elapsedSeconds, penaltySeconds, note, actor } = action.payload;
      const scoreChanged = entry.elapsedSeconds !== elapsedSeconds || entry.penaltySeconds !== penaltySeconds;
      const noteChanged = entry.note !== note;
      if (!scoreChanged && !noteChanged) return;
      entry.elapsedSeconds = elapsedSeconds;
      entry.penaltySeconds = penaltySeconds;
      entry.note = note;
      entry.version += 1;
      state.rev += 1;
      // 净用时或处罚变化后，已发布名次全部失效，等待重算重发；仅改说明不影响名次
      if (scoreChanged) invalidateOfficialResults(state, `${entry.boat} 净用时/处罚被 ${actor} 更新`);
      if (entry.resultStatus !== 'official' && entry.resultStatus !== 'invalidated') entry.resultStatus = 'corrected';
      state.timeline.unshift({
        id: crypto.randomUUID(),
        time: new Date().toISOString(),
        type: 'result',
        message: `${actor} 保存 ${entry.boat} 更正：净用时 ${elapsedSeconds}s + 处罚 ${penaltySeconds}s = ${elapsedSeconds + penaltySeconds}s（版本 v${entry.version}）`
      });
    },
    commitProtest(state, action: PayloadAction<CommitProtestPayload>) {
      const protest = state.protests.find((item) => item.id === action.payload.id);
      if (!protest) return;
      const prevStatus = protest.status;
      protest.status = action.payload.status;
      protest.decision = action.payload.decision ?? protest.decision;
      protest.version = action.payload.version;
      state.rev += 1;
      const entry = state.entries.find((item) => item.id === protest.entryId);
      const terminal = action.payload.status === 'resolved' || action.payload.status === 'rejected';
      let scoreReason = '';
      if (action.payload.status === 'resolved' && action.payload.penaltySeconds !== null && entry) {
        if (entry.penaltySeconds !== action.payload.penaltySeconds) {
          entry.penaltySeconds = action.payload.penaltySeconds;
          entry.version += 1;
          scoreReason = `抗议结论改为处罚 ${action.payload.penaltySeconds}s`;
        }
        entry.resultStatus = entry.resultStatus === 'official' || entry.resultStatus === 'invalidated' ? entry.resultStatus : 'corrected';
      }
      if (action.payload.status === 'rejected' && entry) {
        scoreReason = '抗议被驳回、维持原成绩';
        if (entry.resultStatus !== 'official' && entry.resultStatus !== 'invalidated') entry.resultStatus = 'corrected';
      }
      // 抗议结论（接受/驳回）落地后，已发布名次重算失效
      if (terminal) invalidateOfficialResults(state, `${entry?.boat ?? '参赛船'} ${scoreReason}，${action.payload.actor} 给出抗议结论`);
      state.timeline.unshift({
        id: crypto.randomUUID(),
        time: new Date().toISOString(),
        type: 'protest',
        message: `${action.payload.actor} 将抗议 ${protest.rule}（${prevStatus} → ${protest.status}）更新至 v${protest.version}${protest.decision ? `：${protest.decision}` : ''}`
      });
    },
    // 整批发布的原子处理：任一船失败则整批回滚到上一版正式成绩
    publishBatch(state, action: PayloadAction<PublishBatchPayload>) {
      const { ids, actor, failAtIndex, reason } = action.payload;
      const batchId = crypto.randomUUID();
      const time = new Date().toISOString();
      const before = state.entries.map((entry) => ({ id: entry.id, resultStatus: entry.resultStatus }));
      const previousSnapshot = state.officialSnapshots[state.officialSnapshots.length - 1] ?? null;

      for (let index = 0; index < ids.length; index += 1) {
        if (index === failAtIndex) {
          // 发布中途失败：恢复上一版正式成绩（快照内的船恢复 official，其余回到批次前状态）
          const snapshotKeys = new Set((previousSnapshot?.ranking ?? []).map((item) => `${item.boat}|${item.sailNo}`));
          state.entries.forEach((entry, entryIndex) => {
            const inPreviousSnapshot = snapshotKeys.has(`${entry.boat}|${entry.sailNo}`);
            entry.resultStatus = inPreviousSnapshot ? 'official' : before[entryIndex].resultStatus;
          });
          const failedIds = ids.slice(failAtIndex);
          const pending: PendingPublish[] = failedIds.flatMap((id, offset) => {
            const failedEntry = state.entries.find((item) => item.id === id);
            if (!failedEntry) return [];
            return [{
              id: crypto.randomUUID(),
              batchId,
              entryId: failedEntry.id,
              boat: failedEntry.boat,
              sailNo: failedEntry.sailNo,
              totalSeconds: totalOf(failedEntry),
              reason,
              failedAt: time,
              attempts: 1 + offset
            }];
          });
          state.pendingPublishes.unshift(...pending);
          state.rev += 1;
          state.timeline.unshift(
            { id: crypto.randomUUID(), time, type: 'result', message: `⚠ 整批正式成绩发布在第 ${failAtIndex + 1}/${ids.length} 项失败（${reason}），已回滚恢复上一版正式成绩` },
            { id: crypto.randomUUID(), time, type: 'result', message: `待重试 ${failedIds.length} 项：${pending.map((item) => item.boat).join('、')}；原因：${reason}；批次 ${batchId.slice(0, 8)}` }
          );
          if (previousSnapshot) {
            state.timeline.unshift({
              id: crypto.randomUUID(),
              time,
              type: 'system',
              message: `已恢复上一版正式成绩（${previousSnapshot.publishedBy} 于 ${new Date(previousSnapshot.publishedAt).toLocaleTimeString()} 发布，${previousSnapshot.ranking.length} 个名次）`
            });
          }
          return;
        }
        const entry = state.entries.find((item) => item.id === ids[index]);
        if (entry) entry.resultStatus = 'official';
      }

      // 全部成功：固化这一版正式成绩快照
      const snapshot: OfficialSnapshot = { publishedAt: time, publishedBy: actor, ranking: currentRanking(state.entries) };
      state.officialSnapshots.push(snapshot);
      state.rev += 1;
      state.timeline.unshift({
        id: crypto.randomUUID(),
        time,
        type: 'result',
        message: `${actor} 整批发布 ${ids.length} 项正式成绩，正式名次 ${snapshot.ranking.length} 个（批次 ${batchId.slice(0, 8)}）`
      });
    },
    retryPending(state, action: PayloadAction<RetryPublishPayload>) {
      const { ids, actor, failAtIndex, reason } = action.payload;
      const time = new Date().toISOString();
      const targetEntries = state.pendingPublishes.filter((item) => ids.includes(item.entryId));
      if (failAtIndex === -1) {
        for (const id of ids) {
          const entry = state.entries.find((item) => item.id === id);
          if (entry) entry.resultStatus = 'official';
        }
        state.pendingPublishes = state.pendingPublishes.filter((item) => !ids.includes(item.entryId));
        const snapshot: OfficialSnapshot = { publishedAt: time, publishedBy: actor, ranking: currentRanking(state.entries) };
        state.officialSnapshots.push(snapshot);
        state.rev += 1;
        state.timeline.unshift({
          id: crypto.randomUUID(),
          time,
          type: 'result',
          message: `待重试队列重试成功：${ids.length} 项正式成绩已发布（${targetEntries.map((item) => item.boat).join('、') || ids.join(',')}）`
        });
        return;
      }
      const succeededIds = ids.slice(0, failAtIndex);
      for (const id of succeededIds) {
        const entry = state.entries.find((item) => item.id === id);
        if (entry) entry.resultStatus = 'official';
      }
      const failedIds = ids.slice(failAtIndex);
      for (const item of state.pendingPublishes) {
        if (failedIds.includes(item.entryId)) {
          item.attempts += 1;
          item.reason = reason;
          item.failedAt = time;
        }
      }
      state.rev += 1;
      state.timeline.unshift({
        id: crypto.randomUUID(),
        time,
        type: 'result',
        message: `重试在第 ${failAtIndex + 1}/${ids.length} 项再次失败（${reason}），已发布 ${succeededIds.length} 项，剩余 ${failedIds.length} 项继续留在待重试队列`
      });
    },
    addProtest(state, action: PayloadAction<{ raceId: string; entryId: string; reason: string; rule: string }>) {
      const protest: Protest = { id: crypto.randomUUID(), ...action.payload, status: 'submitted', decision: '', createdAt: new Date().toISOString(), version: 1 };
      state.protests.unshift(protest);
      state.rev += 1;
      state.timeline.unshift({ id: crypto.randomUUID(), time: protest.createdAt, type: 'protest', message: `收到 ${action.payload.rule} 抗议，等待复核（v1）` });
    },
    pushConflict(state, action: PayloadAction<ResultConflict>) {
      state.conflicts.unshift(action.payload);
      state.rev += 1;
      state.timeline.unshift({
        id: crypto.randomUUID(),
        time: action.payload.time,
        type: 'system',
        message: `⚠ 版本冲突已拦截：${action.payload.actor} 保存 ${action.payload.boat} 失败，对方在 v${action.payload.baseVersion} 之后已改到 v${action.payload.currentVersion}（${action.payload.fieldLabels.join('、')}），原文已保留`
      });
    },
    resolveConflict(state, action: PayloadAction<{ id: string }>) {
      state.conflicts = state.conflicts.filter((item) => item.id !== action.payload.id);
      state.rev += 1;
    },
    // 接收其他标签页广播的最新状态，按集合合并，避免晚到保存整包覆盖
    mergeFromTab(state, action: PayloadAction<AppState>) {
      const other = action.payload;
      if (other.rev <= state.rev) return;
      state.rev = other.rev;
      state.races = other.races;
      const entryMap = new Map(state.entries.map((entry) => [entry.id, entry]));
      for (const incoming of other.entries) {
        const local = entryMap.get(incoming.id);
        if (!local || incoming.version > local.version) entryMap.set(incoming.id, incoming);
      }
      state.entries = Array.from(entryMap.values());
      const protestMap = new Map(state.protests.map((item) => [item.id, item]));
      for (const incoming of other.protests) {
        const local = protestMap.get(incoming.id);
        if (!local || incoming.version > local.version) protestMap.set(incoming.id, incoming);
      }
      state.protests = Array.from(protestMap.values());
      const timelineIds = new Set(state.timeline.map((item) => item.id));
      state.timeline = [...state.timeline, ...other.timeline.filter((item) => !timelineIds.has(item.id))]
        .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
      state.officialSnapshots = other.officialSnapshots.length >= state.officialSnapshots.length ? other.officialSnapshots : state.officialSnapshots;
      const pendingIds = new Set(state.pendingPublishes.map((item) => item.id));
      state.pendingPublishes = [...state.pendingPublishes, ...other.pendingPublishes.filter((item) => !pendingIds.has(item.id))];
      const conflictIds = new Set(state.conflicts.map((item) => item.id));
      state.conflicts = [...state.conflicts, ...other.conflicts.filter((item) => !conflictIds.has(item.id))];
    }
  }
});

export interface SaveResultInput {
  id: string;
  elapsedSeconds: number;
  penaltySeconds: number;
  note: string;
  // 打开表单时看到的值，用于说明冲突发生在哪些字段
  base: { elapsedSeconds: number; penaltySeconds: number; note: string };
  baseVersion: number;
  actor: string;
  force?: boolean;
}

export type SaveResultOutcome =
  | { ok: true; version: number; invalidated: boolean }
  | { ok: false; conflict: ResultConflict };

export const saveResultThunk =
  (input: SaveResultInput) =>
  (dispatch: AppDispatch, getState: () => RootState): SaveResultOutcome => {
    // 以持久化中的最新数据做版本校验（另一标签页的保存会先落 localStorage）
    const persisted = readPersisted();
    const target = persisted.entries.find((item) => item.id === input.id);
    if (!target) {
      return { ok: false, conflict: {
        id: crypto.randomUUID(), kind: 'result', documentId: input.id, entryId: input.id, boat: '未知参赛船', sailNo: '',
        actor: input.actor, fieldLabels: ['参赛船'],
        baseValues: input.base, attemptedValues: { elapsedSeconds: input.elapsedSeconds, penaltySeconds: input.penaltySeconds, note: input.note },
        currentValues: input.base, baseVersion: input.baseVersion, currentVersion: input.baseVersion,
        detail: '找不到该参赛船的成绩记录', time: new Date().toISOString()
      } };
    }

    if (!input.force && target.version !== input.baseVersion) {
      const changedFields: string[] = [];
      if (target.elapsedSeconds !== input.base.elapsedSeconds) changedFields.push('净用时');
      if (target.penaltySeconds !== input.base.penaltySeconds) changedFields.push('处罚秒数');
      if (target.note !== input.base.note) changedFields.push('更正说明');
      const conflict: ResultConflict = {
        id: crypto.randomUUID(),
        kind: 'result',
        documentId: target.id,
        entryId: target.id,
        boat: target.boat,
        sailNo: target.sailNo,
        actor: input.actor,
        fieldLabels: changedFields.length ? changedFields : ['成绩数据'],
        baseValues: input.base,
        attemptedValues: { elapsedSeconds: input.elapsedSeconds, penaltySeconds: input.penaltySeconds, note: input.note },
        currentValues: { elapsedSeconds: target.elapsedSeconds, penaltySeconds: target.penaltySeconds, note: target.note },
        baseVersion: input.baseVersion,
        currentVersion: target.version,
        detail: `你打开表单时是 v${input.baseVersion}，对方已保存到 v${target.version}`,
        time: new Date().toISOString()
      };
      dispatch(slice.actions.pushConflict(conflict));
      return { ok: false, conflict };
    }

    dispatch(slice.actions.commitResult({
      id: input.id,
      elapsedSeconds: input.elapsedSeconds,
      penaltySeconds: input.penaltySeconds,
      note: input.note,
      actor: input.actor
    }));
    const after = readPersisted().entries.find((item) => item.id === input.id);
    const invalidated = getState().regatta.entries.some((entry) => entry.resultStatus === 'invalidated');
    return { ok: true, version: after?.version ?? input.baseVersion + 1, invalidated };
  };

export interface TransitionProtestInput {
  id: string;
  status: ProtestStatus;
  decision?: string;
  penaltySeconds?: number;
  baseVersion: number;
  actor: string;
  force?: boolean;
}

export type TransitionProtestOutcome =
  | { ok: true; version: number }
  | { ok: false; conflict: ResultConflict };

export const transitionProtestThunk =
  (input: TransitionProtestInput) =>
  (dispatch: AppDispatch, getState: () => RootState): TransitionProtestOutcome => {
    const persisted = readPersisted();
    const target = persisted.protests.find((item) => item.id === input.id);
    if (!target) {
      return { ok: false, conflict: {
        id: crypto.randomUUID(), kind: 'protest', documentId: input.id, entryId: '', boat: '未知抗议', sailNo: '',
        actor: input.actor, fieldLabels: ['抗议'],
        baseValues: { elapsedSeconds: 0, penaltySeconds: 0, note: '' },
        attemptedValues: { elapsedSeconds: 0, penaltySeconds: input.penaltySeconds ?? 0, note: `${input.status}：${input.decision ?? ''}` },
        currentValues: { elapsedSeconds: 0, penaltySeconds: 0, note: '' },
        baseVersion: input.baseVersion, currentVersion: input.baseVersion,
        detail: '找不到该抗议记录', time: new Date().toISOString()
      } };
    }
    const local = getState().regatta.protests.find((item) => item.id === input.id);
    const entry = getState().regatta.entries.find((item) => item.id === target.entryId);

    const terminal = input.status === 'resolved' || input.status === 'rejected';
    if (!input.force && terminal && target.version !== input.baseVersion) {
      const conflict: ResultConflict = {
        id: crypto.randomUUID(),
        kind: 'protest',
        documentId: target.id,
        entryId: target.entryId,
        boat: entry?.boat ?? '参赛船',
        sailNo: entry?.sailNo ?? '',
        actor: input.actor,
        fieldLabels: ['抗议结论'],
        baseValues: {
          elapsedSeconds: entry?.elapsedSeconds ?? 0,
          penaltySeconds: entry?.penaltySeconds ?? 0,
          note: local ? `${local.status}：${local.decision || '（无结论）'}` : ''
        },
        attemptedValues: {
          elapsedSeconds: entry?.elapsedSeconds ?? 0,
          penaltySeconds: input.penaltySeconds ?? entry?.penaltySeconds ?? 0,
          note: `${input.status}：${input.decision ?? ''}`
        },
        currentValues: {
          elapsedSeconds: entry?.elapsedSeconds ?? 0,
          penaltySeconds: entry?.penaltySeconds ?? 0,
          note: `${target.status}：${target.decision || '（无结论）'}`
        },
        baseVersion: input.baseVersion,
        currentVersion: target.version,
        detail: `你处理抗议时是 v${input.baseVersion}，另一标签页已把抗议结论更新到 v${target.version}`,
        time: new Date().toISOString()
      };
      dispatch(slice.actions.pushConflict(conflict));
      return { ok: false, conflict };
    }

    dispatch(slice.actions.commitProtest({
      id: input.id,
      status: input.status,
      decision: input.decision,
      penaltySeconds: typeof input.penaltySeconds === 'number' ? input.penaltySeconds : null,
      actor: input.actor,
      version: target.version + 1
    }));
    const after = readPersisted().protests.find((item) => item.id === input.id);
    return { ok: true, version: after?.version ?? target.version + 1 };
  };

const preloadedState = readPersisted();

export const { setRaceStatus, addProtest, pushConflict, resolveConflict, publishBatch, retryPending } = slice.actions;

export const store = configureStore({
  reducer: { regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  preloadedState: { regatta: preloadedState },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware)
});

store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().regatta)));

// 跨标签页：收到另一标签页的写入后按版本合并，不用自己的旧数据整包盖回去
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY || !event.newValue) return;
  try {
    const incoming = migrate(JSON.parse(event.newValue) as Partial<AppState>);
    store.dispatch(slice.actions.mergeFromTab(incoming));
  } catch {
    // 忽略无法解析的广播
  }
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
