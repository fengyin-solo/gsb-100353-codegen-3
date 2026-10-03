import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

// —— 水位分级判定台 ————————————————————————————————
// 预警级别取值：正常 / 超警戒 / 超保证，人工复核结论也从这里选。
export const WARNING_LEVELS = ['正常', '超警戒', '超保证']

// 站点处于这些状态时视为已停用：名下水位记录不允许再改判。
const STATION_LOCKED_STATUSES = ['暂停运行', '已撤销']

export type JudgeWaterLevelInput = {
  manualLevel?: string
  manualOpinion?: string
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
}

function nextRowId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nowText(): string {
  const now = new Date()
  const pad = (unit: number) => String(unit).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

// 站点现有的水位阈值配置：预警阈值台账里监测类型为「水位」的配置（不含超限记录），优先取已生效的那条。
function stationLevelConfig(stationCode: string): EntryRow | undefined {
  const configs = listRows('warning').filter(
    (row) =>
      String(row.站点编号) === stationCode &&
      String(row.监测类型) === '水位' &&
      row.记录类型 !== '超限记录',
  )
  return configs.find((row) => String(row.status) === '已生效') ?? configs[0]
}

// 分级判定：按当前水位与警戒、保证水位定级；人工复核结论与保证水位判定冲突时以人工为准。
// 超限结论会联动预警阈值台账（新增超限记录）并生成巡检事项；同一记录重复回放不会重复生成。
export function judgeWaterLevel(id: number, input: JudgeWaterLevelInput = {}): ActionResult {
  const rows = listRows('waterlevel')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的水位记录` }
  }
  const record = rows[index]
  const recordCode = String(record.记录编号 ?? '')

  const station = listRows('station').find(
    (row) => String(row.站点编号) === String(record.站点编号),
  )
  if (!station) {
    return { ok: false, message: `水位记录 ${recordCode} 的站点「${record.站点编号}」未登记，无法判定` }
  }
  if (STATION_LOCKED_STATUSES.includes(String(station.status))) {
    return { ok: false, message: `站点「${station.站点编号}」已${station.status}，不允许改判` }
  }

  const current = toFiniteNumber(record.当前水位)
  if (current === null) {
    return { ok: false, message: `水位记录 ${recordCode} 的当前水位不是有效数值，无法判定` }
  }

  const basis: string[] = []
  const updated: EntryRow = { ...record }

  // 历史记录缺少警戒值时，按站点现有配置回填（警戒水位取黄色阈值，保证水位取橙色阈值）。
  let warningLevel = toFiniteNumber(record.警戒水位)
  if (warningLevel === null) {
    const config = stationLevelConfig(String(station.站点编号))
    const fallback = config ? toFiniteNumber(config.黄色阈值) : null
    if (fallback === null) {
      return { ok: false, message: `水位记录 ${recordCode} 缺少警戒水位，且站点没有可用的水位阈值配置，无法回填` }
    }
    warningLevel = fallback
    updated.警戒水位 = fallback
    basis.push(`警戒水位缺失，按站点现有配置「${String(config?.配置编号 ?? '')}」回填为 ${fallback.toFixed(2)}m`)
  }
  let guaranteeLevel = toFiniteNumber(record.保证水位)
  if (guaranteeLevel === null) {
    const config = stationLevelConfig(String(station.站点编号))
    const fallback = config ? toFiniteNumber(config.橙色阈值) : null
    if (fallback !== null) {
      guaranteeLevel = fallback
      updated.保证水位 = fallback
      basis.push(`保证水位缺失，按站点现有配置「${String(config?.配置编号 ?? '')}」回填为 ${fallback.toFixed(2)}m`)
    }
  }

  // 水位变幅：与同站点上一条观测记录相比。
  const previous = rows
    .filter(
      (row) =>
        Number(row.id) !== id &&
        String(row.站点编号) === String(record.站点编号) &&
        String(row.观测时间 ?? '') !== '' &&
        String(row.观测时间 ?? '') < String(record.观测时间 ?? '') &&
        toFiniteNumber(row.当前水位) !== null,
    )
    .sort((a, b) => String(b.观测时间).localeCompare(String(a.观测时间)))[0]
  const amplitude = previous ? round2(current - (toFiniteNumber(previous.当前水位) as number)) : 0
  updated.水位变幅 = amplitude
  basis.push(
    previous
      ? `水位变幅 ${signed(amplitude)}m（较 ${String(previous.记录编号)}）`
      : '无前期观测记录，水位变幅按 +0.00m 计',
  )

  // 自动判定：达到保证水位为超保证，达到警戒水位为超警戒，其余为正常。
  let autoLevel = '正常'
  if (guaranteeLevel !== null && current >= guaranteeLevel) {
    autoLevel = '超保证'
  } else if (current >= warningLevel) {
    autoLevel = '超警戒'
  }
  basis.push(
    autoLevel === '正常'
      ? `自动判定：当前水位 ${current.toFixed(2)}m 低于警戒水位 ${warningLevel.toFixed(2)}m`
      : autoLevel === '超保证'
        ? `自动判定：当前水位 ${current.toFixed(2)}m 达到保证水位 ${(guaranteeLevel as number).toFixed(2)}m`
        : `自动判定：当前水位 ${current.toFixed(2)}m 达到警戒水位 ${warningLevel.toFixed(2)}m`,
  )

  // 人工复核：与保证水位判定冲突时以人工结论优先，结论与意见一并写进判定依据。
  const manualLevel = (input.manualLevel ?? '').trim()
  const manualOpinion = (input.manualOpinion ?? '').trim()
  let finalLevel = autoLevel
  if (manualLevel !== '') {
    if (!WARNING_LEVELS.includes(manualLevel)) {
      return { ok: false, message: `人工复核结论「${manualLevel}」无效，只能是 ${WARNING_LEVELS.join('、')}` }
    }
    finalLevel = manualLevel
    basis.push(
      manualLevel === autoLevel
        ? `人工复核结论「${manualLevel}」与自动判定一致${manualOpinion ? `；复核意见：${manualOpinion}` : ''}`
        : `人工复核优先：人工结论「${manualLevel}」覆盖自动判定「${autoLevel}」${manualOpinion ? `；复核意见：${manualOpinion}` : ''}`,
    )
  }
  updated.人工复核结论 = manualLevel
  updated.复核意见 = manualOpinion

  // 超限倍数：当前水位相对所超限值的倍数，正常时不计。
  let multiple: number | '' = ''
  if (finalLevel !== '正常') {
    const limit = finalLevel === '超保证' && guaranteeLevel !== null ? guaranteeLevel : warningLevel
    multiple = round2(current / limit)
    basis.push(
      `超限 ${multiple.toFixed(2)} 倍（当前水位 ÷ ${finalLevel === '超保证' && guaranteeLevel !== null ? '保证' : '警戒'}水位）`,
    )
  }

  updated.预警级别 = finalLevel
  updated.超限倍数 = multiple
  updated.判定时间 = nowText()
  updated.判定依据 = basis.join('；')
  updated.abnormal = finalLevel !== '正常'
  const nextRows = [...rows]
  nextRows[index] = updated
  saveRows('waterlevel', nextRows)

  // 超限联动：预警阈值台账新增一条超限记录，并生成一项巡检事项；按来源记录编号判重，重复回放不重复生成。
  const linkage: string[] = []
  if (finalLevel !== '正常') {
    const warningRows = listRows('warning')
    if (warningRows.some((row) => row.记录类型 === '超限记录' && String(row.关联水位记录) === recordCode)) {
      linkage.push('预警台账已存在该记录的超限记录，未重复生成')
    } else {
      const config = stationLevelConfig(String(station.站点编号))
      const seq = warningRows.filter((row) => row.记录类型 === '超限记录').length + 1
      const exceedRow: EntryRow = {
        id: nextRowId(warningRows),
        status: '已生效',
        pending: false,
        abnormal: true,
        记录类型: '超限记录',
        配置编号: `WARN-EX-${String(seq).padStart(4, '0')}`,
        站点编号: String(station.站点编号),
        监测类型: '水位超限',
        蓝色阈值: config?.蓝色阈值 ?? '',
        黄色阈值: config?.黄色阈值 ?? warningLevel,
        橙色阈值: config?.橙色阈值 ?? guaranteeLevel ?? '',
        红色阈值: config?.红色阈值 ?? '',
        生效状态: '超限记录',
        关联水位记录: recordCode,
        预警级别: finalLevel,
        超限倍数: multiple,
        水位变幅: amplitude,
        判定依据: String(updated.判定依据),
      }
      saveRows('warning', [...warningRows, exceedRow])
      linkage.push(`预警台账已新增超限记录「${exceedRow.配置编号}」`)
    }

    const inspectionRows = listRows('inspection')
    if (inspectionRows.some((row) => String(row.来源记录编号 ?? '') === recordCode)) {
      linkage.push('巡检事项已存在，未重复生成')
    } else {
      const seq = inspectionRows.filter((row) =>
        String(row.记录编号 ?? '').startsWith('INSP-EX-'),
      ).length + 1
      const inspectionRow: EntryRow = {
        id: nextRowId(inspectionRows),
        status: '待巡检',
        pending: true,
        abnormal: false,
        记录编号: `INSP-EX-${String(seq).padStart(4, '0')}`,
        站点编号: String(station.站点编号),
        巡检日期: nowText().slice(0, 10),
        巡检人员: '待指派',
        检查项目: `水位${finalLevel}现场复核`,
        发现问题: `${recordCode} ${finalLevel}，超限 ${multiple} 倍`,
        处理措施: '待处置',
        巡检状态: '待巡检',
        来源记录编号: recordCode,
      }
      saveRows('inspection', [...inspectionRows, inspectionRow])
      linkage.push(`已生成巡检事项「${inspectionRow.记录编号}」`)
    }
  }

  const multipleText = multiple === '' ? '' : `，超限 ${multiple} 倍`
  const linkageText = linkage.length > 0 ? `；${linkage.join('；')}` : ''
  return { ok: true, message: `判定完成：${recordCode} 判定为「${finalLevel}」${multipleText}${linkageText}` }
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
