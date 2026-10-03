/**
 * 分级判定台服务：把纯判定规则接到本地数据层。
 * 涉及四个模块：waterlevel（判定本体）、station（停用拦截）、warning（阈值台账+超限记录）、inspection（巡检事项）。
 */
import { listRows, saveRows } from '@/data/local-store'
import {
  computeAmplitude,
  formatSigned,
  gradeWaterLevel,
  mergeVerdict,
  round2,
  toNumber,
  type GradeKey,
  type GradeResult,
  GRADE_LABEL,
} from '@/data/water-grading'
import type { EntryRow } from '@/data/types'

const WATER = 'waterlevel'
const STATION = 'station'
const WARNING = 'warning'
const INSPECTION = 'inspection'

/** 联动记录的来源键，重复回放凭它找到原记录，只更新不新建。 */
const sourceKey = (row: EntryRow) => `${WATER}:${row.id}`

/** 超限记录的配置编号、巡检事项的记录编号都按水位记录编号确定性生成。 */
const warningCode = (row: EntryRow) => `OVWL-${String(row['记录编号'] ?? row.id)}`
const inspectionCode = (row: EntryRow) => `XJOL-${String(row['记录编号'] ?? row.id)}`

export interface GradeRowView {
  id: number
  recordNo: string
  stationNo: string
  observedAt: string
  level: number | null
  warning: number | null
  guarantee: number | null
  amplitude: string
  grade: GradeKey
  gradeLabel: string
  gradeSource: string
  overLimit: boolean
  ratio: number | null
  exceed: number | null
  basis: string
  manualOpinion: string
  warningFill: string
  guaranteeFill: string
  stationRunning: boolean
  stationStatus: string
  linkedWarningCode: string
  linkedInspectionCode: string
  judgedAt: string
}

export interface BackfillSummary {
  filled: number
  details: { recordNo: string; stationNo: string; fields: string[]; configNo: string }[]
}

export interface ReplayResult {
  recordNo: string
  ok: boolean
  message: string
  changed: boolean
}

function isStationRunning(row: EntryRow): boolean {
  const status = String(row.status ?? '')
  return status !== '暂停运行' && status !== '已撤销'
}

function stationMap(): Map<string, EntryRow> {
  const map = new Map<string, EntryRow>()
  for (const row of listRows(STATION)) {
    map.set(String(row['站点编号'] ?? ''), row)
  }
  return map
}

/** 站点现行配置：只认「水位」类型、已生效的阈值台账，按配置编号倒序取最新一条。 */
function activeWaterConfigs(): Map<string, EntryRow> {
  const map = new Map<string, EntryRow>()
  const rows = listRows(WARNING)
    .filter((row) => String(row['监测类型'] ?? '').includes('水位'))
    .filter((row) => String(row['生效状态'] ?? row.status) === '已生效')
    .sort((a, b) => String(a['配置编号']).localeCompare(String(b['配置编号'])))
  for (const row of rows) {
    map.set(String(row['站点编号'] ?? ''), row)
  }
  return map
}

function fillNote(original: unknown): string {
  return original === undefined || String(original).trim() === '' ? '缺失' : String(original)
}

/**
 * 历史记录缺少警戒/保证水位时，按站点现有配置回填：
 * 黄色阈值=警戒水位，红色阈值=保证水位，蓝色阈值=关注线（关注线仅参与分级，不写水位记录）。
 */
export function backfillThresholds(): BackfillSummary {
  const rows = [...listRows(WATER)]
  const configs = activeWaterConfigs()
  const summary: BackfillSummary = { filled: 0, details: [] }

  rows.forEach((row, index) => {
    const missingWarning = toNumber(row['警戒水位']) === null
    const missingGuarantee = toNumber(row['保证水位']) === null
    if (!missingWarning && !missingGuarantee) {
      return
    }
    const config = configs.get(String(row['站点编号'] ?? ''))
    if (!config) {
      return
    }
    const fields: string[] = []
    const next: EntryRow = { ...row }
    const oldWarning = fillNote(row['警戒水位'])
    const oldGuarantee = fillNote(row['保证水位'])
    if (missingWarning) {
      next['警戒水位'] = String(config['黄色阈值'])
      next['警戒回填来源'] = `阈值台账 ${String(config['配置编号'])} 黄色阈值（回填前：${oldWarning}）`
      fields.push('警戒水位')
    }
    if (missingGuarantee) {
      next['保证水位'] = String(config['红色阈值'])
      next['保证回填来源'] = `阈值台账 ${String(config['配置编号'])} 红色阈值（回填前：${oldGuarantee}）`
      fields.push('保证水位')
    }
    rows[index] = next
    summary.filled += 1
    summary.details.push({
      recordNo: String(next['记录编号']),
      stationNo: String(next['站点编号']),
      fields,
      configNo: String(config['配置编号']),
    })
  })

  if (summary.filled > 0) {
    saveRows(WATER, rows)
  }
  return summary
}

