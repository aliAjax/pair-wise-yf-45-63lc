export type Role = "制片" | "导演" | "演员统筹" | "场记";
export type SceneStatus = "草稿" | "已确认" | "拍摄中" | "已完成";
export type ConflictType = "演员档期" | "场地占用" | "器材借用" | "转场时间";
export type ExemptionStatus = "有效" | "已作废";
export type PendingStatus = "待审" | "已通过" | "已驳回";

export interface Talent {
  id: string;
  name: string;
  role: string;
}

export interface Location {
  id: string;
  name: string;
}

export interface Equipment {
  id: string;
  name: string;
}

export interface Scene {
  id: string;
  code: string;
  title: string;
  day: string;
  start: string;
  end: string;
  talentIds: string[];
  locationId: string;
  equipmentIds: string[];
  status: SceneStatus;
  locked: boolean;
  /** 并发版本号：两位负责人同时保存同一场时，先到者胜 */
  version: number;
  /** 最近一次保存/确认该场的负责人，用于提示“是谁先确认” */
  lastConfirmedBy?: Role;
  lastConfirmedAt?: string;
}

export interface Conflict {
  id: string;
  type: ConflictType;
  sceneIds: string[];
  message: string;
  severity: "高" | "中";
}

export interface HistoryEntry {
  id: string;
  action: string;
  detail: string;
  time: string;
}

export interface Version {
  id: string;
  name: string;
  time: string;
  scenes: Scene[];
  /** 若该版本是一次“确认通告”快照，则记录确认人 */
  confirmedBy?: Role;
  /** 快照内容哈希，用于幂等：同一份快照重复提交不会多出一版 */
  contentHash: string;
}

export interface OfflineDraft {
  scenes: Scene[];
  savedAt: string;
}

/** 豁免只对某一份确认快照负责，并记录豁免时涉及场次的状态指纹 */
export interface Exemption {
  id: string;
  conflictId: string;
  /** 豁免所依据的确认快照 */
  snapshotId: string;
  /** 豁免时涉及场次的 时间/演员/场地 指纹；任一变化即作废 */
  fingerprint: string;
  sceneIds: string[];
  exemptedBy: Role;
  time: string;
  status: ExemptionStatus;
  voidedAt?: string;
  voidReason?: string;
}

/** 场记（及演员统筹）的改动进待审，负责人审批后才生效 */
export interface PendingChange {
  id: string;
  type: "新增场次" | "修改场次" | "流转状态";
  payload: any;
  submittedBy: Role;
  submittedAt: string;
  status: PendingStatus;
  reviewedBy?: Role;
  reviewedAt?: string;
  reason?: string;
}

/** 提交失败（如先到者胜）后保留，可接着重试 */
export interface FailedSubmission {
  id: string;
  kind: "修改场次" | "流转状态";
  payload: any;
  reason: string;
  winner?: Role;
  winnerAt?: string;
  time: string;
  retries: number;
}
