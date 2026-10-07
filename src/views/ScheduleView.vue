<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import dayjs from "dayjs";
import { ElMessage } from "element-plus";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useScheduleStore } from "../stores/schedule";
import type { Scene, SceneStatus } from "../types";

const store = useScheduleStore();
const saving = ref(false);
const dragging = ref<number | null>(null);
const form = reactive({ code: "", title: "", day: "2026-10-08", start: "08:00", end: "10:00", locationId: "l1", talentIds: [] as string[], equipmentIds: [] as string[] });
const schema = toTypedSchema(z.object({
  code: z.string().min(2, "请输入场次编号"),
  title: z.string().min(2, "请输入场次名称"),
  day: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  locationId: z.string().min(1)
}));
const { errors, validate } = useForm({ validationSchema: schema });
const currentStatus = (status: string) => status as SceneStatus;

onMounted(() => store.loadDraft());

/** 每场戏一份编辑草稿，提交时只取相对当前值发生变化的字段 */
const edits = reactive<Record<string, { day: string; start: string; end: string; locationId: string; talentIds: string[] }>>({});
function editOf(scene: Scene) {
  if (!edits[scene.id]) {
    edits[scene.id] = { day: scene.day, start: scene.start, end: scene.end, locationId: scene.locationId, talentIds: [...scene.talentIds] };
  }
  return edits[scene.id];
}

function buildPatch(scene: Scene) {
  const draft = editOf(scene);
  const patch: Partial<Pick<Scene, "day" | "start" | "end" | "talentIds" | "locationId">> = {};
  if (draft.day !== scene.day) patch.day = draft.day;
  if (draft.start !== scene.start) patch.start = draft.start;
  if (draft.end !== scene.end) patch.end = draft.end;
  if (draft.locationId !== scene.locationId) patch.locationId = draft.locationId;
  const sameTalents = draft.talentIds.length === scene.talentIds.length && draft.talentIds.every((id) => scene.talentIds.includes(id));
  if (!sameTalents) patch.talentIds = [...draft.talentIds];
  return patch;
}

function applyChange(scene: Scene) {
  const patch = buildPatch(scene);
  if (!Object.keys(patch).length) {
    ElMessage.warning("内容没有变化");
    return;
  }
  const id = store.requestSceneChange(scene.id, patch);
  if (id) {
    ElMessage.success("改动已提交，等待制片或导演审批");
  } else if (store.isLead) {
    Object.assign(edits[scene.id], { day: scene.day, start: scene.start, end: scene.end, locationId: scene.locationId, talentIds: [...scene.talentIds] });
    ElMessage.success("调整已落盘，相关豁免已重新校验");
  }
}

async function submit() {
  const result = await validate({ values: form } as any);
  if (!result.valid) return;
  saving.value = true;
  store.addScene({ code: form.code, title: form.title, day: form.day, start: form.start, end: form.end, locationId: form.locationId, talentIds: [...form.talentIds], equipmentIds: [...form.equipmentIds] });
  Object.assign(form, { code: "", title: "", day: "2026-10-08", start: "08:00", end: "10:00", locationId: "l1", talentIds: [], equipmentIds: [] });
  setTimeout(() => { saving.value = false; }, 240);
}

async function confirmSchedule() {
  const result = await store.confirmSchedule();
  if (result.ok) {
    ElMessage.success((result as { duplicated?: boolean }).duplicated ? "回执补全，未产生重复版本" : "通告已确认，快照已保存");
  } else if (result.code === "FORBIDDEN") {
    ElMessage.error("只有制片和导演可以确认通告");
  }
  // BUSY（失败/进行中）与 STALE_SCENES 的细节由页面横幅展示
}

function drop(index: number) {
  if (dragging.value !== null && store.isLead) store.moveScene(dragging.value, index);
  dragging.value = null;
}

const reviewCount = computed(() => store.pendingReviews.length);

async function refreshAndReconfirm() {
  store.refreshFromServer();
  store.discardPending();
  const result = await store.confirmSchedule();
  if (result.ok) ElMessage.success("已同步最新通告并完成确认");
}
</script>

