<script setup lang="ts">
import { computed } from "vue";
import dayjs from "dayjs";
import { ElMessage } from "element-plus";
import { useScheduleStore } from "../stores/schedule";

const store = useScheduleStore();

function sceneName(id: string) {
  const scene = store.scenes.find((item) => item.id === id);
  return scene ? `${scene.code} ${scene.title}` : id;
}

const noSnapshot = computed(() => !store.currentSnapshotId);

function exempt(conflictId: string) {
  const result = store.exemptConflict(conflictId);
  if (result.ok) ElMessage.success("已按当前确认快照豁免");
  else ElMessage.warning(result.reason ?? "豁免失败");
}
</script>

<template>
  <section class="page">
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>资源冲突中心</h2>
          <small class="muted">系统按日期和时间段检查演员、场地、器材与转场间隔；豁免只对当前确认快照负责</small>
        </div>
        <span class="status">{{ store.conflicts.length }} 项待处理</span>
      </div>

      <div v-if="noSnapshot" class="draft-banner" style="margin-bottom:12px">
        <span>尚未确认通告。请先在「通告编排」中确认通告，再按确认快照豁免冲突。</span>
      </div>

      <article v-for="item in store.conflicts" :key="item.id" class="conflict">
        <span class="seal">{{ item.severity }}</span>
        <div>
          <b>{{ item.type }}</b>
          <p>{{ item.message }}</p>
          <small>{{ item.sceneIds.map(sceneName).join(" ↔ ") }}</small>
        </div>
        <button
          class="secondary"
          :disabled="!store.canConfirm || noSnapshot"
          :title="!store.canConfirm ? '只有制片和导演能豁免' : noSnapshot ? '请先确认通告' : '按当前确认快照豁免'"
          @click="exempt(item.id)"
        >负责人豁免</button>
      </article>
      <el-empty v-if="!store.conflicts.length" description="当前没有未处理冲突" />
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>已豁免冲突</h2>
          <small class="muted">场次时间 / 演员 / 场地一变，豁免立即作废并退回待处理</small>
        </div>
        <span class="status">{{ store.activeExemptions.length }} 项有效 · {{ store.voidedExemptions.length }} 项作废</span>
      </div>

      <el-empty v-if="!store.exemptions.length" description="暂无豁免记录" />
      <article v-for="item in store.exemptions" :key="item.id" class="conflict" :class="{ voided: item.status === '已作废' }">
        <span class="seal" :class="item.status">{{ item.status }}</span>
        <div>
          <b>{{ item.conflictId }}</b>
          <p v-if="item.status === '有效'">由 {{ item.exemptedBy }} 于 {{ dayjs(item.time).format("MM-DD HH:mm:ss") }} 豁免 · 按确认快照 {{ item.snapshotId.slice(0, 8) }}</p>
          <p v-else>作废于 {{ dayjs(item.voidedAt).format("MM-DD HH:mm:ss") }} · {{ item.voidReason }}</p>
          <small>{{ item.sceneIds.map(sceneName).join(" ↔ ") }}</small>
        </div>
      </article>
    </section>
  </section>
</template>

<style scoped>
.conflict.voided { opacity: .72; border-color: #d5dbe6; background: #f4f6fa; }
.seal.有效 { background: #19704b; }
.seal.已作废 { background: #8b94a6; }
</style>
