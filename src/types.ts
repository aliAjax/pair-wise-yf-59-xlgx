export type RaceStatus = 'scheduled' | 'running' | 'finished';
export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';
// provisional 临时 / corrected 更正待发布 / official 已发布 / invalidated 发布后数据变动，名次失效
export type ResultStatus = 'provisional' | 'corrected' | 'official' | 'invalidated';

export interface Race {
  id: string;
  name: string;
  fleet: string;
  course: string;
  startsAt: string;
  status: RaceStatus;
  updatedAt?: string;
}

export interface RaceEntry {
  id: string;
  boat: string;
  sailNo: string;
  skipper: string;
  elapsedSeconds: number;
  penaltySeconds: number;
  resultStatus: ResultStatus;
  note: string;
  // 乐观并发版本：净用时/处罚/说明每被改动一次即加一
  version: number;
}

export interface Protest {
  id: string;
  raceId: string;
  entryId: string;
  reason: string;
  rule: string;
  status: ProtestStatus;
  decision: string;
  createdAt: string;
  // 抗议结论的并发版本
  version: number;
}

export type TimelineType = 'race' | 'result' | 'protest' | 'system';

export interface TimelineEvent {
  id: string;
  time: string;
  type: TimelineType;
  message: string;
}

export interface OfficialRankingItem {
  rank: number;
  boat: string;
  sailNo: string;
  totalSeconds: number;
}

// 某一版正式成绩的快照，用于整批发布失败时回滚
export interface OfficialSnapshot {
  publishedAt: string;
  publishedBy: string;
  ranking: OfficialRankingItem[];
}

export interface PendingPublish {
  id: string;
  batchId: string;
  entryId: string;
  boat: string;
  sailNo: string;
  totalSeconds: number;
  reason: string;
  failedAt: string;
  attempts: number;
}

export interface ResultConflict {
  id: string;
  kind: 'result' | 'protest';
  // result 时为参赛船 id，protest 时为抗议 id
  documentId: string;
  entryId: string;
  boat: string;
  sailNo: string;
  actor: string;
  fieldLabels: string[];
  baseValues: { elapsedSeconds: number; penaltySeconds: number; note: string };
  attemptedValues: { elapsedSeconds: number; penaltySeconds: number; note: string };
  currentValues: { elapsedSeconds: number; penaltySeconds: number; note: string };
  baseVersion: number;
  currentVersion: number;
  detail: string;
  time: string;
}