function buildAutoResult(row: EntryRow): GradeResult {
  const configs = activeWaterConfigs()
  const config = configs.get(String(row['站点编号'] ?? ''))
  return gradeWaterLevel({
    level: toNumber(row['当前水位']),
    warning: toNumber(row['警戒水位']),
    guarantee: toNumber(row['保证水位']),
    attention: config ? toNumber(config['蓝色阈值']) : null,
  })
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

/**
 * 联动记录按来源记录 upsert：
 * 超限结论——没有就新建，有就更新；非超限——只更新历史上曾超限生成的记录（置解除/处置），
 * 从未超限过的记录不凭空生成。重复回放因此天然不重复。
 */
function upsertLinked(
  rows: EntryRow[],
  candidate: EntryRow,
  create: boolean,
): { rows: EntryRow[]; created: boolean } {
  const index = rows.findIndex((row) => row['来源记录'] === candidate['来源记录'])
  if (index >= 0) {
    const merged: EntryRow = { ...rows[index], ...candidate, id: rows[index].id }
    const next = [...rows]
    next[index] = merged
    return { rows: next, created: false }
  }
  if (!create) {
    return { rows, created: false }
  }
  candidate.id = nextId(rows)
  return { rows: [...rows, candidate], created: true }
}

/** 按最终级别（人工改判后）计算倍数与超差值，联动台账、巡检共用。 */
function finalMetrics(
  row: EntryRow,
  grade: GradeKey,
): { ratio: number | null; exceed: number | null; thresholdName: string } {
  const level = toNumber(row['当前水位'])
  const warning = toNumber(row['警戒水位'])
  const guarantee = toNumber(row['保证水位'])
  if (level === null) {
    return { ratio: null, exceed: null, thresholdName: '' }
  }
  if (grade === 'red' && guarantee !== null) {
    return { ratio: round2(level / guarantee), exceed: round2(level - guarantee), thresholdName: '保证水位' }
  }
  if (grade === 'orange' && warning !== null) {
    return { ratio: round2(level / warning), exceed: round2(level - warning), thresholdName: '警戒水位' }
  }
  return { ratio: null, exceed: null, thresholdName: '' }
}

/** 写预警阈值台账里的超限记录；回落时不删除，改为停用解除，保留全过程。 */
function syncWarningLedger(row: EntryRow, grade: GradeKey, judgedAt: string): { created: boolean; code: string } {
  const rows = [...listRows(WARNING)]
  const code = warningCode(row)
  const stationNo = String(row['站点编号'] ?? '')
  const configs = activeWaterConfigs()
  const config = configs.get(stationNo)
  const overLimit = grade === 'orange' || grade === 'red'
  const metrics = finalMetrics(row, grade)

  const candidate: EntryRow = {
    id: 0,
    status: overLimit ? '已生效' : '已停用',
    pending: overLimit,
    abnormal: overLimit,
    配置编号: code,
    站点编号: stationNo,
    监测类型: `水位超限-${GRADE_LABEL[grade]}`,
    蓝色阈值: config ? config['蓝色阈值'] : row['警戒水位'],
    黄色阈值: row['警戒水位'],
    橙色阈值: config ? config['橙色阈值'] : '',
    红色阈值: row['保证水位'],
    生效状态: overLimit ? '超限生效' : '超限解除',
    来源记录: sourceKey(row),
    来源记录编号: String(row['记录编号'] ?? row.id),
    当前水位: String(row['当前水位']),
    超限倍数: metrics.ratio === null ? '' : metrics.ratio.toFixed(2),
    判定时间: judgedAt,
    判定依据: String(row['判定依据'] ?? ''),
  }
  const next = upsertLinked(rows, candidate, overLimit)
  saveRows(WARNING, next.rows)
  return { created: next.created, code }
}

/** 超限结论生成巡检事项；回落时更新为已处置。重复回放同一记录不重复生成。 */
function syncInspection(row: EntryRow, grade: GradeKey, judgedAt: string): { created: boolean; code: string } {
  const rows = [...listRows(INSPECTION)]
  const code = inspectionCode(row)
  const stationNo = String(row['站点编号'] ?? '')
  const overLimit = grade === 'orange' || grade === 'red'
  const item =
    grade === 'red' ? '保证水位超限应急巡查' : grade === 'orange' ? '警戒水位超限巡查' : '水位回落复核'
  const ratioText = String(row['超限倍数'] ?? '')
  const overText = String(row['超阈值'] ?? '')

  const candidate: EntryRow = {
    id: 0,
    status: overLimit ? '待巡检' : '已处置',
    pending: overLimit,
    abnormal: overLimit,
    记录编号: code,
    站点编号: stationNo,
    巡检日期: judgedAt.slice(0, 10),
    巡检人员: '待派单',
    检查项目: item,
    发现问题: overLimit
      ? `记录 ${String(row['记录编号'])} 水位 ${String(row['当前水位'])}m，判定${GRADE_LABEL[grade]}${
          overText ? `（${overText}）` : ''
        }，超限倍数 ${ratioText || '—'}。`
      : `记录 ${String(row['记录编号'])} 水位已回落至${GRADE_LABEL[grade]}，解除超限事项。`,
    处理措施: overLimit ? `按 ${item} 要求现场核查并上报。` : '水位回落，超限事项关闭。',
    巡检状态: overLimit ? '待巡检' : '已处置',
    来源记录: sourceKey(row),
    来源记录编号: String(row['记录编号'] ?? row.id),
    判定时间: judgedAt,
  }
  const next = upsertLinked(rows, candidate, overLimit)
  saveRows(INSPECTION, next.rows)
  return { created: next.created, code }
}

function persistVerdict(row: EntryRow, key: GradeKey, source: string, basis: string, judgedAt: string): EntryRow {
  const rows = [...listRows(WATER)]
  const metrics = finalMetrics(row, key)
  const amplitude = computeAmplitude(rows, row)
  const overLimit = key === 'orange' || key === 'red'
  const updated: EntryRow = {
    ...row,
    status: row.status === '异常值' ? '异常值' : '已通过',
    pending: false,
    abnormal: overLimit,
    预警级别: GRADE_LABEL[key],
    判定来源: source,
    判定时间: judgedAt,
    判定依据: basis,
    超限倍数: metrics.ratio === null ? '' : metrics.ratio.toFixed(2),
    超阈值:
      metrics.thresholdName === ''
        ? ''
        : `超${metrics.thresholdName}${metrics.exceed === null ? '' : ` ${metrics.exceed.toFixed(2)}m`}`,
    水位变幅:
      amplitude.value === null
        ? toNumber(row['水位变幅']) !== null
          ? row['水位变幅']
          : '首条记录'
        : amplitude.value.toFixed(2),
    关联台账编号: warningCode(row),
    关联巡检编号: inspectionCode(row),
  }
  const index = rows.findIndex((item) => Number(item.id) === Number(row.id))
  if (index >= 0) {
    rows[index] = updated
    saveRows(WATER, rows)
  }
  return updated
}

function nowText(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 16)
}

