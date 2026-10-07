<script setup lang="ts">
import dayjs from "dayjs";
import { useScheduleStore } from "../stores/schedule";
const store = useScheduleStore();
</script>
<template>
  <section class="page grid-2">
    <section class="panel">
      <div class="panel-head">
        <div><h2>版本快照</h2><small class="muted">恢复会覆盖当前通告；作废的豁免不会被带回</small></div>
        <button class="primary" :disabled="store.role === '场记'" @click="store.snapshot()">创建版本</button>
      </div>
      <el-empty v-if="!store.versions.length" description="尚未创建版本" />
      <article v-for="item in store.versions" :key="item.id" class="draft-banner version-row">
        <div>
          <b>{{ item.name }}</b>
          <br />
          <small>{{ dayjs(item.time).format("YYYY-MM-DD HH:mm:ss") }} · {{ item.scenes.length }} 场</small>
          <small v-if="item.confirmedBy" class="confirm-tag"> · 确认人 {{ item.confirmedBy }}</small>
          <small v-else class="muted"> · 手动快照</small>
        </div>
        <button class="secondary" :disabled="store.role !== '制片'" @click="store.restore(item.id)">恢复</button>
      </article>
    </section>
    <section class="panel">
      <div class="panel-head"><h2>操作历史</h2></div>
      <div class="history">
        <el-empty v-if="!store.history.length" description="暂无操作" />
        <div v-for="item in store.history" :key="item.id" class="history-row"><span class="muted">{{ dayjs(item.time).format("MM-DD HH:mm:ss") }}</span><b>{{ item.action }}</b><span>{{ item.detail }}</span></div>
      </div>
    </section>
  </section>
</template>

<style scoped>
.version-row { margin-bottom: 10px; }
.confirm-tag { color: #19704b; font-weight: 700; }
</style>
