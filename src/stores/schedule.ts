import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import dayjs from "dayjs";
import type { Conflict, Equipment, Exemption, FailedSubmission, HistoryEntry, Location, OfflineDraft, PendingChange, Role, Scene, SceneStatus, Talent, Version } from "../types";

const STORAGE_KEY = "pair-wise-yf-45/schedule-v2";
const DRAFT_KEY = "pair-wise-yf-45/offline-draft";

const talents: Talent[] = [
  { id: "t1", name: "林川", role: "男主" },
  { id: "t2", name: "周禾", role: "女主" },
  { id: "t3", name: "顾言", role: "配角" },
  { id: "t4", name: "孙宁", role: "群演领队" }
];

const locations: Location[] = [
  { id: "l1", name: "老码头" },
  { id: "l2", name: "玻璃厂房" },
  { id: "l3", name: "南站候车厅" }
];

const equipment: Equipment[] = [
  { id: "e1", name: "ARRI A机" },
  { id: "e2", name: "移动伸缩炮" },
  { id: "e3", name: "LED灯组" },
  { id: "e4", name: "跟拍车" }
];

const seedScenes: Scene[] = [
  { id: "s1", code: "A-012", title: "码头交接", day: "2026-10-08", start: "08:00", end: "11:30", talentIds: ["t1", "t3"], locationId: "l1", equipmentIds: ["e1", "e3"], status: "已确认", locked: false, version: 1 },
  { id: "s2", code: "A-013", title: "厂房追逐", day: "2026-10-08", start: "10:30", end: "13:00", talentIds: ["t1", "t2"], locationId: "l1", equipmentIds: ["e2", "e4"], status: "草稿", locked: false, version: 1 },
  { id: "s3", code: "B-021", title: "候车厅告别", day: "2026-10-09", start: "15:00", end: "18:30", talentIds: ["t2", "t3"], locationId: "l3", equipmentIds: ["e1"], status: "草稿", locked: false, version: 1 }
];

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return (parsed[key] as T) ?? fallback;
  } catch {
    return fallback;
  }
}

