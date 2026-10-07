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
const editable = computed(() => store.canEditDirectly);
const currentStatus = (status: string) => status as SceneStatus;

onMounted(() => store.loadDraft());

async function submit() {
  const result = await validate({ values: form } as any);
  if (!result.valid) return;
  saving.value = true;
  store.requestAddScene({ code: form.code, title: form.title, day: form.day, start: form.start, end: form.end, locationId: form.locationId, talentIds: [...form.talentIds], equipmentIds: [...form.equipmentIds] });
  Object.assign(form, { code: "", title: "", day: "2026-10-08", start: "08:00", end: "10:00", locationId: "l1", talentIds: [], equipmentIds: [] });
  setTimeout(() => { saving.value = false; }, 240);
}

function drop(index: number) {
  if (dragging.value !== null && editable.value) store.moveScene(dragging.value, index);
  dragging.value = null;
}

/** 确认通告：按当前场次/演员/场地存快照，只有制片和导演能操作 */
function confirm() {
  const result = store.confirmCallSheet();
  if (!result.ok) {
    ElMessage.warning(result.reason ?? "确认失败");
    return;
  }
  if (result.firstConfirmedBy && result.firstConfirmedBy !== store.role) {
    ElMessage.info(`${result.firstConfirmedBy} 已先确认，沿用其快照，未重复出一版`);
  } else {
    ElMessage.success("通告已确认，已按当前场次/演员/场地存快照");
  }
}

/** 场次编辑（时间/演员/场地），带 baseVersion 乐观并发 */
const editVisible = ref(false);
const editForm = reactive({ id: "", code: "", title: "", day: "", start: "", end: "", locationId: "l1", talentIds: [] as string[], equipmentIds: [] as string[], baseVersion: 1 });

function openEdit(scene: Scene) {
  Object.assign(editForm, {
    id: scene.id, code: scene.code, title: scene.title, day: scene.day, start: scene.start, end: scene.end,
    locationId: scene.locationId, talentIds: [...scene.talentIds], equipmentIds: [...scene.equipmentIds], baseVersion: scene.version
  });
  editVisible.value = true;
}

function submitEdit() {
  const result = store.requestEditScene(editForm.id, {
    code: editForm.code, title: editForm.title, day: editForm.day, start: editForm.start, end: editForm.end,
    locationId: editForm.locationId, talentIds: [...editForm.talentIds], equipmentIds: [...editForm.equipmentIds]
  }, editForm.baseVersion);
  if (result.ok && !result.pending) {
    editVisible.value = false;
    ElMessage.success("场次已保存");
  } else if (result.pending) {
    editVisible.value = false;
    ElMessage.info("改动已提交待审，审批后生效");
  } else {
    ElMessage.error(`${result.reason}${result.winner ? ` · ${result.winner} 已先保存` : ""}`);
  }
}

function advance(scene: Scene) {
  const next = currentStatus(scene.status === "草稿" ? "已确认" : scene.status === "已确认" ? "拍摄中" : scene.status === "拍摄中" ? "已完成" : "已完成");
  store.requestUpdateStatus(scene.id, next, scene.version);
}

function retry(id: string) {
  const result = store.retryFailed(id);
  if (result.ok) ElMessage.success("重试成功，已保存");
  else ElMessage.warning(`${result.reason}${result.winner ? ` · ${result.winner} 已先保存` : ""}`);
}
</script>

