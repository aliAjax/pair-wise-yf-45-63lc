import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useScheduleStore } from "../schedule";

// ---- mock localStorage ----
const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
});
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
  key: (i: number) => [...storage.keys()][i] ?? null,
  length: storage.size
});
vi.stubGlobal("navigator", { onLine: true });

function freshStore(role: "制片" | "导演" | "演员统筹" | "场记" = "制片") {
  setActivePinia(createPinia());
  const store = useScheduleStore();
  store.role = role;
  return store;
}

describe("确认通告与快照幂等", () => {
  it("确认通告按当前场次/演员/场地存快照", () => {
    const store = freshStore();
    const result = store.confirmCallSheet();
    expect(result.ok).toBe(true);
    expect(store.versions.length).toBe(1);
    expect(store.versions[0].confirmedBy).toBe("制片");
    expect(store.currentSnapshotId).toBe(store.versions[0].id);
  });

  it("同一份快照重复提交不会多出一版", () => {
    const store = freshStore();
    const first = store.confirmCallSheet();
    const second = store.confirmCallSheet();
    expect(second.ok).toBe(true);
    expect(store.versions.length).toBe(1);
    expect(second.snapshot?.id).toBe(first.snapshot?.id);
    expect(second.firstConfirmedBy).toBe("制片");
  });

  it("场次内容变化后再确认会生成新快照", () => {
    const store = freshStore();
    store.confirmCallSheet();
    expect(store.versions.length).toBe(1);
    store.requestEditScene("s1", { day: "2026-10-10" }, store.scenes[0].version);
    store.confirmCallSheet();
    expect(store.versions.length).toBe(2);
  });

  it("只有制片和导演能确认通告", () => {
    const store = freshStore("场记");
    const result = store.confirmCallSheet();
    expect(result.ok).toBe(false);
    expect(store.versions.length).toBe(0);
  });
});

describe("冲突豁免与快照联动", () => {
  it("未确认通告时不能豁免", () => {
    const store = freshStore();
    const conflictId = store.conflicts[0].id;
    const result = store.exemptConflict(conflictId);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("确认通告");
  });

  it("豁免只对当前确认快照负责", () => {
    const store = freshStore();
    store.confirmCallSheet();
    const conflictId = store.conflicts[0].id;
    const before = store.conflicts.length;
    const result = store.exemptConflict(conflictId);
    expect(result.ok).toBe(true);
    expect(store.conflicts.length).toBe(before - 1);
    expect(store.activeExemptions.length).toBe(1);
  });

  it("场次时间一变，豁免立即作废，冲突退回待处理", () => {
    const store = freshStore();
    store.confirmCallSheet();
    const conflictId = store.conflicts.find((c) => c.id === "s1:s2:talent")!.id;
    store.exemptConflict(conflictId);
    expect(store.conflicts.find((c) => c.id === conflictId)).toBeUndefined();

    // 改变 s1 的时间
    store.requestEditScene("s1", { start: "09:00", end: "12:00" }, store.scenes.find((s) => s.id === "s1")!.version);

    const exemption = store.exemptions[0];
    expect(exemption.status).toBe("已作废");
    expect(exemption.voidReason).toBe("场次变动");
    expect(store.conflicts.find((c) => c.id === conflictId)).toBeDefined();
  });

  it("演员或场地变化同样让豁免作废", () => {
    const store = freshStore();
    store.confirmCallSheet();
    const conflictId = "s1:s2:location";
    store.exemptConflict(conflictId);
    expect(store.activeExemptions.length).toBe(1);

    store.requestEditScene("s1", { locationId: "l2" }, store.scenes.find((s) => s.id === "s1")!.version);
    expect(store.exemptions[0].status).toBe("已作废");
  });

  it("恢复旧版本带不回作废的豁免", () => {
    const store = freshStore();
    store.confirmCallSheet();
    const snapshotId = store.currentSnapshotId!;
    const conflictId = "s1:s2:talent";
    store.exemptConflict(conflictId);

    // 场次变动 → 豁免作废
    store.requestEditScene("s1", { day: "2026-10-10" }, store.scenes.find((s) => s.id === "s1")!.version);
    expect(store.exemptions[0].status).toBe("已作废");

    // 恢复到确认快照（场次内容回到豁免时的状态）
    store.restore(snapshotId);
    expect(store.currentSnapshotId).toBe(snapshotId);

    // 豁免仍然作废，不会被带回
    expect(store.exemptions[0].status).toBe("已作废");
    expect(store.conflicts.find((c) => c.id === conflictId)).toBeDefined();
  });

  it("只有制片和导演能豁免", () => {
    const store = freshStore("演员统筹");
    store.confirmCallSheet();
    const result = store.exemptConflict(store.conflicts[0].id);
    expect(result.ok).toBe(false);
    expect(store.activeExemptions.length).toBe(0);
  });
});