/** 回放/重新回放一条记录。重复回放不重复生成联动记录（按来源记录 upsert）。 */
export function replayGrade(id: number): ReplayResult {
  const rows = listRows(WATER)
  const row = rows.find((item) => Number(item.id) === Number(id))
  if (!row) {
    return { recordNo: `#${id}`, ok: false, message: '没有找到这条水位记录', changed: false }
  }
  const station = stationMap().get(String(row['站点编号'] ?? ''))
  if (station && !isStationRunning(station)) {
    return {
      recordNo: String(row['记录编号']),
      ok: false,
      message: `站点 ${String(row['站点编号'])} 已${String(station.status)}，历史判定冻结，不允许改判`,
      changed: false,
    }
  }

  const judgedAt = nowText()
  const auto = buildAutoResult(row)
  const savedKey = (Object.entries(GRADE_LABEL).find(([, label]) => label === row['预警级别'])?.[0] ??
    null) as GradeKey | null
  const verdict = mergeVerdict(
    auto,
    row['判定来源'] === '人工复核' ? savedKey : null,
    String(row['人工复核意见'] ?? ''),
  )
  const updated = persistVerdict(row, verdict.key, verdict.source, verdict.basis, judgedAt)
  const warningLink = syncWarningLedger(updated, verdict.key, judgedAt)
  const inspectionLink = syncInspection(updated, verdict.key, judgedAt)
  const created = warningLink.created || inspectionLink.created

  return {
    recordNo: String(updated['记录编号']),
    ok: true,
    changed: true,
    message: created
      ? `已判定为${verdict.label}，新生成超限记录 ${warningLink.code} 与巡检事项 ${inspectionLink.code}`
      : `已重新判定为${verdict.label}，既有超限记录/巡检事项按来源记录更新，未重复生成`,
  }
}

