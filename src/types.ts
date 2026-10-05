export type RaceStatus = 'scheduled' | 'running' | 'finished';
export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';
export type ResultStatus = 'provisional' | 'corrected' | 'official';

export interface Race {
  id: string;
  name: string;
  fleet: string;
  course: string;
  startsAt: string;
  status: RaceStatus;
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
  /** 乐观并发版本号：每次净用时/处罚/发布变更递增，后到一方据此校验 */
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
  /** 乐观并发版本号：抗议结论每次变更递增 */
  version: number;
  createdAt: string;
}

export type TimelineEventType = 'race' | 'result' | 'protest' | 'system' | 'conflict' | 'publish';

export interface TimelineEvent {
  id: string;
  time: string;
  type: TimelineEventType;
  message: string;
  /** 批量发布失败后留下的待重试项 */
  pending?: boolean;
  retryKind?: 'publish';
  retryIds?: string[];
  reason?: string;
}

/** 最近一次并发冲突，用于在界面上向操作者说明并保留原文 */
export interface ConflictInfo {
  entityType: 'entry' | 'protest';
  entityId: string;
  boat?: string;
  message: string;
  at: string;
}