describe("场记改动进待审", () => {
  it("场记新增场次进入待审，不直接生效", () => {
    const store = freshStore("场记");
    const before = store.scenes.length;
    const result = store.requestAddScene({ code: "C-999", title: "待审场次", day: "2026-10-08", start: "14:00", end: "15:00", talentIds: [], locationId: "l1", equipmentIds: [] });
    expect(result.pending).toBe(true);
    expect(store.scenes.length).toBe(before);
    expect(store.pendingCount).toBe(1);
  });

  it("制片审批后待审场次生效", () => {
    const store = freshStore("场记");
    store.requestAddScene({ code: "C-999", title: "待审场次", day: "2026-10-08", start: "14:00", end: "15:00", talentIds: [], locationId: "l1", equipmentIds: [] });
    const pending = store.pendingChanges[0];
    store.role = "制片";
    const result = store.approvePending(pending.id);
    expect(result.ok).toBe(true);
    expect(store.scenes.find((s) => s.code === "C-999")).toBeDefined();
    expect(store.pendingCount).toBe(0);
  });

  it("导演可以驳回待审", () => {
    const store = freshStore("场记");
    store.requestAddScene({ code: "C-998", title: "驳回场次", day: "2026-10-08", start: "16:00", end: "17:00", talentIds: [], locationId: "l1", equipmentIds: [] });
    const pending = store.pendingChanges[0];
    store.role = "导演";
    store.rejectPending(pending.id, "档期不合");
    expect(store.pendingChanges[0].status).toBe("已驳回");
    expect(store.scenes.find((s) => s.code === "C-998")).toBeUndefined();
  });
});

describe("先到者胜与重试", () => {
  it("两位负责人几乎同时保存同一场，先到者胜，后者看到是谁先确认", () => {
    const store = freshStore("制片");
    const scene = store.scenes.find((s) => s.id === "s1")!;
    const base = scene.version;

    // 制片先保存
    const first = store.requestEditScene("s1", { title: "制片改的" }, base);
    expect(first.ok).toBe(true);

    // 导演后保存（baseVersion 已过期）
    store.role = "导演";
    const second = store.requestEditScene("s1", { title: "导演改的" }, base);
    expect(second.ok).toBe(false);
    expect(second.winner).toBe("制片");
    expect(store.failedSubmissions.length).toBe(1);
    expect(store.failedSubmissions[0].winner).toBe("制片");
  });

  it("提交失败后能接着重试", () => {
    const store = freshStore("制片");
    const scene = store.scenes.find((s) => s.id === "s1")!;
    const base = scene.version;

    store.requestEditScene("s1", { title: "制片改的" }, base);
    store.role = "导演";
    store.requestEditScene("s1", { title: "导演改的" }, base);
    expect(store.failedSubmissions.length).toBe(1);

    const failed = store.failedSubmissions[0];
    const retry = store.retryFailed(failed.id);
    // 原 baseVersion 仍过期，重试失败但能继续
    expect(retry.ok).toBe(false);
    expect(store.failedSubmissions.length).toBe(1);
    expect(store.failedSubmissions[0].retries).toBe(1);
  });

  it("重试成功后失败记录移除", () => {
    const store = freshStore("制片");
    const scene = store.scenes.find((s) => s.id === "s1")!;
    const base = scene.version;

    store.requestEditScene("s1", { title: "制片改的" }, base);
    store.role = "导演";
    store.requestEditScene("s1", { title: "导演改的" }, base);
    const failed = store.failedSubmissions[0];

    // 忽略先到者版本后，以最新版本重试可成功
    store.dismissFailed(failed.id);
    expect(store.failedSubmissions.length).toBe(0);
    const latest = store.scenes.find((s) => s.id === "s1")!;
    const retry = store.requestEditScene("s1", { title: "导演改的" }, latest.version);
    expect(retry.ok).toBe(true);
  });
});
