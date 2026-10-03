/**
 * 水位预警分级纯逻辑：不碰存储与 DOM，回放判定、人工复核都走这里，规则只有一份。
 * 分级口径：以警戒水位、保证水位两条控制线为主，辅以阈值台账里的蓝色关注线。
 */
import type { EntryRow } from './types'

export type GradeKey = 'unknown' | 'normal' | 'blue' | 'orange' | 'red'

export const GRADE_LABEL: Record<GradeKey, string> = {
  unknown: '待判定',
  normal: '正常',
  blue: '关注（蓝）',
  orange: '警戒（橙）',
  red: '保证（红）',
}

/** 可改判的有效级别（待判定不是结论，不能由人工直接选）。 */
export const REVIEWABLE_GRADES: GradeKey[] = ['normal', 'blue', 'orange', 'red']

export interface GradeInput {
  level: number | null
  warning: number | null
  guarantee: number | null
  attention: number | null
}

export interface GradeResult {
  key: GradeKey
  label: string
  /** 是否越过警戒/保证水位，决定要不要联动台账与巡检。 */
  overLimit: boolean
  /** 命中的判定阈值与名称。 */
  threshold: number | null
  thresholdName: string
  /** 超限倍数 = 当前水位 / 命中阈值。 */
  ratio: number | null
  /** 超差值（米）。 */
  exceed: number | null
  /** 判定依据原文。 */
  basis: string
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export function formatSigned(value: number | null): string {
  if (value === null) {
    return '—'
  }
  const rounded = round2(value)
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}`
}

/** 只接受真正的数值或「105.20m」这类带单位文本，占位文字一律视为缺值。 */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (/^-?\d+(\.\d+)?$/.test(text)) {
      return Number(text)
    }
    const withUnit = text.match(/^(-?\d+(?:\.\d+)?)\s*(m|米)?$/i)
    if (withUnit) {
      return Number(withUnit[1])
    }
  }
  return null
}

function fmt(value: number | null): string {
  return value === null ? '缺失' : value.toFixed(2)
}

/** 依据当前水位与警戒、保证（含关注线）判定预警级别。 */
export function gradeWaterLevel(input: GradeInput): GradeResult {
  const { level, warning, guarantee, attention } = input
  if (level === null || warning === null || guarantee === null) {
    return {
      key: 'unknown',
      label: GRADE_LABEL.unknown,
      overLimit: false,
      threshold: null,
      thresholdName: '',
      ratio: null,
      exceed: null,
      basis: `当前水位/警戒水位/保证水位存在缺失（当前 ${fmt(level)}m、警戒 ${fmt(
        warning,
      )}m、保证 ${fmt(guarantee)}m），无法自动判定，请先补齐阈值或人工复核。`,
    }
  }

  if (level >= guarantee) {
    const exceed = round2(level - guarantee)
    return {
      key: 'red',
      label: GRADE_LABEL.red,
      overLimit: true,
      threshold: guarantee,
      thresholdName: '保证水位',
      ratio: round2(level / guarantee),
      exceed,
      basis: `当前水位 ${level.toFixed(2)}m ≥ 保证水位 ${guarantee.toFixed(
        2,
      )}m（同时高于警戒水位 ${warning.toFixed(2)}m），超出保证水位 ${exceed.toFixed(
        2,
      )}m，超限倍数 ${(level / guarantee).toFixed(2)} 倍，自动判定为保证（红）级。`,
    }
  }

  if (level >= warning) {
    const exceed = round2(level - warning)
    return {
      key: 'orange',
      label: GRADE_LABEL.orange,
      overLimit: true,
      threshold: warning,
      thresholdName: '警戒水位',
      ratio: round2(level / warning),
      exceed,
      basis: `当前水位 ${level.toFixed(2)}m 位于警戒水位 ${warning.toFixed(2)}m 与保证水位 ${guarantee.toFixed(
        2,
      )}m 之间，超出警戒水位 ${exceed.toFixed(2)}m，超限倍数 ${(level / warning).toFixed(
        2,
      )} 倍，自动判定为警戒（橙）级。`,
    }
  }

  if (attention !== null && level >= attention) {
    return {
      key: 'blue',
      label: GRADE_LABEL.blue,
      overLimit: false,
      threshold: attention,
      thresholdName: '蓝色关注线',
      ratio: null,
      exceed: null,
      basis: `当前水位 ${level.toFixed(2)}m 低于警戒水位 ${warning.toFixed(
        2,
      )}m，但已达到蓝色关注线 ${attention.toFixed(
        2,
      )}m，自动判定为关注（蓝）级，未超警戒/保证水位。`,
    }
  }

  return {
    key: 'normal',
    label: GRADE_LABEL.normal,
    overLimit: false,
    threshold: null,
    thresholdName: '',
    ratio: null,
    exceed: null,
    basis: `当前水位 ${level.toFixed(2)}m 低于警戒水位 ${warning.toFixed(
      2,
    )}m${attention !== null ? `与蓝色关注线 ${attention.toFixed(2)}m` : ''}，自动判定为正常。`,
  }
}

/**
 * 人工复核与自动判定汇合：规则规定人工结论优先，两者冲突或一致都要在依据里留痕。
 */
export function mergeVerdict(
  auto: GradeResult,
  manualKey: GradeKey | null,
  opinion: string,
): { key: GradeKey; label: string; source: '自动判定' | '人工复核'; basis: string } {
  if (manualKey === null || manualKey === 'unknown') {
    return { key: auto.key, label: auto.label, source: '自动判定', basis: auto.basis }
  }
  const manualLabel = GRADE_LABEL[manualKey]
  if (manualKey === auto.key) {
    return {
      key: manualKey,
      label: manualLabel,
      source: '人工复核',
      basis: `${auto.basis} 人工复核意见：「${opinion}」，复核结论与自动判定一致，维持${manualLabel}。`,
    }
  }
  return {
    key: manualKey,
    label: manualLabel,
    source: '人工复核',
    basis: `${auto.basis} 人工复核意见：「${opinion}」，复核结论为${manualLabel}，与自动判定的${auto.label}冲突。按“人工结论优先”规则，最终预警级别以人工复核${manualLabel}为准。`,
  }
}

export interface AmplitudeResult {
  value: number | null
  previousTime: string
  previousLevel: number | null
}

/** 水位变幅 = 与同站点观测时间最近的上一条记录之差；首条记录无变幅。 */
export function computeAmplitude(scope: EntryRow[], current: EntryRow): AmplitudeResult {
  const station = String(current['站点编号'] ?? '')
  const ownTime = String(current['观测时间'] ?? '')
  const previous = scope
    .filter((row) => String(row['站点编号'] ?? '') === station)
    .filter((row) => String(row['观测时间'] ?? '') < ownTime)
    .sort((a, b) => String(a['观测时间']).localeCompare(String(b['观测时间'])))
  if (!previous.length) {
    return { value: null, previousTime: '', previousLevel: null }
  }
  const prev = previous[previous.length - 1]
  const currentLevel = toNumber(current['当前水位'])
  const previousLevel = toNumber(prev['当前水位'])
  if (currentLevel === null || previousLevel === null) {
    return { value: null, previousTime: String(prev['观测时间'] ?? ''), previousLevel }
  }
  return {
    value: round2(currentLevel - previousLevel),
    previousTime: String(prev['观测时间'] ?? ''),
    previousLevel,
  }
}
