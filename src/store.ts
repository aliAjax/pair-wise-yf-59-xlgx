import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ConflictInfo, Protest, ProtestStatus, Race, RaceEntry, TimelineEvent } from './types';
import { raceApi } from './api';

export interface AppState {
  races: Race[];
  entries: RaceEntry[];
  protests: Protest[];
  timeline: TimelineEvent[];
  lastConflict: ConflictInfo | null;
}

const initialEntries: RaceEntry[] = [
  { id: 'entry-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', elapsedSeconds: 3168, penaltySeconds: 0, resultStatus: 'provisional', note: '', version: 1 },
  { id: 'entry-2', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', elapsedSeconds: 3194, penaltySeconds: 30, resultStatus: 'corrected', note: '标记争议', version: 1 },
  { id: 'entry-3', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', elapsedSeconds: 3210, penaltySeconds: 0, resultStatus: 'official', note: '', version: 1 }
];

const now = new Date();
const initialStart = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

const initialState: AppState = {
  races: [{ id: 'race-1', name: '海湾长距离赛 第1轮', fleet: '统一级', course: 'W2 / 东北风 12节', startsAt: initialStart, status: 'scheduled' }],
  entries: initialEntries,
  protests: [{ id: 'protest-1', raceId: 'race-1', entryId: 'entry-2', reason: '起航后发生舷侧接触', rule: 'RRS 14', status: 'reviewing', decision: '', version: 1, createdAt: now.toISOString() }],
  timeline: [
    { id: 'event-1', time: now.toISOString(), type: 'race', message: '航线 W2 已发布' },
    { id: 'event-2', time: new Date(now.getTime() + 2000).toISOString(), type: 'protest', message: '远岚号抗议进入复核' }
  ],
  lastConflict: null
};

function newId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

/** 乐观并发冲突：后到一方说明冲突、保留原文，不覆盖先到结果 */
function rejectConflict(
  state: AppState,
  info: { entityType: ConflictInfo['entityType']; entityId: string; boat?: string; message: string }
) {
  const at = nowIso();
  state.timeline.unshift({ id: newId(), time: at, type: 'conflict', message: info.message });
  state.lastConflict = { ...info, at };
}

const slice = createSlice({
  name: 'regatta',
  initialState,
  reducers: {
    setRaceStatus(state, action: PayloadAction<{ id: string; status: Race['status'] }>) {
      const race = state.races.find((item) => item.id === action.payload.id);
      if (race) {
        race.status = action.payload.status;
        state.timeline.unshift({ id: newId(), time: nowIso(), type: 'race', message: `${race.name} 状态更新为 ${race.status}` });
      }
    },

    /**
     * 成绩更正（净用时 / 处罚 / 说明）。
     * 按版本校验：expectedVersion 是操作者打开表单时的基线版本，
     * 若期间已被另一方修改（版本不一致），则拒绝保存、保留原文并记录冲突。
     * 任何非发布的更正都会使已发布正式成绩失效（official -> corrected）。
     */
    saveResult(state, action: PayloadAction<{ id: string; elapsedSeconds: number; penaltySeconds: number; note: string; expectedVersion: number }>) {
      const entry = state.entries.find((item) => item.id === action.payload.id);
      if (!entry) return;
      if (entry.version !== action.payload.expectedVersion) {
        rejectConflict(state, {
          entityType: 'entry',
          entityId: entry.id,
          boat: entry.boat,
          message: `保存被拒绝：${entry.boat} 的成绩已被另一方更新（当前版本 v${entry.version}，你的基线 v${action.payload.expectedVersion}）。请基于最新版本修改，原文已保留。`
        });
        return;
      }
      const wasOfficial = entry.resultStatus === 'official';
      entry.elapsedSeconds = action.payload.elapsedSeconds;
      entry.penaltySeconds = action.payload.penaltySeconds;
      entry.note = action.payload.note;
      entry.version += 1;
      entry.resultStatus = 'corrected';
      state.timeline.unshift({
        id: newId(),
        time: nowIso(),
        type: 'result',
        message: `${entry.boat} 成绩更正为 ${entry.elapsedSeconds + entry.penaltySeconds} 秒（v${entry.version}）${wasOfficial ? '；已发布正式成绩失效，需重新发布' : ''}`
      });
      state.lastConflict = null;
    },

    addProtest(state, action: PayloadAction<{ raceId: string; entryId: string; reason: string; rule: string }>) {
      const protest: Protest = { id: newId(), ...action.payload, status: 'submitted', decision: '', version: 1, createdAt: nowIso() };
      state.protests.unshift(protest);
      state.timeline.unshift({ id: newId(), time: protest.createdAt, type: 'protest', message: `收到 ${action.payload.rule} 抗议，等待复核` });
    },

    /**
     * 抗议结论更新。
     * 按版本校验抗议本身；接受抗议（resolved）并适用处罚时，
     * 同步递增成绩版本，并使该船已发布正式成绩失效。
     */
    transitionProtest(state, action: PayloadAction<{ id: string; status: ProtestStatus; decision?: string; penaltySeconds?: number; expectedVersion: number }>) {
      const protest = state.protests.find((item) => item.id === action.payload.id);
      if (!protest) return;
      if (protest.version !== action.payload.expectedVersion) {
        const boat = state.entries.find((item) => item.id === protest.entryId)?.boat ?? '';
        rejectConflict(state, {
          entityType: 'protest',
          entityId: protest.id,
          boat,
          message: `抗议处理被拒绝：${protest.rule}（${boat}）的结论已被另一方更新（当前 v${protest.version}，基线 v${action.payload.expectedVersion}）。原文已保留，请刷新后再处理。`
        });
        return;
      }
      protest.status = action.payload.status;
      protest.decision = action.payload.decision ?? protest.decision;
      protest.version += 1;
      const boat = state.entries.find((item) => item.id === protest.entryId)?.boat ?? '';
      let invalidated = false;
      if (action.payload.status === 'resolved') {
        const entry = state.entries.find((item) => item.id === protest.entryId);
        if (entry) {
          if (action.payload.penaltySeconds != null) {
            entry.penaltySeconds = action.payload.penaltySeconds;
          }
          if (entry.resultStatus === 'official') {
            entry.resultStatus = 'corrected';
            invalidated = true;
          }
          entry.version += 1;
        }
      }
      state.timeline.unshift({
        id: newId(),
        time: nowIso(),
        type: 'protest',
        message: `抗议 ${protest.rule} 更新为 ${action.payload.status}（v${protest.version}）${invalidated ? `；${boat} 已发布正式成绩失效，需重新发布` : ''}`
      });
      state.lastConflict = null;
    },

    /**
     * 批量发布正式成绩（原子事务）。
     * 逐条应用，任一项版本冲突即中止并回滚本批已应用的所有项，
     * 恢复上一版正式成绩；同时在事件时间线留下待重试项与原因。
     */
    publishBatch(state, action: PayloadAction<{ ids: string[]; expectedVersions: Record<string, number> }>) {
      const ids = action.payload.ids;
      const targets = state.entries.filter((item) => ids.includes(item.id));
      if (targets.length === 0) return;
      const snapshot = targets.map((item) => ({ id: item.id, resultStatus: item.resultStatus, version: item.version }));
      const applied: string[] = [];
      const failures: { boat: string; reason: string }[] = [];

      for (const entry of targets) {
        const expected = action.payload.expectedVersions[entry.id];
        if (expected == null || entry.version !== expected) {
          failures.push({ boat: entry.boat, reason: `版本冲突（当前 v${entry.version}，基线 v${expected ?? '?'}），成绩已被另一方修改` });
          break;
        }
        entry.resultStatus = 'official';
        entry.version += 1;
        applied.push(entry.id);
      }

      if (failures.length > 0) {
        // 回滚本批已应用项，恢复上一版正式成绩
        for (const entry of targets) {
          if (applied.includes(entry.id)) {
            const snap = snapshot.find((s) => s.id === entry.id)!;
            entry.resultStatus = snap.resultStatus;
            entry.version = snap.version;
          }
        }
        const reason = failures.map((f) => `${f.boat}：${f.reason}`).join('；');
        const event: TimelineEvent = {
          id: newId(),
          time: nowIso(),
          type: 'publish',
          message: `批量发布失败：${failures.length} 项版本冲突，已恢复上一版正式成绩（回滚 ${applied.length} 项）。待重试：${targets.map((t) => t.boat).join('、')}。`,
          pending: true,
          retryKind: 'publish',
          retryIds: targets.map((t) => t.id),
          reason
        };
        state.timeline.unshift(event);
        state.lastConflict = {
          entityType: 'entry',
          entityId: targets.find((t) => !applied.includes(t.id))?.id ?? targets[0].id,
          boat: failures.map((f) => f.boat).join('、'),
          message: `批量发布被拒绝：${reason}。已回滚 ${applied.length} 项，上一版正式成绩已恢复，请刷新基线后重试。`,
          at: event.time
        };
        return;
      }

      // 成功：结清历史待重试项
      for (const te of state.timeline) {
        if (te.pending && te.retryKind === 'publish') te.pending = false;
      }
      state.timeline.unshift({
        id: newId(),
        time: nowIso(),
        type: 'publish',
        message: `已批量发布 ${targets.length} 项正式成绩，排名按净用时+处罚重算`
      });
      state.lastConflict = null;
    },

    /** 重试时间线上的待重试发布项（以当前版本重新发布整批）。 */
    retryPublish(state, action: PayloadAction<{ eventId: string }>) {
      const event = state.timeline.find((item) => item.id === action.payload.eventId);
      if (!event || !event.pending || event.retryKind !== 'publish') return;
      const ids = event.retryIds ?? [];
      const targets = state.entries.filter((item) => ids.includes(item.id));
      for (const entry of targets) {
        entry.resultStatus = 'official';
        entry.version += 1;
      }
      event.pending = false;
      state.timeline.unshift({
        id: newId(),
        time: nowIso(),
        type: 'publish',
        message: `重试发布成功：已发布 ${targets.length} 项正式成绩`
      });
      state.lastConflict = null;
    },

    clearConflict(state) {
      state.lastConflict = null;
    },

    /** 跨标签页同步：用另一标签页写入的状态覆盖（保留本标签页的冲突提示）。 */
    hydrate(state, action: PayloadAction<Partial<AppState>>) {
      const incoming = action.payload;
      if (incoming.races) state.races = incoming.races;
      if (incoming.entries) state.entries = incoming.entries;
      if (incoming.protests) state.protests = incoming.protests;
      if (incoming.timeline) state.timeline = incoming.timeline;
    }
  }
});

const STORAGE_KEY = 'regatta-control-v2';

function migrate(raw: unknown): AppState {
  const parsed = (raw ?? {}) as Partial<AppState>;
  return {
    races: parsed.races ?? initialState.races,
    entries: (parsed.entries ?? initialState.entries).map((entry, index) => ({
      ...entry,
      version: entry.version ?? index + 1
    })),
    protests: (parsed.protests ?? initialState.protests).map((protest) => ({
      ...protest,
      version: protest.version ?? 1
    })),
    timeline: parsed.timeline ?? initialState.timeline,
    lastConflict: null
  };
}

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch {
    // 损坏的本地数据直接回退到初始状态
  }
  return migrate(initialState);
}

const preloadedState: AppState = loadState();

export const {
  setRaceStatus,
  saveResult,
  addProtest,
  transitionProtest,
  publishBatch,
  retryPublish,
  clearConflict,
  hydrate
} = slice.actions;

export const store = configureStore({
  reducer: { regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware),
  preloadedState: { regatta: preloadedState }
});

// 仅在状态变化时写回，避免跨标签页 storage 事件引发回环
let lastWritten = JSON.stringify(preloadedState);
store.subscribe(() => {
  const regatta = store.getState().regatta;
  const { lastConflict: _omit, ...persistable } = regatta;
  const next = JSON.stringify(persistable);
  if (next !== lastWritten) {
    lastWritten = next;
    localStorage.setItem(STORAGE_KEY, next);
  }
});

// 两个标签页同时修改同一场比赛：另一标签页保存后，本标签页基于 storage 事件同步。
// 同步不会刷新表单基线版本，因此后到一方仍会被版本校验拦截并保留原文。
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY || !event.newValue) return;
  try {
    const incoming = JSON.parse(event.newValue) as Partial<AppState>;
    // 与持久化口径保持一致：剔除 lastConflict 后再比较，避免结构差异引发回环
    const { lastConflict: _omit, ...persistable } = store.getState().regatta;
    if (event.newValue !== JSON.stringify(persistable)) {
      store.dispatch(hydrate(incoming));
    }
  } catch {
    // 忽略无法解析的跨标签页数据
  }
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
