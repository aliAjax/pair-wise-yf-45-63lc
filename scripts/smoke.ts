// 端到端冒烟：在 Node 中跑真实的 Pinia store + 模拟服务端，
// 覆盖 确认快照/豁免失效/恢复不复活/场记待审/并发先到先得/失败重试/幂等。
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { useScheduleStore } from "../src/stores/schedule";
import { resetServer, scheduleFailure } from "../src/services/server";

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { passed += 1; console.log("  ✔", label); }
  else { failed += 1; console.error("  �’", label); }
}
async function section(name, fn) {
  console.log("\n●", name);
  await nextTick(); // 等上一 section 的持久化 watcher 落盘，避免读到半初始化状态
  await fn();
}

function newStore(role = "制片") {
  setActivePinia(createPinia());
  const store = useScheduleStore();
  store.role = role;
  return store;
}

// 初始：s1/s2 在 10-08 时间重叠、共用 l1 与 t1
const s1 = "s1", s2 = "s2";
const talentConflictId = `${s1}:${s2}:talent`;
const locationConflictId = `${s1}:${s2}:location`;

await section("确认通告生成快照", async () => {
  resetServer();
  localStorage.clear();
  const store = newStore("制片");
  assert(store.conflicts.length >= 2, "种子数据存在冲突（演员 + 场地）");

  const r = await store.confirmSchedule("首版通告");
  assert(r.ok === true, "确认成功");
  assert(store.versions.length === 1, "只生成了一份快照");
  assert(store.versions[0].confirmedBy === "制片", "快照记录确认人为制片");
  assert(store.scenes.find((x) => x.id === s1).revision === 1, "服务端在确认场次盖上 revision=1");
  assert(store.pending === null, "成功后无挂起包");
});

await section("同一份快照重复提交不多出版本（幂等）", async () => {
  const store = newStore("制片");
  // 直接复用最近挂起场景：模拟“服务端已收、回执丢失”，再送同一令牌
  const token = store.versions[0].requestToken;
  store.pending = {
    token,
    name: "首版通告",
    scenes: JSON.parse(JSON.stringify(store.scenes)),
    confirmedBy: "制片",
    createdAt: new Date().toISOString()
  };
  const r = await store.confirmSchedule();
  assert(r.ok === true && r.duplicated === true, "同令牌返回幂等回执 duplicated=true");
  assert(store.versions.length === 1, "版本数仍是 1，没有多出一版");
});

await section("提交失败后可重试，且重试仍是同一份", async () => {
  resetServer();
  localStorage.clear();
  const store = newStore("制片");
  scheduleFailure();
  const r1 = await store.confirmSchedule("会失败的确认");
  assert(r1.ok === false, "第一次提交失败");
  assert(store.pending !== null, "失败后挂起包保留");
  assert(store.submitError.includes("失败"), "页面可看到失败原因");
  const tokenBefore = store.pending.token;

  const r2 = await store.confirmSchedule();
  assert(r2.ok === true, "重试成功");
  assert(store.pending === null, "成功后挂起包清除");
  assert(store.versions.length === 1 && store.versions[0].requestToken === tokenBefore, "重试沿用原令牌，只产生一版");
});

