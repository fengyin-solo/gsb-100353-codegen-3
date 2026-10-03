<template>
  <section class="page" data-module="waterlevel">
    <header class="page-head">
      <div>
        <h2>水位监测管理</h2>
        <p class="page-desc">
          维护水位记录，并在分级判定台依据当前水位与警戒、保证水位判定预警级别，联动阈值台账与巡检事项。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" :class="{ primary: tab === 'grading' }" type="button" @click="switchTab('grading')">
          分级判定台
        </button>
        <button class="btn" :class="{ primary: tab === 'records' }" type="button" @click="switchTab('records')">
          水位记录
        </button>
        <button class="btn" type="button" @click="exportRows">导出水位监测清单</button>
      </div>
    </header>

    <!-- 原始水位记录页签：保持既有列表与状态流转 -->
    <template v-if="tab === 'records'">
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
    </template>

    <!-- 分级判定台 -->
    <template v-else>
      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">待判定记录</span>
          <strong class="stat-value">{{ gradeStats.pending }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">超警戒（橙）</span>
          <strong class="stat-value grade-text-orange">{{ gradeStats.orange }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">超保证（红）</span>
          <strong class="stat-value grade-text-red">{{ gradeStats.red }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">人工复核改判</span>
          <strong class="stat-value">{{ gradeStats.manual }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">停用站冻结记录</span>
          <strong class="stat-value">{{ gradeStats.locked }}</strong>
        </article>
      </div>

      <div class="grading-toolbar">
        <button class="btn primary" type="button" @click="batchReplay">批量回放判定</button>
        <button class="btn" type="button" @click="refreshGrading">刷新</button>
        <span class="toolbar-hint">
          回放按「当前水位 vs 警戒/保证」判定；重复回放同一记录只更新既有台账记录与巡检事项，不重复生成。
        </span>
      </div>

      <div v-if="backfillBanner.length" class="notice-bar">
        <strong>阈值回填：</strong>
        <span v-for="(item, index) in backfillBanner" :key="item.recordNo">
          {{ item.recordNo }}（{{ item.stationNo }}）按现行配置 {{ item.configNo }} 回填{{ item.fields.join('、') }}<template
            v-if="index < backfillBanner.length - 1"
          >；</template>
        </span>
      </div>

      <div v-if="gradingMessage" class="notice-bar" :class="gradingOk ? 'notice-ok' : 'notice-warn'">
        {{ gradingMessage }}
      </div>

      <table class="data-table grading-table">
        <thead>
          <tr>
            <th>记录编号</th>
            <th>站点编号 / 站态</th>
            <th>观测时间</th>
            <th>当前水位(m)</th>
            <th>警戒 / 保证(m)</th>
            <th>超限倍数</th>
            <th>水位变幅(m)</th>
            <th>预警级别</th>
            <th>判定时间</th>
            <th>联动记录</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in gradeRows" :key="item.id">
            <td>{{ item.recordNo }}</td>
            <td>
              {{ item.stationNo }}
              <span class="station-tag" :class="item.stationRunning ? '' : 'station-off'">
                {{ item.stationStatus }}
              </span>
            </td>
            <td>{{ item.observedAt }}</td>
            <td>{{ item.level === null ? '—' : item.level.toFixed(2) }}</td>
            <td>
              {{ item.warning === null ? '缺' : item.warning.toFixed(2) }}
              /
              {{ item.guarantee === null ? '缺' : item.guarantee.toFixed(2) }}
              <span v-if="item.warningFill || item.guaranteeFill" class="fill-mark" title="该记录历史缺值，已按站点现行阈值配置回填">
                回填
              </span>
            </td>
            <td>
              <span v-if="item.ratio !== null" class="ratio-text">{{ item.ratio.toFixed(2) }} 倍</span>
              <span v-else>—</span>
            </td>
            <td :class="amplitudeClass(item.amplitude)">{{ item.amplitude }}</td>
            <td>
              <span class="grade-badge" :class="`grade-${item.grade}`">{{ item.gradeLabel }}</span>
              <span v-if="item.gradeSource === '人工复核'" class="manual-tag">人工优先</span>
            </td>
            <td>{{ item.judgedAt || '—' }}</td>
            <td class="linked-codes">
              <template v-if="item.linkedWarningCode">
                <RouterLink class="link" to="/warning">{{ item.linkedWarningCode }}</RouterLink>
                <RouterLink class="link" to="/inspection">{{ item.linkedInspectionCode }}</RouterLink>
              </template>
              <span v-else>—</span>
            </td>
            <td class="row-actions">
              <button class="link" type="button" @click="replayOne(item)">回放判定</button>
              <button
                class="link"
                type="button"
                :disabled="!item.stationRunning"
                :title="item.stationRunning ? '' : '站点停用后历史判定冻结，不允许改判'"
                @click="openReview(item)"
              >
                人工复核
              </button>
              <button class="link" type="button" @click="openBasis(item)">判定依据</button>
            </td>
          </tr>
          <tr v-if="!gradeRows.length">
            <td colspan="11" class="empty-state">暂无水位记录</td>
          </tr>
        </tbody>
      </table>

      <footer class="page-foot">
        <span>
          分级口径：达到保证水位为保证（红），达到警戒水位为警戒（橙），达到蓝色关注线为关注（蓝）；
          阈值映射 黄=警戒、红=保证。
        </span>
        <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      </footer>
    </template>

    <!-- 人工复核弹窗 -->
    <div v-if="reviewTarget" class="modal-mask" @click.self="closeReview">
      <div class="modal-box">
        <h3>人工复核 · {{ reviewTarget.recordNo }}</h3>
        <p class="modal-sub">
          {{ reviewTarget.stationNo }} · 当前水位 {{ reviewTarget.level?.toFixed(2) }}m ·
          自动结论将与人工意见一并保留，冲突时以人工结论为准。
        </p>
        <label class="modal-field">
          <span>复核结论</span>
          <select v-model="reviewGrade">
            <option v-for="grade in reviewableGrades" :key="grade.key" :value="grade.key">
              {{ grade.label }}
            </option>
          </select>
        </label>
        <label class="modal-field">
          <span>复核意见（必填，写入判定依据）</span>
          <textarea v-model="reviewOpinion" rows="4" placeholder="说明现场情况、改判理由，例如：上游开闸预泄，水势已回落"></textarea>
        </label>
        <p v-if="reviewError" class="error-text">{{ reviewError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeReview">取消</button>
          <button class="btn primary" type="button" @click="submitReview">提交复核并联动</button>
        </div>
      </div>
    </div>

    <!-- 判定依据抽屉 -->
    <div v-if="basisTarget" class="modal-mask" @click.self="basisTarget = null">
      <div class="modal-box modal-wide">
        <h3>判定依据 · {{ basisTarget.recordNo }}</h3>
        <dl class="basis-list">
          <dt>预警级别 / 来源</dt>
          <dd>
            <span class="grade-badge" :class="`grade-${basisTarget.grade}`">{{ basisTarget.gradeLabel }}</span>
            {{ basisTarget.gradeSource || '自动判定' }}
          </dd>
          <dt>超限倍数 / 超差</dt>
          <dd>
            {{ basisTarget.ratio === null ? '—' : `${basisTarget.ratio.toFixed(2)} 倍` }}
            <span v-if="basisTarget.exceed !== null">（超出 {{ basisTarget.exceed.toFixed(2) }}m）</span>
          </dd>
          <dt>水位变幅</dt>
          <dd>{{ basisTarget.amplitude }} m（与同站上一条记录相比）</dd>
          <dt v-if="basisTarget.warningFill">警戒水位回填</dt>
          <dd v-if="basisTarget.warningFill">{{ basisTarget.warningFill }}</dd>
          <dt v-if="basisTarget.guaranteeFill">保证水位回填</dt>
          <dd v-if="basisTarget.guaranteeFill">{{ basisTarget.guaranteeFill }}</dd>
          <dt v-if="basisTarget.manualOpinion">人工复核意见</dt>
          <dd v-if="basisTarget.manualOpinion" class="manual-opinion">{{ basisTarget.manualOpinion }}</dd>
          <dt>判定依据全文</dt>
          <dd class="basis-text">{{ basisTarget.basis || '尚未回放判定。' }}</dd>
          <dt>联动记录</dt>
          <dd>
            <template v-if="basisTarget.linkedWarningCode">
              预警台账 {{ basisTarget.linkedWarningCode }}；巡检事项 {{ basisTarget.linkedInspectionCode }}
            </template>
            <span v-else>暂无（未超限时不生成）</span>
          </dd>
        </dl>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="basisTarget = null">知道了</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  backfillThresholds,
  listGradeRows,
  manualReview,
  replayAll,
  replayGrade,
  type BackfillSummary,
  type GradeRowView,
  type ReplayResult,
} from '@/api/grading-service'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { GRADE_LABEL, REVIEWABLE_GRADES, type GradeKey } from '@/data/water-grading'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('waterlevel')
const columns = ["记录编号", "站点编号", "观测时间", "当前水位", "警戒水位", "保证水位", "水位变幅", "记录状态"]
const actions = ["提交审核", "确认通过", "标记异常"]
const statuses = ["已采集", "待审核", "已通过", "异常值"]
const stats = [{ label: "今日采集数", value: 0 }, { label: "超警戒站次", value: 0 }, { label: "待审核记录", value: 0 }]

const tab = ref<'records' | 'grading'>('grading')

// ---- 原始记录页签 ----
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

// ---- 判定台 ----
const gradeRows = ref<GradeRowView[]>([])
const backfillBanner = ref<BackfillSummary['details']>([])
const gradingMessage = ref('')
const gradingOk = ref(true)
const reviewTarget = ref<GradeRowView | null>(null)
const reviewGrade = ref<GradeKey>('orange')
const reviewOpinion = ref('')
const reviewError = ref('')
const basisTarget = ref<GradeRowView | null>(null)

const reviewableGrades = REVIEWABLE_GRADES.map((key) => ({ key, label: GRADE_LABEL[key] }))

const gradeStats = computed(() => ({
  pending: gradeRows.value.filter((item) => item.grade === 'unknown').length,
  orange: gradeRows.value.filter((item) => item.grade === 'orange').length,
  red: gradeRows.value.filter((item) => item.grade === 'red').length,
  manual: gradeRows.value.filter((item) => item.gradeSource === '人工复核').length,
  locked: gradeRows.value.filter((item) => !item.stationRunning).length,
}))

function amplitudeClass(text: string): string {
  if (text.startsWith('+')) {
    return 'amp-up'
  }
  if (text.startsWith('-')) {
    return 'amp-down'
  }
  return ''
}

function switchTab(next: 'records' | 'grading') {
  tab.value = next
  gradingMessage.value = ''
  if (next === 'records') {
    reload()
  } else {
    refreshGrading()
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
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
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '水位监测列表读取失败'
  }
}

function showReplayResults(results: ReplayResult[]) {
  const failed = results.filter((item) => !item.ok)
  const changed = results.filter((item) => item.ok && item.changed)
  gradingOk.value = failed.length === 0
  if (results.length === 1) {
    gradingMessage.value = results[0].ok ? results[0].message : `回放被拒：${results[0].message}`
    return
  }
  const parts = [`共回放 ${results.length} 条，成功 ${changed.length} 条`]
  if (failed.length) {
    parts.push(
      `跳过 ${failed.length} 条：${failed.map((item) => `${item.recordNo}（${item.message}）`).join('；')}`,
    )
  }
  gradingMessage.value = parts.join('，')
}

function refreshGrading() {
  gradeRows.value = listGradeRows()
}

function replayOne(item: GradeRowView) {
  const result = replayGrade(item.id)
  showReplayResults([result])
  refreshGrading()
}

function batchReplay() {
  const results = replayAll()
  showReplayResults(results)
  refreshGrading()
}

function openReview(item: GradeRowView) {
  reviewTarget.value = item
  reviewGrade.value = item.grade === 'unknown' ? 'orange' : item.grade
  reviewOpinion.value = item.manualOpinion
  reviewError.value = ''
}

function closeReview() {
  reviewTarget.value = null
  reviewError.value = ''
}

function submitReview() {
  if (!reviewTarget.value) {
    return
  }
  const result = manualReview({
    id: reviewTarget.value.id,
    grade: reviewGrade.value,
    opinion: reviewOpinion.value,
  })
  if (!result.ok) {
    reviewError.value = result.message
    return
  }
  closeReview()
  showReplayResults([result])
  refreshGrading()
}

function openBasis(item: GradeRowView) {
  basisTarget.value = item
}

onMounted(() => {
  // 进入判定台先回填历史缺值，再回放预置结论，保证台账联动可见。
  const summary = backfillThresholds()
  backfillBanner.value = summary.details
  refreshGrading()
})
</script>
