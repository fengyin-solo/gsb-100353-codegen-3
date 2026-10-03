<template>
  <section class="page" data-module="waterlevel">
    <header class="page-head">
      <div>
        <h2>水位监测管理</h2>
        <p class="page-desc">维护水位记录，围绕记录编号、站点编号、观测时间、当前水位做登记、筛选与状态流转，并经分级判定台按警戒、保证水位判定预警级别。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记水位记录</button>
        <button class="btn" type="button" @click="exportRows">导出水位监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <section class="judge-panel">
      <header class="judge-head">
        <h3>分级判定台</h3>
        <p>依据当前水位与警戒、保证水位判定预警级别（正常 / 超警戒 / 超保证），并计算超限倍数与水位变幅；保证水位判定与人工复核意见冲突时，以人工结论优先并保留判定依据。</p>
      </header>
      <label class="judge-select">
        <span>判定记录</span>
        <select v-model="selectedId">
          <option v-for="row in rows" :key="String(row.id)" :value="Number(row.id)">
            {{ row.记录编号 }}（{{ row.站点编号 }} · {{ row.观测时间 }}）
          </option>
        </select>
      </label>
      <dl v-if="selectedRow" class="judge-grid">
        <div><dt>当前水位</dt><dd>{{ selectedRow.当前水位 ?? '—' }}</dd></div>
        <div><dt>警戒水位</dt><dd>{{ selectedRow.警戒水位 ?? '—' }}</dd></div>
        <div><dt>保证水位</dt><dd>{{ selectedRow.保证水位 ?? '—' }}</dd></div>
        <div><dt>水位变幅</dt><dd>{{ selectedRow.水位变幅 ?? '—' }}</dd></div>
        <div><dt>预警级别</dt><dd>{{ selectedRow.预警级别 || '未判定' }}</dd></div>
        <div><dt>超限倍数</dt><dd>{{ selectedRow.超限倍数 || '—' }}</dd></div>
        <div><dt>人工复核结论</dt><dd>{{ selectedRow.人工复核结论 || '—' }}</dd></div>
        <div><dt>判定时间</dt><dd>{{ selectedRow.判定时间 || '—' }}</dd></div>
      </dl>
      <p v-if="selectedRow" class="judge-basis">判定依据：{{ selectedRow.判定依据 || '尚未执行判定' }}</p>
      <div class="judge-form">
        <label>
          <span>人工复核结论</span>
          <select v-model="manualLevel">
            <option value="">不复核，按自动判定</option>
            <option v-for="level in warningLevels" :key="level" :value="level">{{ level }}</option>
          </select>
        </label>
        <label class="judge-opinion">
          <span>复核意见</span>
          <input v-model="manualOpinion" placeholder="与保证水位判定冲突时以人工结论优先，意见将写入判定依据" />
        </label>
        <button class="btn primary" type="button" @click="submitJudge">执行判定</button>
      </div>
      <p v-if="judgeMessage" class="judge-message">{{ judgeMessage }}</p>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="pickForJudge(row)">分级判定</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无水位监测数据，可先登记水位记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条水位监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  WARNING_LEVELS,
  downloadEntries,
  judgeWaterLevel,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('waterlevel')
const columns = ["记录编号", "站点编号", "观测时间", "当前水位", "警戒水位", "保证水位", "水位变幅", "预警级别", "超限倍数", "记录状态"]
const actions = ["提交审核", "确认通过", "标记异常"]
const statuses = ["已采集", "待审核", "已通过", "异常值"]
const stats = [{"label": "今日采集数", "value": 0}, {"label": "超警戒站次", "value": 0}, {"label": "待审核记录", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 分级判定台：选中记录、人工复核输入与判定结果提示。
const warningLevels = WARNING_LEVELS
const selectedId = ref<number | null>(null)
const manualLevel = ref('')
const manualOpinion = ref('')
const judgeMessage = ref('')
const selectedRow = computed(
  () => rows.value.find((row) => Number(row.id) === selectedId.value) ?? null,
)

function pickForJudge(row: EntryRow) {
  selectedId.value = Number(row.id)
  manualLevel.value = String(row.人工复核结论 ?? '')
  manualOpinion.value = String(row.复核意见 ?? '')
  judgeMessage.value = ''
}

function submitJudge() {
  if (selectedId.value === null) {
    judgeMessage.value = '请先选择要判定的水位记录'
    return
  }
  const result = judgeWaterLevel(selectedId.value, {
    manualLevel: manualLevel.value,
    manualOpinion: manualOpinion.value,
  })
  judgeMessage.value = result.message
  if (!result.ok) {
    return
  }
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '水位记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    if (
      payload.items.length > 0 &&
      !payload.items.some((row) => Number(row.id) === selectedId.value)
    ) {
      selectedId.value = Number(payload.items[0].id)
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '水位监测列表读取失败'
  }
}

onMounted(reload)
</script>
