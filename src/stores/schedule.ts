import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import dayjs from "dayjs";
import type {
  ChangeRequest,
  Conflict,
  Equipment,
  Exemption,
  HistoryEntry,
  Location,
  OfflineDraft,
  PendingSubmission,
  Role,
  Scene,
  SceneStatus,
  ScheduleVersion,
  Talent
} from "../types";
import { scheduleFailure, submitConfirmation, fetchBaseline, type ConfirmResult } from "../services/server";
import { cloneDeep } from "../utils/clone";

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
  { id: "s1", code: "A-012", title: "码头交接", day: "2026-10-08", start: "08:00", end: "11:30", talentIds: ["t1", "t3"], locationId: "l1", equipmentIds: ["e1", "e3"], status: "已确认", locked: false, revision: 0 },
  { id: "s2", code: "A-013", title: "厂房追逐", day: "2026-10-08", start: "10:30", end: "13:00", talentIds: ["t1", "t2"], locationId: "l1", equipmentIds: ["e2", "e4"], status: "草稿", locked: false, revision: 0 },
  { id: "s3", code: "B-021", title: "候车厅告别", day: "2026-10-09", start: "15:00", end: "18:30", talentIds: ["t2", "t3"], locationId: "l3", equipmentIds: ["e1"], status: "草稿", locked: false, revision: 0 }
];

type PersistShape = {
  scenes: Scene[];
  history: HistoryEntry[];
  versions: ScheduleVersion[];
  exemptions: Exemption[];
  changeRequests: ChangeRequest[];
  pending: PendingSubmission | null;
};

function readStore(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw) as Partial<PersistShape>;
      return {
        scenes: (data.scenes ?? seedScenes).map((scene) => ({ ...scene, revision: scene.revision ?? 0 })),
        history: data.history ?? [],
        versions: data.versions ?? [],
        exemptions: data.exemptions ?? [],
        changeRequests: data.changeRequests ?? [],
        pending: data.pending ?? null
      };
    }
  } catch {
    /* 落库损坏时回到种子数据 */
  }
  return { scenes: cloneDeep(seedScenes), history: [], versions: [], exemptions: [], changeRequests: [], pending: null };
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

/** 豁免锁定的要素：时间（拍摄日/起止）、演员、场地 */
function fingerprint(scene: Scene) {
  return JSON.stringify({
    day: scene.day,
    start: scene.start,
    end: scene.end,
    talentIds: [...scene.talentIds].sort(),
    locationId: scene.locationId
  });
}

type ScenePatch = Partial<Pick<Scene, "day" | "start" | "end" | "talentIds" | "locationId">>;

function changedFieldLabels(patch: ScenePatch) {
  const labels: string[] = [];
  if (patch.day !== undefined || patch.start !== undefined || patch.end !== undefined) labels.push("时间");
  if (patch.talentIds !== undefined) labels.push("演员");
  if (patch.locationId !== undefined) labels.push("场地");
  return labels;
}