export interface ReviewInput {
  id: number
  grade: GradeKey
  opinion: string
}

/** 人工复核：结论优先于自动判定，原自动结论与意见一并保留在判定依据中。 */
export function manualReview(input: ReviewInput): ReplayResult {
  const rows = listRows(WATER)
  const row = rows.find((item) => Number(item.id) === Number(input.id))
  if (!row) {
    return { recordNo: `#${input.id}`, ok: false, message: '没有找到这条水位记录', changed: false }
  }
  const opinion = input.opinion.trim()
  if (!opinion) {
    return { recordNo: String(row['记录编号']), ok: false, message: '请填写人工复核意见，判定依据需要留痕', changed: false }
  }
  const station = stationMap().get(String(row['站点编号'] ?? ''))
  if (station && !isStationRunning(station)) {
    return {
      recordNo: String(row['记录编号']),
      ok: false,
      message: `站点 ${String(row['站点编号'])} 已${String(station.status)}，不允许人工改判`,
      changed: false,
    }
  }

  const judgedAt = nowText()
  const auto = buildAutoResult(row)
  const verdict = mergeVerdict(auto, input.grade, opinion)

  const next = [...rows]
  const index = next.findIndex((item) => Number(item.id) === Number(input.id))
  next[index] = { ...row, 人工复核意见: opinion }
  saveRows(WATER, next)

  const updated = persistVerdict(next[index], verdict.key, '人工复核', verdict.basis, judgedAt)
  syncWarningLedger(updated, verdict.key, judgedAt)
  syncInspection(updated, verdict.key, judgedAt)

  return {
    recordNo: String(updated['记录编号']),
    ok: true,
    changed: true,
    message:
      input.grade === auto.key
        ? `人工复核维持${verdict.label}，已写入判定依据并联动台账、巡检`
        : `人工结论优先，已由自动判定的${auto.label}改判为${verdict.label}，冲突与意见已留痕`,
  }
}

/** 批量回放：逐条走同一套逻辑，停用站会被跳过并在结果里说明。 */
export function replayAll(): ReplayResult[] {
  return listRows(WATER).map((row) => replayGrade(Number(row.id)))
}

/** 判定台列表：补齐变幅、站点状态等展示字段。 */
export function listGradeRows(): GradeRowView[] {
  const rows = listRows(WATER)
  const stations = stationMap()
  return rows.map((row) => {
    const station = stations.get(String(row['站点编号'] ?? ''))
    const running = station ? isStationRunning(station) : true
    const amplitude = computeAmplitude(rows, row)
    const auto = buildAutoResult(row)
    const savedKey = (Object.entries(GRADE_LABEL).find(([, label]) => label === row['预警级别'])?.[0] ??
      'unknown') as GradeKey
    return {
      id: Number(row.id),
      recordNo: String(row['记录编号'] ?? ''),
      stationNo: String(row['站点编号'] ?? ''),
      observedAt: String(row['观测时间'] ?? ''),
      level: toNumber(row['当前水位']),
      warning: toNumber(row['警戒水位']),
      guarantee: toNumber(row['保证水位']),
      amplitude:
        amplitude.value === null
          ? toNumber(row['水位变幅']) !== null
            ? formatSigned(toNumber(row['水位变幅']))
            : '首条'
          : formatSigned(amplitude.value),
      grade: savedKey,
      gradeLabel: savedKey === 'unknown' ? '待判定' : String(row['预警级别']),
      gradeSource: String(row['判定来源'] ?? ''),
      overLimit: savedKey === 'orange' || savedKey === 'red',
      ratio: toNumber(row['超限倍数']),
      exceed: auto.exceed,
      basis: String(row['判定依据'] ?? ''),
      manualOpinion: String(row['人工复核意见'] ?? ''),
      warningFill: String(row['警戒回填来源'] ?? ''),
      guaranteeFill: String(row['保证回填来源'] ?? ''),
      stationRunning: running,
      stationStatus: station ? String(station.status) : '未建档',
      linkedWarningCode: String(row['关联台账编号'] ?? ''),
      linkedInspectionCode: String(row['关联巡检编号'] ?? ''),
      judgedAt: String(row['判定时间'] ?? ''),
    }
  })
}