<template>
  <section class="page">
    <div class="metrics">
      <article class="metric"><span>通告场次</span><strong>{{ store.scenes.length }}</strong></article>
      <article class="metric"><span>待处理冲突</span><strong>{{ store.conflicts.length }}</strong></article>
      <article class="metric"><span>已确认</span><strong>{{ store.scenes.filter((item: Scene) => item.status === "已确认").length }}</strong></article>
      <article class="metric"><span>版本快照</span><strong>{{ store.versions.length }}</strong></article>
    </div>

    <div v-if="store.draft" class="draft-banner">
      <span>发现 {{ dayjs(store.draft.savedAt).format("MM-DD HH:mm") }} 的离线草稿，共 {{ store.draft.scenes.length }} 个场次。</span>
      <div class="actions"><button class="secondary" @click="store.syncDraft">同步到正式通告</button></div>
    </div>

    <div v-if="store.pendingCount" class="draft-banner pending-banner">
      <span>{{ store.pendingCount }} 项改动待审（{{ store.role }} 提交后需制片/导演审批）。</span>
    </div>

    <div v-if="store.failedCount" class="draft-banner failed-banner">
      <span>{{ store.failedCount }} 项提交失败，可接着重试。</span>
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
          <div class="actions wide"><button class="primary" :disabled="saving" @click="submit">保存为草稿</button><RouterLink class="secondary" to="/conflicts">检查冲突</RouterLink></div>
        </form>
        <p v-if="!editable" class="muted pending-hint">当前角色 {{ store.role }} 的改动将进入待审，不会直接生效。</p>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>当日通告顺序</h2>
            <small class="muted">
              <template v-if="store.currentSnapshot">
                已确认快照 · {{ store.currentSnapshot.confirmedBy }} 于 {{ dayjs(store.currentSnapshot.time).format("MM-DD HH:mm") }} 确认
              </template>
              <template v-else>尚未确认通告 · 确认后才能按快照豁免冲突</template>
            </small>
          </div>
          <button class="primary" :disabled="!store.canConfirm" @click="confirm">确认通告</button>
        </div>
        <div class="scene-list">
          <article v-for="(scene, index) in store.sortedScenes" :key="scene.id" class="scene" :class="{ locked: scene.locked, dragging: dragging === index }" draggable="true" @dragstart="dragging = index" @dragover.prevent @drop="drop(index)">
            <b>{{ index + 1 }}</b>
            <div class="scene-code">{{ scene.code }}</div>
            <div class="scene-title">
              <b>{{ scene.title }}</b>
              <small>{{ scene.start }}–{{ scene.end }} · {{ store.locationName(scene.locationId) }}</small>
              <small class="muted">v{{ scene.version }}<template v-if="scene.lastConfirmedBy"> · {{ scene.lastConfirmedBy }} 最后保存</template></small>
            </div>
            <span class="status" :class="scene.status">{{ scene.status }}</span>
            <div class="actions">
              <button class="secondary" :disabled="!editable || scene.locked" @click="advance(scene)">推进</button>
              <button class="secondary" @click="openEdit(scene)">编辑</button>
              <button class="secondary" :disabled="!editable" @click="store.toggleLock(scene.id)">{{ scene.locked ? "解锁" : "锁定" }}</button>
            </div>
            <div class="scene-meta wide">
              <small>演员：{{ store.talentNames(scene.talentIds).join("、") || "待定" }} · 器材：{{ store.equipmentNames(scene.equipmentIds).join("、") || "无" }}</small>
            </div>
          </article>
        </div>
      </section>
    </div>

    <!-- 待审队列 -->
    <section v-if="store.pendingChanges.length" class="panel">
      <div class="panel-head"><div><h2>待审改动</h2><small class="muted">场记 / 演员统筹提交，制片与导演审批后生效</small></div></div>
      <div v-for="item in store.pendingChanges" :key="item.id" class="draft-banner pending-row">
        <div>
          <b>{{ item.type }}</b>
          <p class="muted">{{ item.submittedBy }} 于 {{ dayjs(item.submittedAt).format("MM-DD HH:mm:ss") }} 提交<template v-if="item.status !== '待审'"> · {{ item.status }}<template v-if="item.reviewedBy"> · {{ item.reviewedBy }}</template></template></p>
          <small v-if="item.type === '新增场次'">{{ item.payload.input.code }} {{ item.payload.input.title }}</small>
          <small v-else-if="item.type === '修改场次'">{{ item.payload.id }} → {{ JSON.stringify(item.payload.changes) }}</small>
          <small v-else>{{ item.payload.id }} → {{ item.payload.status }}</small>
          <small v-if="item.reason" class="muted"> · {{ item.reason }}</small>
        </div>
        <div v-if="item.status === '待审'" class="actions">
          <button class="primary" :disabled="!store.canConfirm" @click="store.approvePending(item.id)">通过</button>
          <button class="secondary" :disabled="!store.canConfirm" @click="store.rejectPending(item.id)">驳回</button>
        </div>
      </div>
    </section>

    <!-- 失败重试队列 -->
    <section v-if="store.failedSubmissions.length" class="panel">
      <div class="panel-head"><div><h2>提交失败</h2><small class="muted">先到者胜，可接着重试；重试仍以原版本复检</small></div></div>
      <div v-for="item in store.failedSubmissions" :key="item.id" class="draft-banner failed-row">
        <div>
          <b>{{ item.kind }}</b>
          <p class="muted">{{ item.reason }}<template v-if="item.winner"> · {{ item.winner }} 已于 {{ dayjs(item.winnerAt).format("MM-DD HH:mm:ss") }} 先保存</template></p>
          <small>第 {{ item.retries }} 次重试 · {{ dayjs(item.time).format("MM-DD HH:mm:ss") }}</small>
        </div>
        <div class="actions">
          <button class="primary" @click="retry(item.id)">重试</button>
          <button class="secondary" @click="store.dismissFailed(item.id)">忽略</button>
        </div>
      </div>
    </section>

    <el-dialog v-model="editVisible" title="编辑场次（时间 / 演员 / 场地）" width="560px">
      <form class="form-grid" @submit.prevent="submitEdit">
        <label class="field"><span>场次编号</span><input v-model="editForm.code" /></label>
        <label class="field"><span>场次名称</span><input v-model="editForm.title" /></label>
        <label class="field"><span>拍摄日</span><input v-model="editForm.day" type="date" /></label>
        <label class="field"><span>场地</span><select v-model="editForm.locationId"><option v-for="item in store.locations" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
        <label class="field"><span>开始</span><input v-model="editForm.start" type="time" /></label>
        <label class="field"><span>结束</span><input v-model="editForm.end" type="time" /></label>
        <label class="field wide"><span>演员档期</span><select v-model="editForm.talentIds" multiple><option v-for="item in store.talents" :key="item.id" :value="item.id">{{ item.name }} · {{ item.role }}</option></select></label>
        <label class="field wide"><span>器材借用</span><select v-model="editForm.equipmentIds" multiple><option v-for="item in store.equipment" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
        <div class="actions wide">
          <button class="primary" type="submit">保存</button>
          <button class="secondary" type="button" @click="editVisible = false">取消</button>
        </div>
      </form>
      <p class="muted concurrency-hint">保存时以 v{{ editForm.baseVersion }} 复检：若已被他人先保存，将提示先到者且不会覆盖。</p>
    </el-dialog>
  </section>
</template>

<style scoped>
.pending-banner { background: #eef4ff; border-color: #b9ccf0; }
.failed-banner { background: #fff0f0; border-color: #f0b9b9; }
.pending-row, .failed-row { margin-bottom: 10px; }
.pending-hint { margin: 10px 0 0; font-size: 13px; }
.concurrency-hint { margin: 12px 0 0; font-size: 12px; }
.scene-title small { display: block; }
</style>