export const useScheduleStore = defineStore("schedule", () => {
  const initial = readStore();
  const scenes = ref<Scene[]>(initial.scenes);
  const history = ref<HistoryEntry[]>(initial.history);
  const versions = ref<ScheduleVersion[]>(initial.versions);
  const exemptions = ref<Exemption[]>(initial.exemptions);
  const changeRequests = ref<ChangeRequest[]>(initial.changeRequests);
  const pending = ref<PendingSubmission | null>(initial.pending);
  const role = ref<Role>("制片");
  const online = ref(navigator.onLine);
  const draft = ref<OfflineDraft | null>(null);

  const submitting = ref(false);
  const submitError = ref("");
  /** 并发确认落败时，服务端指出的先确认者 */
  const staleResult = ref<{ name: string; conflicts: { sceneCode: string; winner: Role; winnerAt: string }[] } | null>(null);

  const isLead = computed(() => role.value === "制片" || role.value === "导演");
  const latestVersion = computed(() => versions.value[0] ?? null);
  const pendingReviews = computed(() => changeRequests.value.filter((item) => item.status === "待审"));

  const talentNames = (ids: string[]) => ids.map((id) => talents.find((item) => item.id === id)?.name ?? id);
  const locationName = (id: string) => locations.find((item) => item.id === id)?.name ?? id;
  const equipmentNames = (ids: string[]) => ids.map((id) => equipment.find((item) => item.id === id)?.name ?? id);

  /**
   * 豁免只认确认快照：快照之后要素没变，豁免才仍然有效。
   * 一旦状态置为“已作废”，恢复任何旧版本都不会让它复活。
   */
  const activeExemptionKeys = computed(() => {
    const set = new Set<string>();
    for (const item of exemptions.value) {
      if (item.status !== "有效") continue;
      const intact = item.sceneIds.every((sid) => {
        const scene = scenes.value.find((s) => s.id === sid);
        return scene && item.fingerprints[sid] === fingerprint(scene);
      });
      if (intact) set.add(`${item.sceneIds[0]}:${item.sceneIds[1]}:${item.type}`);
    }
    return set;
  });

  const voidedExemptions = computed(() => exemptions.value.filter((item) => item.status === "已作废"));

  const conflicts = computed<Conflict[]>(() => {
    const result: Conflict[] = [];
    for (let i = 0; i < scenes.value.length; i += 1) {
      for (let j = i + 1; j < scenes.value.length; j += 1) {
        const a = scenes.value[i];
        const b = scenes.value[j];
        if (!overlaps(a, b)) continue;
        const pair = `${a.id}:${b.id}`;
        const keep = (type: Conflict["type"]) => !activeExemptionKeys.value.has(`${pair}:${type}`);
        if (shared(a.talentIds, b.talentIds) && keep("演员档期")) result.push({ id: `${pair}:talent`, type: "演员档期", sceneIds: [a.id, b.id], message: `${talentNames(a.talentIds.filter((item) => b.talentIds.includes(item))).join("、")} 在两场戏中档期重叠`, severity: "高" });
        if (a.locationId === b.locationId && keep("场地占用")) result.push({ id: `${pair}:location`, type: "场地占用", sceneIds: [a.id, b.id], message: `${locationName(a.locationId)} 被同时占用`, severity: "高" });
        if (shared(a.equipmentIds, b.equipmentIds) && keep("器材借用")) result.push({ id: `${pair}:equipment`, type: "器材借用", sceneIds: [a.id, b.id], message: `${equipmentNames(a.equipmentIds.filter((item) => b.equipmentIds.includes(item))).join("、")} 发生借用重叠`, severity: "中" });
        if (a.locationId !== b.locationId && minutes(b.start) - minutes(a.end) < 30 && keep("转场时间")) result.push({ id: `${pair}:transfer`, type: "转场时间", sceneIds: [a.id, b.id], message: "两个场地之间转场时间不足30分钟", severity: "中" });
      }
    }
    return result;
  });

  const sortedScenes = computed(() => [...scenes.value].sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`)));

  function log(action: string, detail: string) {
    history.value.unshift({ id: crypto.randomUUID(), action, detail, time: new Date().toISOString() });
    history.value = history.value.slice(0, 120);
  }

  function persist() {
    const data: PersistShape = {
      scenes: scenes.value,
      history: history.value,
      versions: versions.value,
      exemptions: exemptions.value,
      changeRequests: changeRequests.value,
      pending: pending.value
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  watch([scenes, history, versions, exemptions, changeRequests, pending], persist, { deep: true });

  /** 要素一变，相关豁免立即作废，冲突退回待处理；作废不可逆 */
  function revalidateExemptions(reason: string) {
    for (const item of exemptions.value) {
      if (item.status !== "有效") continue;
      const changed = item.sceneIds.some((sid) => {
        const scene = scenes.value.find((s) => s.id === sid);
        return !scene || item.fingerprints[sid] !== fingerprint(scene);
      });
      if (changed) {
        item.status = "已作废";
        item.voidedAt = new Date().toISOString();
        item.voidReason = reason;
        log("豁免作废", `${item.type}（${item.sceneIds.map(sceneCode).join(" ↔ ")}）：${reason}`);
      }
    }
  }

  function sceneCode(id: string) {
    return scenes.value.find((item) => item.id === id)?.code ?? id;
  }

  function addScene(input: Omit<Scene, "id" | "status" | "locked" | "revision">) {
    scenes.value.push({ ...input, id: crypto.randomUUID(), status: "草稿", locked: false, revision: 0 });
    log("新增场次", `${input.code} ${input.title}`);
  }

  function updateStatus(id: string, status: SceneStatus) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene || scene.locked) return;
    scene.status = status;
    log("流转状态", `${scene.code} → ${status}`);
  }

  function toggleLock(id: string) {
    const scene = scenes.value.find((item) => item.id === id);
    if (!scene) return;
    scene.locked = !scene.locked;
    log(scene.locked ? "锁定场次" : "解锁场次", scene.code);
  }

  function moveScene(from: number, to: number) {
    if (from === to || to < 0 || to >= scenes.value.length) return;
    const [item] = scenes.value.splice(from, 1);
    scenes.value.splice(to, 0, item);
    log("调整顺序", `${item.code} 移至第 ${to + 1} 位`);
  }

  /**
   * 场次要素改动：负责人直接落盘并抬 revision；场记等进待审。
   * 任一条路径只要改动了时间/演员/场地，相关豁免立即失效。
   */
  function requestSceneChange(sceneId: string, patch: ScenePatch, reason?: string): string {
    const scene = scenes.value.find((item) => item.id === sceneId);
    if (!scene) return "";
    const labels = changedFieldLabels(patch);
    if (!labels.length) return "";
    if (isLead.value) {
      Object.assign(scene, patch);
      scene.revision += 1;
      revalidateExemptions(`${scene.code} 的${labels.join("、")}已调整`);
      log("调整场次", `${scene.code} 的${labels.join("、")}已调整`);
      return "";
    }
    const request: ChangeRequest = {
      id: crypto.randomUUID(),
      sceneId,
      sceneCode: scene.code,
      patch: cloneDeep(patch),
      reason,
      submittedBy: role.value,
      submittedAt: new Date().toISOString(),
      status: "待审"
    };
    changeRequests.value.unshift(request);
    log("提交改动待审", `${scene.code} 申请调整${labels.join("、")}（${role.value}）`);
    return request.id;
  }

  function reviewChange(requestId: string, approve: boolean) {
    const request = changeRequests.value.find((item) => item.id === requestId);
    if (!request || request.status !== "待审" || !isLead.value) return;
    request.status = approve ? "已通过" : "已驳回";
    request.reviewedBy = role.value;
    request.reviewedAt = new Date().toISOString();
    if (approve) {
      const scene = scenes.value.find((item) => item.id === request.sceneId);
      if (scene) {
        Object.assign(scene, request.patch);
        scene.revision += 1;
        const labels = changedFieldLabels(request.patch);
        revalidateExemptions(`${scene.code} 的${labels.join("、")}按${request.submittedBy}申请调整`);
      }
      log("审批通过", `${request.sceneCode} 的${changedFieldLabels(request.patch).join("、")}改动（${request.submittedBy}申请，${role.value}批准）`);
    } else {
      log("审批驳回", `${request.sceneCode} 的改动申请（${request.submittedBy}提交，${role.value}驳回）`);
    }
  }

  /**
   * 确认通告：按当时的场次/演员/场地打包快照提交。
   * - 只有制片、导演可确认
   * - 同 requestToken 重试不产生新版本（幂等）
   * - 两人同时确认同一场时，服务端按 revision 只放行先到者
   * - 网络失败保留挂起包，可用原令牌重试
   */
  async function confirmSchedule(name?: string): Promise<ConfirmResult | { ok: false; code: "BUSY" | "FORBIDDEN" }> {
    if (!isLead.value) return { ok: false, code: "FORBIDDEN" };
    if (submitting.value) return { ok: false, code: "BUSY" };
    submitError.value = "";
    staleResult.value = null;

    // 已有挂起包（上次失败）：沿用同一令牌重试，绝不另打包
    if (!pending.value) {
      pending.value = {
        token: crypto.randomUUID(),
        name: name ?? `确认版本 ${versions.value.length + 1}`,
        scenes: cloneDeep(scenes.value),
        confirmedBy: role.value,
        createdAt: new Date().toISOString()
      };
    }

    submitting.value = true;
    try {
      const result = await submitConfirmation({
        name: pending.value.name,
        time: pending.value.createdAt,
        scenes: cloneDeep(pending.value.scenes),
        confirmedBy: pending.value.confirmedBy,
        requestToken: pending.value.token
      });

      if (!result.ok) {
        staleResult.value = { name: pending.value.name, conflicts: result.conflicts };
        log("确认被拒", `${pending.value.name}：${result.conflicts.map((c) => `${c.sceneCode} 已由${c.winner}先确认`).join("；")}`);
        return result;
      }

      applyAcceptedVersion(result.version, result.duplicated);
      return result;
    } catch (error) {
      // 提交失败：挂起包保留，原令牌可重试
      submitError.value = error instanceof Error ? error.message : "提交失败，请重试";
      log("提交失败", `${pending.value.name}：${submitError.value}（可重试）`);
      return { ok: false, code: "BUSY" as const };
    } finally {
      submitting.value = false;
    }
  }

  function applyAcceptedVersion(version: ScheduleVersion, duplicated: boolean) {
    const token = pending.value?.token ?? version.requestToken;
    // 服务端返回的场次即权威基线：revision / 确认人由服务端盖戳
    for (const accepted of version.scenes) {
      const current = scenes.value.find((item) => item.id === accepted.id);
      if (current) Object.assign(current, cloneDeep(accepted));
    }
    // 幂等：同令牌只保留一版
    if (!versions.value.some((item) => item.requestToken === token)) {
      versions.value.unshift(version);
      versions.value = versions.value.slice(0, 12);
    }
    log(duplicated ? "确认回执补全" : "确认通告", `${version.name}（${version.confirmedBy}确认，${version.scenes.length} 场）${duplicated ? "，重复提交未产生新版本" : ""}`);
    pending.value = null;
    submitError.value = "";
  }

  /** 并发落败后放弃陈旧挂起包，回到最新通告重新确认 */
  function discardPending() {
    if (!pending.value) return;
    log("放弃陈旧提交", pending.value.name);
    pending.value = null;
    staleResult.value = null;
    submitError.value = "";
  }

  /** 拉取服务端权威基线（另一位负责人先确认后的最新通告），随后重新校验豁免 */
  function refreshFromServer() {
    const baseline = fetchBaseline();
    if (!baseline.length) return false;
    for (const accepted of baseline) {
      const current = scenes.value.find((item) => item.id === accepted.id);
      if (current) Object.assign(current, cloneDeep(accepted));
    }
    revalidateExemptions("同步了另一位负责人已确认的最新通告");
    log("刷新通告", `同步到 ${baseline.length} 场最新确认基线`);
    return true;
  }

  function scheduleOneFailure() {
    scheduleFailure();
  }

  /**
   * 豁免冲突：只认最近一次确认快照，记录当时两场的要素指纹。
   * 没有确认过快照不允许豁免——豁免必须锚定一份算数的版本。
   */
  function exempt(conflict: Conflict): string {
    if (!isLead.value) return "只有制片和导演可以豁免冲突";
    const snapshot = latestVersion.value;
    if (!snapshot) return "请先确认通告生成快照，豁免只认确认时的快照";
    const fingerprints: Record<string, string> = {};
    for (const sid of conflict.sceneIds) {
      const scene = scenes.value.find((item) => item.id === sid);
      if (!scene) return "冲突涉及的场次不存在";
      fingerprints[sid] = fingerprint(scene);
    }
    exemptions.value.unshift({
      id: crypto.randomUUID(),
      type: conflict.type,
      versionId: snapshot.id,
      versionName: snapshot.name,
      sceneIds: conflict.sceneIds,
      fingerprints,
      grantedBy: role.value,
      grantedAt: new Date().toISOString(),
      status: "有效"
    });
    log("豁免冲突", `${conflict.type}：${conflict.sceneIds.map(sceneCode).join(" ↔ ")}（锚定${snapshot.name}，${role.value}批准）`);
    return "";
  }

  /** 恢复旧版本：通告内容回到当时，但已作废的豁免不随之恢复 */
  function restore(id: string) {
    const version = versions.value.find((item) => item.id === id);
    if (!version || pending.value) return;
    scenes.value = cloneDeep(version.scenes);
    revalidateExemptions(`已恢复旧版本「${version.name}」，作废的豁免不恢复`);
    log("恢复版本", `${version.name}（作废豁免不恢复）`);
  }

  function saveDraft() {
    draft.value = { scenes: cloneDeep(scenes.value), savedAt: new Date().toISOString() };
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
    scenes.value = cloneDeep(draft.value.scenes);
    revalidateExemptions("同步了离线草稿");
    log("同步离线草稿", `同步 ${draft.value.scenes.length} 个场次`);
    draft.value = null;
    localStorage.removeItem(DRAFT_KEY);
  }

  function setOnline(value: boolean) {
    online.value = value;
  }

  return {
    scenes, sortedScenes, conflicts, history, versions, role, exemptions, voidedExemptions,
    online, draft, talents, locations, equipment, changeRequests, pendingReviews, pending,
    submitting, submitError, staleResult, isLead, latestVersion,
    talentNames, equipmentNames, locationName,
    addScene, updateStatus, toggleLock, moveScene,
    requestSceneChange, reviewChange,
    confirmSchedule, discardPending, refreshFromServer, scheduleOneFailure,
    exempt, restore, saveDraft, loadDraft, syncDraft, setOnline
  };
});
