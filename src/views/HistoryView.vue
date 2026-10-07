<script setup lang="ts">
import dayjs from "dayjs";
import { useScheduleStore } from "../stores/schedule";
const store = useScheduleStore();
</script>
<template>
  <section class="page grid-2">
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>确认快照</h2>
          <small class="muted">快照只在「确认通告」时生成；恢复旧版带不回已作废的豁免</small>
        </div>
      </div>
      <el-empty v-if="!store.versions.length" description="尚未确认过通告" />
      <article v-for="item in store.versions" :key="item.id" class="draft-banner version-row">
        <div>
          <b>{{ item.name }}</b><br />
          <small>{{ dayjs(item.time).format("YYYY-MM-DD HH:mm:ss") }} · {{ item.scenes.length }} 场 · {{ item.confirmedBy }}确认</small><br />
          <small class="muted">快照令牌 {{ item.requestToken.slice(0, 8) }}…</small>
        </div>
        <button class="secondary" :disabled="!store.isLead || !!store.pending" :title="store.pending ? '有提交尚未送达，请先处理重试' : ''" @click="store.restore(item.id)">恢复</button>
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
