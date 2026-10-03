// 临时联调脚本：在 Node 里模拟 localStorage，跑判定台全链路。
const store = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
  },
}

import { SEED_ROWS } from '../src/data/seed'
import { backfillThresholds, listGradeRows, manualReview, replayAll, replayGrade } from '../src/api/grading-service'
import { gradeWaterLevel, toNumber } from '../src/data/water-grading'
import { listRows, saveRows } from '../src/data/local-store'

let failures = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    console.log(`  ✅ ${name}`)
  } else {
    failures += 1
    console.error(`  ❌ ${name} ${extra}`)
  }
}

function warningRows() {
  return listRows('warning')
}
function inspectionRows() {
  return listRows('inspection')
}
function waterRows() {
  return listRows('waterlevel')
}
function findBySource(rows: any[], key: string) {
  return rows.find((r) => r['来源记录'] === key)
}

// 从种子初始化
for (const [key, rows] of Object.entries(SEED_ROWS)) {
  saveRows(key, JSON.parse(JSON.stringify(rows)))
}

console.log('\n[纯规则]')
check('红：≥保证', gradeWaterLevel({ level: 11, warning: 9, guarantee: 10.5, attention: 8.5 }).key === 'red')
check('橙：≥警戒', gradeWaterLevel({ level: 9.5, warning: 9, guarantee: 10.5, attention: 8.5 }).key === 'orange')
check('蓝：≥关注线', gradeWaterLevel({ level: 8.6, warning: 9, guarantee: 10.5, attention: 8.5 }).key === 'blue')
check('正常：低于关注', gradeWaterLevel({ level: 8, warning: 9, guarantee: 10.5, attention: 8.5 }).key === 'normal')
check('缺值待判定', gradeWaterLevel({ level: null, warning: 9, guarantee: 10.5, attention: 8.5 }).key === 'unknown')
const red = gradeWaterLevel({ level: 11, warning: 9, guarantee: 10.5, attention: 8.5 })
check('倍数 11/10.5≈1.05', red.ratio === 1.05 && red.exceed === 0.5, `got ${red.ratio}`)
check('占位文字视为缺值', toNumber('水位监测样例1') === null && toNumber('10.70m') === 10.7)

console.log('\n[回填]')
const sum = backfillThresholds()
check('回填 2 条', sum.filled === 2, `got ${sum.filled}`)
const wl3 = waterRows().find((r) => r['记录编号'] === 'WATE-0003')!
const wl4 = waterRows().find((r) => r['记录编号'] === 'WATE-0004')!
check('0003 警戒回填 9.80', String(wl3['警戒水位']) === '9.80')
check('0003 保证回填 11.00', String(wl3['保证水位']) === '11.00')
check('回填来源留痕', String(wl4['警戒回填来源']).includes('WARN-002'))
const sum2 = backfillThresholds()
check('回填幂等（第二次 0 条）', sum2.filled === 0)

console.log('\n[批量回放]')
const results = replayAll()
const byNo = Object.fromEntries(results.map((r) => [r.recordNo, r]))
check('0001 正常', byNo['WATE-0001'].ok && /正常/.test(byNo['WATE-0001'].message))
check('0002 橙', /警戒（橙）/.test(byNo['WATE-0002'].message))
check('0003 橙（回填后）', /警戒（橙）/.test(byNo['WATE-0003'].message))
check('0004 红', /保证（红）/.test(byNo['WATE-0004'].message))
check('0005 正常', /正常/.test(byNo['WATE-0005'].message))
check('0006 蓝（关注线）', /关注（蓝）/.test(byNo['WATE-0006'].message))
check('0007 停用站被拒', !byNo['WATE-0007'].ok && /暂停运行/.test(byNo['WATE-0007'].message))
check('0008 人工蓝保留', /关注（蓝）/.test(byNo['WATE-0008'].message))

const view = Object.fromEntries(listGradeRows().map((r) => [r.recordNo, r]))
check('0002 倍数 1.04', view['WATE-0002'].ratio === 1.04, `got ${view['WATE-0002'].ratio}`)
check('0002 变幅 +1.16', view['WATE-0002'].amplitude === '+1.16', `got ${view['WATE-0002'].amplitude}`)
check('0001 变幅首条', view['WATE-0001'].amplitude === '首条')
check('0008 变幅 +1.34', view['WATE-0008'].amplitude === '+1.34', `got ${view['WATE-0008'].amplitude}`)
check('0007 标记停用', view['WATE-0007'].stationRunning === false)

console.log('\n[联动生成]')
check('生成 OVWL-WATE-0002', !!findBySource(warningRows(), 'waterlevel:2'))
check('生成 OVWL-WATE-0004', !!findBySource(warningRows(), 'waterlevel:4'))
check('蓝级不生成台账', !findBySource(warningRows(), 'waterlevel:6'))
check('巡检 XJOL-WATE-0002 待巡检', findBySource(inspectionRows(), 'waterlevel:2')?.status === '待巡检')
const ol8 = findBySource(warningRows(), 'waterlevel:8')!
check('0008 台账保留且为解除态', ol8['配置编号'] === 'OVWL-WATE-0008' && ol8['生效状态'] === '超限解除')
const warnCountBefore = warningRows().length
const inspCountBefore = inspectionRows().length

console.log('\n[重复回放幂等]')
replayGrade(2)
replayGrade(4)
check('台账不新增', warningRows().length === warnCountBefore, `${warningRows().length} vs ${warnCountBefore}`)
check('巡检不新增', inspectionRows().length === inspCountBefore)
const msg2 = replayGrade(2).message
check('提示未重复生成', /未重复生成/.test(msg2), msg2)

console.log('\n[人工复核优先]')
const review = manualReview({ id: 2, grade: 'normal', opinion: '现场确认退水，解除警戒' })
check('复核成功', review.ok, review.message)
const v2 = listGradeRows().find((r) => r.recordNo === 'WATE-0002')!
check('最终级别为正常(人工)', v2.grade === 'normal' && v2.gradeSource === '人工复核')
check('依据保留冲突双方', /自动判定为警戒（橙）/.test(v2.basis) && /人工结论优先/.test(v2.basis))
const ol2 = findBySource(warningRows(), 'waterlevel:2')!
check('联动台账置解除', ol2['生效状态'] === '超限解除')
check('联动巡检置已处置', findBySource(inspectionRows(), 'waterlevel:2')?.status === '已处置')
const noOpinion = manualReview({ id: 1, grade: 'red', opinion: '  ' })
check('意见必填', !noOpinion.ok)

console.log('\n[停用站禁止改判]')
const stop = manualReview({ id: 7, grade: 'red', opinion: '尝试改判' })
check('人工复核被拒', !stop.ok && /暂停运行/.test(stop.message))
check('0007 仍未判定', listGradeRows().find((r) => r.recordNo === 'WATE-0007')!.grade === 'unknown')

console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}`)
process.exit(failures === 0 ? 0 : 1)