/** 轻量确定性哈希（FNV-1a），用于内容比对与幂等 */
function hashString(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 深拷贝场次数据：reactive 代理与纯数据都安全 */
function cloneScenes(list: Scene[]): Scene[] {
  return JSON.parse(JSON.stringify(list)) as Scene[];
}

function minutes(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function overlaps(a: Scene, b: Scene) {
  return a.day === b.day && minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end);
}

function shared(a: string[], b: string[]) {
  return a.some((value) => b.includes(value));
}

export const useScheduleStore = defineStore("schedule", () => {
  const scenes = ref<Scene[]>(read<Scene[]>("scenes", cloneScenes(seedScenes)));
  const history = ref<HistoryEntry[]>(read<HistoryEntry[]>("history", []));
  const versions = ref<Version[]>(read<Version[]>("versions", []));
  const exemptions = ref<Exemption[]>(read<Exemption[]>("exemptions", []));
  const pendingChanges = ref<PendingChange[]>(read<PendingChange[]>("pendingChanges", []));
  const failedSubmissions = ref<FailedSubmission[]>(read<FailedSubmission[]>("failedSubmissions", []));
  const currentSnapshotId = ref<string | null>(read<string | null>("currentSnapshotId", null));
  const role = ref<Role>("制片");
  const online = ref(navigator.onLine);
  const draft = ref<OfflineDraft | null>(null);

  const talentNames = (ids: string[]) => ids.map((id) => talents.find((item) => item.id === id)?.name ?? id);
  const locationName = (id: string) => locations.find((item) => item.id === id)?.name ?? id;
  const equipmentNames = (ids: string[]) => ids.map((id) => equipment.find((item) => item.id === id)?.name ?? id);

  /** 只有制片和导演能确认、豁免、直接改动场次 */
  const canConfirm = computed(() => role.value === "制片" || role.value === "导演");
  const canEditDirectly = computed(() => canConfirm.value);

  const currentSnapshot = computed(() => versions.value.find((item) => item.id === currentSnapshotId.value) ?? null);

  /** 涉及场次的 时间/演员/场地 指纹；任一变化都会让豁免作废 */
  function sceneFingerprint(sceneIds: string[]): string {
    const data = sceneIds.map((id) => {
      const scene = scenes.value.find((item) => item.id === id);
      if (!scene) return null;
      return { id: scene.id, day: scene.day, start: scene.start, end: scene.end, talentIds: [...scene.talentIds].sort(), locationId: scene.locationId };
    }).filter(Boolean);
    return hashString(JSON.stringify(data));
  }

  /** 整份通告内容哈希，用于确认快照幂等 */
  function scenesContentHash(list: Scene[]): string {
    const data = list.map((scene) => ({
      code: scene.code, title: scene.title, day: scene.day, start: scene.start, end: scene.end,
      talentIds: [...scene.talentIds].sort(), locationId: scene.locationId,
      equipmentIds: [...scene.equipmentIds].sort(), status: scene.status, locked: scene.locked
    }));
    return hashString(JSON.stringify(data));
  }

  function log(action: string, detail: string) {
    history.value.unshift({ id: crypto.randomUUID(), action, detail, time: new Date().toISOString() });
    history.value = history.value.slice(0, 80);
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      scenes: scenes.value, history: history.value, versions: versions.value,
      exemptions: exemptions.value, pendingChanges: pendingChanges.value,
      failedSubmissions: failedSubmissions.value, currentSnapshotId: currentSnapshotId.value
    }));
  }

  watch([scenes, history, versions, exemptions, pendingChanges, failedSubmissions, currentSnapshotId], persist, { deep: true });

  /** 豁免是否仍有效：状态有效 + 属于当前确认快照 + 涉及场次指纹未变 */
  function isExemptionActive(exemption: Exemption): boolean {
    return exemption.status === "有效"
      && exemption.snapshotId === currentSnapshotId.value
      && sceneFingerprint(exemption.sceneIds) === exemption.fingerprint;
  }

  const conflicts = computed<Conflict[]>(() => {
    const result: Conflict[] = [];
    for (let i = 0; i < scenes.value.length; i += 1) {
      for (let j = i + 1; j < scenes.value.length; j += 1) {
        const a = scenes.value[i];
        const b = scenes.value[j];
        if (!overlaps(a, b)) continue;
        const baseId = `${a.id}:${b.id}`;
        const candidates: Conflict[] = [];
        if (shared(a.talentIds, b.talentIds)) candidates.push({ id: `${baseId}:talent`, type: "演员档期", sceneIds: [a.id, b.id], message: `${talentNames(a.talentIds.filter((item) => b.talentIds.includes(item))).join("、")} 在两场戏中档期重叠`, severity: "高" });
        if (a.locationId === b.locationId) candidates.push({ id: `${baseId}:location`, type: "场地占用", sceneIds: [a.id, b.id], message: `${locationName(a.locationId)} 被同时占用`, severity: "高" });
        if (shared(a.equipmentIds, b.equipmentIds)) candidates.push({ id: `${baseId}:equipment`, type: "器材借用", sceneIds: [a.id, b.id], message: `${equipmentNames(a.equipmentIds.filter((item) => b.equipmentIds.includes(item))).join("、")} 发生借用重叠`, severity: "中" });
        if (a.locationId !== b.locationId && minutes(b.start) - minutes(a.end) < 30) candidates.push({ id: `${baseId}:transfer`, type: "转场时间", sceneIds: [a.id, b.id], message: "两个场地之间转场时间不足30分钟", severity: "中" });
        for (const conflict of candidates) {
          const covered = exemptions.value.some((exemption) => exemption.conflictId === conflict.id && isExemptionActive(exemption));
          if (!covered) result.push(conflict);
        }
      }
    }
    return result;
  });

  const activeExemptions = computed(() => exemptions.value.filter((item) => item.status === "有效"));
  const voidedExemptions = computed(() => exemptions.value.filter((item) => item.status === "已作废"));
  const pendingCount = computed(() => pendingChanges.value.filter((item) => item.status === "待审").length);
  const failedCount = computed(() => failedSubmissions.value.length);

  const sortedScenes = computed(() => [...scenes.value].sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`)));

  /** 场次一变，所有涉及该场且仍有效的豁免立即作废，冲突退回待处理 */
  function voidStaleExemptions(reason: string) {
    const now = new Date().toISOString();
    for (const exemption of exemptions.value) {
      if (exemption.status !== "有效") continue;
      if (sceneFingerprint(exemption.sceneIds) !== exemption.fingerprint) {
        exemption.status = "已作废";
        exemption.voidedAt = now;
        exemption.voidReason = reason;
        log("豁免作废", `${exemption.conflictId} · ${reason}`);
      }
    }
  }

  /** 确认通告：按当前场次/演员/场地存快照；内容未变则沿用已有快照，不重复出一版 */
  function confirmCallSheet(): { ok: boolean; reason?: string; snapshot?: Version; firstConfirmedBy?: Role } {
    if (!canConfirm.value) return { ok: false, reason: "只有制片和导演能确认通告" };
    const hash = scenesContentHash(scenes.value);
    const existing = versions.value.find((item) => item.confirmedBy && item.contentHash === hash);
    if (existing) {
      currentSnapshotId.value = existing.id;
      log("确认通告", `内容未变动，沿用 ${existing.confirmedBy} 已确认的快照 ${existing.name}`);
      return { ok: true, snapshot: existing, firstConfirmedBy: existing.confirmedBy };
    }
    const now = new Date().toISOString();
    const snapshot: Version = {
      id: crypto.randomUUID(),
      name: `确认快照 ${dayjs(now).format("MM-DD HH:mm")}`,
      time: now,
      scenes: cloneScenes(scenes.value),
      confirmedBy: role.value,
      contentHash: hash
    };
    versions.value.unshift(snapshot);
    versions.value = versions.value.slice(0, 12);
    currentSnapshotId.value = snapshot.id;
    scenes.value.forEach((scene) => { scene.lastConfirmedBy = role.value; scene.lastConfirmedAt = now; });
    log("确认通告", `${snapshot.name} · ${scenes.value.length} 场 · 由 ${role.value} 确认`);
    return { ok: true, snapshot };
  }

  /** 豁免冲突：只对当前确认快照负责，并记录涉剧场次指纹 */
  function exemptConflict(conflictId: string): { ok: boolean; reason?: string; exemption?: Exemption } {
    if (!canConfirm.value) return { ok: false, reason: "只有制片和导演能豁免冲突" };
    if (!currentSnapshotId.value) return { ok: false, reason: "请先确认通告，再按确认快照豁免" };
    const parts = conflictId.split(":");
    const sceneIds = [parts[0], parts[1]];
    if (sceneIds.some((id) => !scenes.value.some((scene) => scene.id === id))) return { ok: false, reason: "冲突涉及的场次不存在" };
    const already = exemptions.value.some((item) => item.conflictId === conflictId && item.status === "有效");
    if (already) return { ok: false, reason: "该冲突已豁免" };
    const exemption: Exemption = {
      id: crypto.randomUUID(),
      conflictId,
      snapshotId: currentSnapshotId.value,
      fingerprint: sceneFingerprint(sceneIds),
      sceneIds,
      exemptedBy: role.value,
      time: new Date().toISOString(),
      status: "有效"
    };
    exemptions.value.unshift(exemption);
    log("豁免冲突", `${conflictId} · 按快照 ${currentSnapshotId.value.slice(0, 8)} · ${role.value}`);
    return { ok: true, exemption };
  }

  /** 场次保存的底层乐观并发检查：baseVersion 必须等于当前版本，否则先到者胜 */
  function attemptSceneChange(id: string, baseVersion: number, mutate: (scene: Scene) => void): { ok: boolean; reason?: string; winner?: Role; winnerAt?: string } {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene) return { ok: false, reason: "找不到场次" };
    if (scene.version !== baseVersion) {
      return { ok: false, reason: "该场次已被他人先保存", winner: scene.lastConfirmedBy, winnerAt: scene.lastConfirmedAt };
    }
    mutate(scene);
    scene.version += 1;
    scene.lastConfirmedBy = role.value;
    scene.lastConfirmedAt = new Date().toISOString();
    return { ok: true };
  }

  function queueFailed(kind: FailedSubmission["kind"], payload: any, result: { reason?: string; winner?: Role; winnerAt?: string }) {
    failedSubmissions.value.unshift({
      id: crypto.randomUUID(), kind, payload,
      reason: result.reason ?? "保存失败", winner: result.winner, winnerAt: result.winnerAt,
      time: new Date().toISOString(), retries: 0
    });
  }

  /** 新增场次：负责人直接生效；场记/演员统筹的改动进待审 */
  function requestAddScene(input: Omit<Scene, "id" | "status" | "locked" | "version" | "lastConfirmedBy" | "lastConfirmedAt">): { ok: boolean; pending?: boolean; reason?: string } {
    if (!canEditDirectly.value) {
      pendingChanges.value.unshift({
        id: crypto.randomUUID(), type: "新增场次", payload: { input },
        submittedBy: role.value, submittedAt: new Date().toISOString(), status: "待审"
      });
      log("提交待审", `新增场次 ${input.code} ${input.title} · ${role.value}`);
      return { ok: true, pending: true };
    }
    scenes.value.push({ ...input, id: crypto.randomUUID(), status: "草稿", locked: false, version: 1 });
    voidStaleExemptions("新增场次");
    log("新增场次", `${input.code} ${input.title}`);
    return { ok: true };
  }

  /** 修改场次（时间/演员/场地）：负责人走乐观并发保存；其他人进待审 */
  function requestEditScene(id: string, changes: Partial<Pick<Scene, "day" | "start" | "end" | "talentIds" | "locationId" | "equipmentIds" | "code" | "title">>, baseVersion: number): { ok: boolean; pending?: boolean; reason?: string; winner?: Role; winnerAt?: string } {
    if (!canEditDirectly.value) {
      pendingChanges.value.unshift({
        id: crypto.randomUUID(), type: "修改场次", payload: { id, changes, baseVersion },
        submittedBy: role.value, submittedAt: new Date().toISOString(), status: "待审"
      });
      log("提交待审", `修改场次 · ${role.value}`);
      return { ok: true, pending: true };
    }
    const scene = scenes.value.find((item) => item.id === id);
    const result = attemptSceneChange(id, baseVersion, (item) => Object.assign(item, changes));
    if (!result.ok) {
      queueFailed("修改场次", { id, changes, baseVersion }, result);
      return result;
    }
    voidStaleExemptions("场次变动");
    log("修改场次", scene ? `${scene.code} ${scene.title}` : id);
    return result;
  }

  /** 流转状态：同样走乐观并发保存 */
  function requestUpdateStatus(id: string, status: SceneStatus, baseVersion: number): { ok: boolean; pending?: boolean; reason?: string; winner?: Role; winnerAt?: string } {
    if (!canEditDirectly.value) {
      pendingChanges.value.unshift({
        id: crypto.randomUUID(), type: "流转状态", payload: { id, status, baseVersion },
        submittedBy: role.value, submittedAt: new Date().toISOString(), status: "待审"
      });
      log("提交待审", `流转状态 → ${status} · ${role.value}`);
      return { ok: true, pending: true };
    }
    const scene = scenes.value.find((item) => item.id === id);
    if (scene?.locked) return { ok: false, reason: "场次已锁定" };
    const result = attemptSceneChange(id, baseVersion, (item) => { item.status = status; });
    if (!result.ok) {
      queueFailed("流转状态", { id, status, baseVersion }, result);
      return result;
    }
    log("流转状态", `${scene?.code} → ${status}`);
    return result;
  }

  function approvePending(id: string): { ok: boolean; reason?: string } {
    if (!canConfirm.value) return { ok: false, reason: "只有制片和导演能审批" };
    const pending = pendingChanges.value.find((item) => item.id === id);
    if (!pending || pending.status !== "待审") return { ok: false, reason: "待审项不存在或已处理" };
    if (pending.type === "新增场次") {
      const input = pending.payload.input;
      scenes.value.push({ ...input, id: crypto.randomUUID(), status: "草稿", locked: false, version: 1 });
      voidStaleExemptions("新增场次（待审通过）");
    } else if (pending.type === "修改场次") {
      const { id: sceneId, changes } = pending.payload;
      const scene = scenes.value.find((item) => item.id === sceneId);
      if (scene) {
        Object.assign(scene, changes);
        scene.version += 1;
        scene.lastConfirmedBy = role.value;
        scene.lastConfirmedAt = new Date().toISOString();
        voidStaleExemptions("场次变动（待审通过）");
      }
    } else if (pending.type === "流转状态") {
      const { id: sceneId, status } = pending.payload;
      const scene = scenes.value.find((item) => item.id === sceneId);
      if (scene) scene.status = status;
    }
    pending.status = "已通过";
    pending.reviewedBy = role.value;
    pending.reviewedAt = new Date().toISOString();
    log("待审通过", `${pending.type} · ${pending.submittedBy} 提交`);
    return { ok: true };
  }

  function rejectPending(id: string, reason = "不符合当前安排"): { ok: boolean; reason?: string } {
    if (!canConfirm.value) return { ok: false, reason: "只有制片和导演能审批" };
    const pending = pendingChanges.value.find((item) => item.id === id);
    if (!pending || pending.status !== "待审") return { ok: false, reason: "待审项不存在或已处理" };
    pending.status = "已驳回";
    pending.reviewedBy = role.value;
    pending.reviewedAt = new Date().toISOString();
    pending.reason = reason;
    log("待审驳回", `${pending.type} · ${pending.submittedBy} 提交`);
    return { ok: true };
  }

  /** 提交失败后接着重试：仍以原 baseVersion 复检，先到者依旧胜出 */
  function retryFailed(id: string): { ok: boolean; reason?: string; winner?: Role; winnerAt?: string } {
    const failed = failedSubmissions.value.find((item) => item.id === id);
    if (!failed) return { ok: false, reason: "失败记录不存在" };
    failed.retries += 1;
    let result: { ok: boolean; reason?: string; winner?: Role; winnerAt?: string };
    if (failed.kind === "修改场次") {
      const { id: sceneId, changes, baseVersion } = failed.payload;
      result = attemptSceneChange(sceneId, baseVersion, (item) => Object.assign(item, changes));
      if (result.ok) voidStaleExemptions("场次变动");
    } else if (failed.kind === "流转状态") {
      const { id: sceneId, status, baseVersion } = failed.payload;
      result = attemptSceneChange(sceneId, baseVersion, (item) => { item.status = status; });
    } else {
      return { ok: false, reason: "不支持的失败类型" };
    }
    if (result.ok) {
      failedSubmissions.value = failedSubmissions.value.filter((item) => item.id !== id);
      log("重试成功", `${failed.kind} · 第 ${failed.retries} 次`);
    } else {
      failed.reason = result.reason ?? failed.reason;
      failed.winner = result.winner;
      failed.winnerAt = result.winnerAt;
      log("重试仍失败", `${failed.reason} · 第 ${failed.retries} 次`);
    }
    return result;
  }

  function dismissFailed(id: string) {
    failedSubmissions.value = failedSubmissions.value.filter((item) => item.id !== id);
  }

  function toggleLock(id: string) {
    if (!canEditDirectly.value) return;
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene) return;
    scene.locked = !scene.locked;
    log(scene.locked ? "锁定场次" : "解锁场次", scene.code);
  }

  function moveScene(from: number, to: number) {
    if (!canEditDirectly.value) return;
    if (from === to || to < 0 || to >= scenes.value.length) return;
    const [item] = scenes.value.splice(from, 1);
    scenes.value.splice(to, 0, item);
    log("调整顺序", `${item.code} 移至第 ${to + 1} 位`);
  }

  /** 手动保存版本（非确认快照） */
  function snapshot(name = `版本 ${versions.value.length + 1}`) {
    const now = new Date().toISOString();
    versions.value.unshift({ id: crypto.randomUUID(), name, time: now, scenes: cloneScenes(scenes.value), contentHash: scenesContentHash(scenes.value) });
    versions.value = versions.value.slice(0, 12);
    log("保存版本", name);
  }

  /** 恢复旧版本：作废的豁免不会被带回；恢复后按当前场次指纹重新核定豁免 */
  function restore(id: string) {
    const version = versions.value.find((item) => item.id === id);
    if (!version) return;
    scenes.value = cloneScenes(version.scenes);
    currentSnapshotId.value = version.confirmedBy ? version.id : null;
    voidStaleExemptions("恢复版本");
    log("恢复版本", version.name);
  }

  function saveDraft() {
    draft.value = { scenes: cloneScenes(scenes.value), savedAt: new Date().toISOString() };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft.value));
    log("保存离线草稿", dayjs(draft.value.savedAt).format("MM-DD HH:mm"));
  }

  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      draft.value = raw ? JSON.parse(raw) as OfflineDraft : null;
    } catch {
      draft.value = null;
    }
  }

  function syncDraft() {
    if (!draft.value) return;
    scenes.value = cloneScenes(draft.value.scenes);
    currentSnapshotId.value = null;
    voidStaleExemptions("同步离线草稿");
    log("同步离线草稿", `同步 ${draft.value.scenes.length} 个场次`);
    draft.value = null;
    localStorage.removeItem(DRAFT_KEY);
  }

  function setOnline(value: boolean) {
    online.value = value;
  }

  return {
    scenes, sortedScenes, conflicts, history, versions, role, online, draft,
    exemptions, activeExemptions, voidedExemptions, pendingChanges, pendingCount,
    failedSubmissions, failedCount, currentSnapshotId, currentSnapshot,
    canConfirm, canEditDirectly, talents, locations, equipment,
    talentNames, equipmentNames, locationName,
    confirmCallSheet, exemptConflict, requestAddScene, requestEditScene, requestUpdateStatus,
    approvePending, rejectPending, retryFailed, dismissFailed,
    toggleLock, moveScene, snapshot, restore, saveDraft, loadDraft, syncDraft, setOnline
  };
});
