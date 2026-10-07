<script setup lang="ts">
import dayjs from "dayjs";
import { useScheduleStore } from "../stores/schedule";
import type { Conflict } from "../types";

const store = useScheduleStore();

function sceneName(id: string) {
  const scene = store.scenes.find((item) => item.id === id);
  return scene ? `${scene.code} ${scene.title}` : id;
}

function grant(conflict: Conflict) {
  const error = store.exempt(conflict);
  if (error) window.alert(error);
}
</script>

<template>
  <section class="page">
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>资源冲突中心</h2>
          <small class="muted">豁免锚定最近一次确认快照；被豁免场次的时间、演员或场地一变即退回待处理</small>
        </div>
        <span class="status">{{ store.conflicts.length }} 项待处理</span>
      </div>

      <div v-if="!store.latestVersion" class="draft-banner" style="margin-bottom:12px">
        <span>尚未确认过通告快照，暂不能豁免冲突。请先到「通告编排」由制片或导演确认通告。</span>
      </div>

      <article v-for="item in store.conflicts" :key="item.id" class="conflict">
        <span class="seal">{{ item.severity }}</span>
        <div>
          <b>{{ item.type }}</b>
          <p>{{ item.message }}</p>
          <small>{{ item.sceneIds.map(sceneName).join(" ↔ ") }}</small>
        </div>
        <button class="secondary" :disabled="!store.isLead" @click="grant(item)">
          {{ store.isLead ? "负责人豁免" : "仅制片/导演可豁免" }}
        </button>
      </article>
      <el-empty v-if="!store.conflicts.length" description="当前没有未处理冲突" />
    </section>

    <section class="panel" v-if="store.exemptions.length">
      <div class="panel-head">
        <div>
          <h2>豁免记录</h2>
          <small class="muted">已作废的豁免不会因恢复旧版本而复活</small>
        </div>
      </div>
      <div class="history">
        <div v-for="item in store.exemptions" :key="item.id" class="history-row exemption-row" :class="item.status">
          <span class="muted">{{ dayjs(item.grantedAt).format("MM-DD HH:mm") }}</span>
          <b>{{ item.type }} · {{ item.status }}</b>
          <span>
            {{ item.sceneIds.map(sceneName).join(" ↔ ") }}
            <small class="muted">锚定 {{ item.versionName }}，{{ item.grantedBy }} 批准</small>
            <template v-if="item.status === '已作废'">
              <br /><small class="void-reason">已作废：{{ item.voidReason }}（{{ dayjs(item.voidedAt).format("MM-DD HH:mm") }}），冲突已退回待处理</small>
            </template>
          </span>
        </div>
      </div>
    </section>
  </section>
</template>