await section("豁免只认快照，要素一变即作废，恢复旧版不复活", async () => {
  resetServer();
  localStorage.clear();
  const store = newStore("制片");

  const blocked = store.exempt(store.conflicts[0]);
  assert(!!blocked, "没有确认快照时不能豁免");

  await store.confirmSchedule("含冲突首版");
  const beforeIds = store.conflicts.map((c) => c.id);
  assert(beforeIds.includes(talentConflictId) && beforeIds.includes(locationConflictId), "确认前能看到演员与场地冲突");

  const talentConflict = store.conflicts.find((c) => c.id === talentConflictId);
  assert(store.exempt(talentConflict) === "", "制片可豁免演员冲突");
  assert(!store.conflicts.some((c) => c.id === talentConflictId), "豁免后该冲突退出待处理");
  assert(store.exemptions[0].versionId === store.versions[0].id, "豁免锚定确认快照");

  // 导演把 s2 的演员改成 t4：演员冲突前提消失；改 s2 场地到 l2 -> 场地冲突前提也变化
  store.requestSceneChange(s2, { talentIds: ["t4"], locationId: "l2" });
  const ex = store.exemptions.find((e) => e.type === "演员档期");
  assert(ex.status === "已作废" && ex.voidReason, "被豁免场次的演员/场地变化，豁免立即作废");
  assert(!!ex.voidedAt, "作废带时间戳");

  // 重新构造一个与旧快照相同的冲突（恢复旧版），验证豁免不复活
  store.requestSceneChange(s2, { talentIds: ["t1", "t2"], locationId: "l1" });
  await store.confirmSchedule("改动后新版");
  store.restore(store.versions.find((v) => v.name === "含冲突首版").id);
  const same = store.exemptions.find((e) => e.type === "演员档期");
  assert(same.status === "已作废", "恢复到豁免当时的旧版本，作废豁免仍不复活");
  assert(store.conflicts.some((c) => c.id === talentConflictId), "冲突已退回待处理");
});

await section("只有制片/导演能确认和豁免；场记改动进待审", async () => {
  resetServer();
  localStorage.clear();
  const store = newStore("场记");
  const forbidConfirm = await store.confirmSchedule();
  assert(forbidConfirm.ok === false && forbidConfirm.code === "FORBIDDEN", "场记不能确认通告");
  const forbidExempt = store.exempt(store.conflicts[0]);
  assert(!!forbidExempt, "场记不能豁免冲突");

  store.requestSceneChange(s1, { start: "09:00" });
  assert(store.pendingReviews.length === 1, "场记改动进入待审队列");
  assert(store.scenes.find((x) => x.id === s1).start === "08:00", "待审改动未直接落盘");
  assert(store.exemptions.filter((e) => e.status === "有效").length === 0, "未落盘前不影响豁免");

  // 负责人在同一工作台切角色后看到待审
  store.role = "制片";
  assert(store.pendingReviews.length === 1, "负责人侧能看到待审");
  store.reviewChange(store.pendingReviews[0].id, true);
  assert(store.scenes.find((x) => x.id === s1).start === "09:00", "审批通过后改动落盘");
  assert(store.pendingReviews.length === 0, "待审清空");

  store.role = "场记";
  store.requestSceneChange(s1, { start: "10:00" });
  store.role = "导演";
  store.reviewChange(store.pendingReviews[0].id, false);
  assert(store.scenes.find((x) => x.id === s1).start === "09:00", "驳回后场次保持原样");
});

await section("两位负责人同时确认：只放行先到的，后者看到是谁先确认", async () => {
  resetServer();
  localStorage.clear();
  const producer = newStore("制片");
  const director = newStore("导演");
  // 两人看到相同基线（revision=0），几乎同时打包提交；服务端按到达顺序 FIFO 裁决
  const p1 = producer.confirmSchedule("制片的确认");
  const p2 = director.confirmSchedule("导演的确认");
  const [r1, r2] = await Promise.all([p1, p2]);

  assert(r1.ok === true, "先到的制片确认成功");
  assert(r2.ok === false && r2.code === "STALE_SCENES", "后到的导演确认被拒（陈旧）");
  assert(r2.conflicts.some((c) => c.winner === "制片" && c.sceneCode === "A-012"), "导演能看到 A-012 已由制片先确认");
  assert(producer.versions.length === 1 && director.versions.length === 0, "全程只产生一版，落败方不入库");

  // 导演即使反复点重试，仍被拒
  const retry = await director.confirmSchedule();
  assert(retry.ok === false, "同一份陈旧快照重试仍被拒");

  // 导演放弃陈旧包、同步到制片确认后的最新基线（revision=1）后再确认 -> 成功
  director.discardPending();
  director.refreshFromServer();
  const r3 = await director.confirmSchedule("导演刷新后的确认");
  assert(r3.ok === true, "刷新到最新基线后导演可以确认");
  assert(director.scenes.find((x) => x.id === s1).revision === 2, "revision 在制片基线上继续递增");
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
