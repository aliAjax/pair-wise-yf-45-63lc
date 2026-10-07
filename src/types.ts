export type Role = "制片" | "导演" | "演员统筹" | "场记";
export type SceneStatus = "草稿" | "已确认" | "拍摄中" | "已完成";
export type ConflictType = "演员档期" | "场地占用" | "器材借用" | "转场时间";

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
  /** 乐观锁版本号：每次负责人确认或落盘改动后递增 */
  revision: number;
  /** 最后确认本场的负责人 */
  confirmedBy?: Role;
  confirmedAt?: string;
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

/** 场次要素指纹：时间（拍摄日/起止）、演员、场地，任一变化即失效 */
export interface Exemption {
  id: string;
  type: ConflictType;
  versionId: string;
  versionName: string;
  sceneIds: string[];
  fingerprints: Record<string, string>;
  grantedBy: Role;
  grantedAt: string;
  status: "有效" | "已作废";
  voidedAt?: string;
  voidReason?: string;
}

/** 通告确认快照：只在负责人确认通告时产生 */
export interface ScheduleVersion {
  id: string;
  name: string;
  time: string;
  scenes: Scene[];
  confirmedBy: Role;
  /** 提交令牌：同一份快照重复提交不会多出一版 */
  requestToken: string;
}

/** 场记等非负责人提交的场次改动，负责人审批后才落盘 */
export interface ChangeRequest {
  id: string;
  sceneId: string;
  sceneCode: string;
  patch: Partial<Pick<Scene, "day" | "start" | "end" | "talentIds" | "locationId">>;
  reason?: string;
  submittedBy: Role;
  submittedAt: string;
  status: "待审" | "已通过" | "已驳回";
  reviewedBy?: Role;
  reviewedAt?: string;
}

/** 已打包但服务端尚未确认收到的提交，失败后按同一令牌重试 */
export interface PendingSubmission {
  token: string;
  name: string;
  scenes: Scene[];
  confirmedBy: Role;
  createdAt: string;
}

export interface OfflineDraft {
  scenes: Scene[];
  savedAt: string;
}