<template>
  <section class="page">
    <div class="metrics">
      <article class="metric"><span>通告场次</span><strong>{{ store.scenes.length }}</strong></article>
      <article class="metric"><span>待处理冲突</span><strong>{{ store.conflicts.length }}</strong></article>
      <article class="metric"><span>确认快照</span><strong>{{ store.versions.length }}</strong></article>
      <article class="metric"><span>待审改动</span><strong>{{ reviewCount }}</strong></article>
    </div>

    <!-- 提交失败挂起：原令牌重试，不产生新版本 -->
    <div v-if="store.pending" class="draft-banner pending-banner">
      <span>
        <b>「{{ store.pending.name }}」尚未送达</b>
        <small v-if="store.submitError" class="muted"> · {{ store.submitError }}</small>
        <br />
        <small class="muted">打包于 {{ dayjs(store.pending.createdAt).format("MM-DD HH:mm:ss") }}，重试沿用同一份快照与令牌，不会多出一版</small>
      </span>
      <div class="actions">
        <button class="primary" :disabled="store.submitting" @click="confirmSchedule">{{ store.submitting ? "提交中…" : "重试提交" }}</button>
        <button class="secondary" :disabled="store.submitting" @click="store.discardPending">放弃并刷新</button>
      </div>
    </div>

    <!-- 并发落败：只放行先到的那份，并告知是谁先确认 -->
    <div v-if="store.staleResult" class="draft-banner stale-banner">
      <span>
        <b>「{{ store.staleResult.name }}」未通过确认</b><br />
        <small>
          以下场次已被另一位负责人抢先确认：
          <template v-for="(item, index) in store.staleResult.conflicts" :key="index">
            {{ item.sceneCode }} 由 {{ item.winner }} 于 {{ dayjs(item.winnerAt).format("MM-DD HH:mm:ss") }} 先确认；
          </template>
          请刷新到最新通告后再确认。
        </small>
      </span>
      <div class="actions">
        <button class="primary" @click="refreshAndReconfirm">刷新最新通告后重新确认</button>
        <button class="secondary" @click="store.discardPending">知道了</button>
      </div>
    </div>

    <div v-if="store.draft" class="draft-banner">
      <span>发现 {{ dayjs(store.draft.savedAt).format("MM-DD HH:mm") }} 的离线草稿，共 {{ store.draft.scenes.length }} 个场次。</span>
      <div class="actions"><button class="secondary" @click="store.syncDraft">同步到正式通告</button></div>
    </div>

    <div v-if="reviewCount" class="panel review-panel">
      <div class="panel-head"><h2>待审改动（{{ reviewCount }}）</h2><small class="muted">仅制片/导演可审批，通过后才落盘并重新校验豁免</small></div>
      <div class="history">
        <div v-for="item in store.pendingReviews" :key="item.id" class="history-row">
          <span class="muted">{{ dayjs(item.submittedAt).format("MM-DD HH:mm") }} · {{ item.submittedBy }}</span>
          <b>{{ item.sceneCode }}</b>
          <span>
            申请调整：时间 {{ item.patch.day ?? "—" }} {{ item.patch.start ?? "" }}–{{ item.patch.end ?? "" }}
            <template v-if="item.patch.locationId"> · 场地 {{ store.locationName(item.patch.locationId) }}</template>
            <template v-if="item.patch.talentIds"> · 演员 {{ store.talentNames(item.patch.talentIds).join("、") }}</template>
            <span class="actions" style="margin-left:10px" v-if="store.isLead">
              <button class="primary" @click="store.reviewChange(item.id, true)">通过</button>
              <button class="danger" @click="store.reviewChange(item.id, false)">驳回</button>
            </span>
            <em v-else class="muted">等待制片/导演审批</em>
          </span>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <section class="panel">
        <div class="panel-head"><h2>新增场次</h2><button class="secondary" @click="store.saveDraft">保存离线草稿</button></div>
        <form class="form-grid" @submit.prevent="submit">
          <label class="field"><span>场次编号</span><input v-model="form.code" placeholder="C-018" /><small>{{ errors.code }}</small></label>
          <label class="field"><span>场次名称</span><input v-model="form.title" placeholder="例如：雨夜追踪" /><small>{{ errors.title }}</small></label>
          <label class="field"><span>拍摄日</span><input v-model="form.day" type="date" /></label>
          <label class="field"><span>场地</span><select v-model="form.locationId"><option v-for="item in store.locations" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <label class="field"><span>开始</span><input v-model="form.start" type="time" /></label>
          <label class="field"><span>结束</span><input v-model="form.end" type="time" /></label>
          <label class="field wide"><span>演员档期</span><select v-model="form.talentIds" multiple><option v-for="item in store.talents" :key="item.id" :value="item.id">{{ item.name }} · {{ item.role }}</option></select></label>
          <label class="field wide"><span>器材借用</span><select v-model="form.equipmentIds" multiple><option v-for="item in store.equipment" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <div class="actions wide">
            <button class="primary" :disabled="saving || !store.isLead">{{ store.isLead ? "保存为草稿" : "仅制片/导演可新增场次" }}</button>
            <RouterLink class="secondary" to="/conflicts">检查冲突</RouterLink>
          </div>
        </form>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>当日通告顺序</h2>
            <small class="muted">确认通告时按当时的场次、演员和场地存快照，豁免只认这份快照</small>
          </div>
          <div class="actions">
            <button class="secondary" title="演练用：让下一次提交失败一次" @click="store.scheduleOneFailure">模拟一次提交失败</button>
            <button class="primary" :disabled="!store.isLead || store.submitting" @click="confirmSchedule">{{ store.submitting ? "提交中…" : "确认通告并存快照" }}</button>
          </div>
        </div>
        <p v-if="store.latestVersion" class="muted confirm-line">
          当前基线：{{ store.latestVersion.name }} · {{ store.latestVersion.confirmedBy }} 于 {{ dayjs(store.latestVersion.time).format("MM-DD HH:mm:ss") }} 确认
        </p>
        <div class="scene-list">
          <article v-for="(scene,index) in store.sortedScenes" :key="scene.id" class="scene" :class="{ locked: scene.locked, dragging: dragging === index }" draggable="true" @dragstart="dragging=index" @dragover.prevent @drop="drop(index)">
            <b>{{ index + 1 }}</b>
            <div class="scene-code">{{ scene.code }}</div>
            <div class="scene-title">
              <b>{{ scene.title }}</b>
              <small>{{ scene.start }}–{{ scene.end }} · {{ store.locationName(scene.locationId) }}</small>
              <small v-if="scene.confirmedBy" class="muted"> · 最后由{{ scene.confirmedBy }}确认 r{{ scene.revision }}</small>
            </div>
            <span class="status" :class="scene.status">{{ scene.status }}</span>
            <div class="actions">
              <button class="secondary" :disabled="!store.isLead || scene.locked" @click="store.updateStatus(scene.id, currentStatus(scene.status === '草稿' ? '已确认' : scene.status === '已确认' ? '拍摄中' : scene.status === '拍摄中' ? '已完成' : '已完成'))">推进</button>
              <button class="secondary" :disabled="!store.isLead" @click="store.toggleLock(scene.id)">{{ scene.locked ? "解锁" : "锁定" }}</button>
            </div>
            <div class="scene-meta wide">
              <small>演员：{{ store.talentNames(scene.talentIds).join("、") || "待定" }} · 器材：{{ store.equipmentNames(scene.equipmentIds).join("、") || "无" }}</small>
              <div class="edit-row">
                <label>日 <input v-model="editOf(scene).day" type="date" :disabled="scene.locked" /></label>
                <label>起 <input v-model="editOf(scene).start" type="time" :disabled="scene.locked" /></label>
                <label>止 <input v-model="editOf(scene).end" type="time" :disabled="scene.locked" /></label>
                <label>场地
                  <select v-model="editOf(scene).locationId" :disabled="scene.locked"><option v-for="item in store.locations" :key="item.id" :value="item.id">{{ item.name }}</option></select>
                </label>
                <label class="grow">演员
                  <select v-model="editOf(scene).talentIds" multiple :disabled="scene.locked"><option v-for="item in store.talents" :key="item.id" :value="item.id">{{ item.name }}</option></select>
                </label>
                <button class="primary" :disabled="scene.locked" @click="applyChange(scene)">{{ store.isLead ? "应用调整" : "提交待审" }}</button>
              </div>
              <small class="muted">{{ store.isLead ? "负责人调整立即落盘，命中豁免的豁免立即作废" : "场记/统筹的改动先进待审，制片或导演通过后才生效" }}</small>
            </div>
          </article>
        </div>
      </section>
    </div>
  </section>
</template>
