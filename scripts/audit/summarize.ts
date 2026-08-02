/**
 * 汇总：读探针结果 → 重算加权完成度 + 生成与 0729 版的逐条差异表
 *
 *   npx tsx scripts/audit/summarize.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import type { CheckResult, Verdict } from './harness'

const RESULTS = 'docs/audit-evidence/20260802-results.json'
const OUT = 'docs/20260802-contract-audit-diff.md'

const MODULE_NAMES: Record<string, string> = {
  '01': 'B2B 移动端订货系统',
  '02': 'Quotation 和销售单',
  '03': '配送与司机电子签收（TMS & POD）',
  '04': '司机绩效与 CMS 分析',
  '05': '日销售管理中心',
  '06': '仓储与库存管理中心',
  '07': '采购管理中心',
  '08': '财务管理中心',
  '09': '数据分析与 BI 决策中心',
  '10': '基础信息与系统管理',
  '11': '系统部署（含双系统并行）',
  '12': '接口与安全',
  '14': 'Odoo 数据平移与导出',
}

const LABEL: Record<Verdict, string> = {
  done: '已完成', partial: '部分完成', missing: '未完成', deferred: '待触发',
}
const SCORE: Record<Verdict, number> = { done: 1, partial: 0.5, missing: 0, deferred: 0 }

const raw = JSON.parse(readFileSync(RESULTS, 'utf8')) as Record<string, CheckResult>
// M01-04 是形态说明，不是合同功能点，不计分
const all = Object.values(raw).sort((a, b) => a.id.localeCompare(b.id))
const contractItems = all.filter(r => r.id !== 'M01-04')

const counted = contractItems.filter(r => r.verdict !== 'deferred')
const deferred = contractItems.filter(r => r.verdict === 'deferred')

const tally: Record<Verdict, number> = { done: 0, partial: 0, missing: 0, deferred: 0 }
for (const r of contractItems) tally[r.verdict]++

const score = counted.reduce((s, r) => s + SCORE[r.verdict], 0)
const pct = (score / counted.length) * 100

// 与 0729 的差异
const upgraded = contractItems.filter(r => r.prev && SCORE[r.prev] < SCORE[r.verdict])
const downgraded = contractItems.filter(r => r.prev && SCORE[r.prev] > SCORE[r.verdict])
const held = contractItems.filter(r => r.prev && r.prev === r.verdict)

// 0729 原始统计
const PREV = { done: 15, partial: 26, missing: 14, deferred: 2 }
const prevScore = PREV.done * 1 + PREV.partial * 0.5
const prevPct = (prevScore / 55) * 100

const lines: string[] = []
lines.push('# 合同功能清单核实 — 0729 人工版 vs 0802 探针版 差异表')
lines.push('')
lines.push(`> 生成时间：2026-08-02　数据源：\`${RESULTS}\`（${all.length} 条探针记录）`)
lines.push('> 判定口径：done=1 分、partial=0.5 分、missing=0 分，分母不含 deferred 条件触发项。')
lines.push('')
lines.push('## 总览')
lines.push('')
lines.push('| | 0729 人工核实 | 0802 探针复核 | 变化 |')
lines.push('|---|---|---|---|')
lines.push(`| 已完成 | ${PREV.done} | ${tally.done} | ${tally.done - PREV.done >= 0 ? '+' : ''}${tally.done - PREV.done} |`)
lines.push(`| 部分完成 | ${PREV.partial} | ${tally.partial} | ${tally.partial - PREV.partial >= 0 ? '+' : ''}${tally.partial - PREV.partial} |`)
lines.push(`| 未完成 | ${PREV.missing} | ${tally.missing} | ${tally.missing - PREV.missing >= 0 ? '+' : ''}${tally.missing - PREV.missing} |`)
lines.push(`| 待触发 | ${PREV.deferred} | ${tally.deferred} | ${tally.deferred - PREV.deferred >= 0 ? '+' : ''}${tally.deferred - PREV.deferred} |`)
lines.push(`| **加权完成度** | **${prevPct.toFixed(0)}%** | **${pct.toFixed(0)}%** | **${pct - prevPct >= 0 ? '+' : ''}${(pct - prevPct).toFixed(0)} 个百分点** |`)
lines.push('')
lines.push(`判定发生变化的共 ${upgraded.length + downgraded.length} 条：升级 ${upgraded.length} 条、降级 ${downgraded.length} 条、维持 ${held.length} 条。`)
lines.push('')

function block(title: string, items: CheckResult[]) {
  if (items.length === 0) return
  lines.push(`## ${title}`)
  lines.push('')
  lines.push('| 编号 | 模块 | 功能点 | 0729 | 0802 | 依据 |')
  lines.push('|---|---|---|---|---|---|')
  for (const r of items) {
    const gap = (r.gap ?? '').replace(/\n/g, ' ').replace(/\|/g, '\\|')
    lines.push(
      `| ${r.id} | ${MODULE_NAMES[r.module] ?? r.module} | ${r.title} | ` +
      `${r.prev ? LABEL[r.prev] : '—'} | **${LABEL[r.verdict]}** | ${gap.slice(0, 300)} |`,
    )
  }
  lines.push('')
}

block('判定升级的条目', upgraded)
block('判定降级的条目', downgraded)

lines.push('## 全量逐条结果')
lines.push('')
for (const mod of Object.keys(MODULE_NAMES)) {
  const items = all.filter(r => r.module === mod)
  if (items.length === 0) continue
  lines.push(`### ${mod} ${MODULE_NAMES[mod]}`)
  lines.push('')
  lines.push('| 编号 | 功能点 | 0729 | 0802 | 缺口 / 说明 |')
  lines.push('|---|---|---|---|---|')
  for (const r of items) {
    const gap = (r.gap ?? '—').replace(/\n/g, ' ').replace(/\|/g, '\\|')
    lines.push(`| ${r.id} | ${r.title} | ${r.prev ? LABEL[r.prev] : '—'} | **${LABEL[r.verdict]}** | ${gap} |`)
  }
  lines.push('')
}

writeFileSync(OUT, lines.join('\n') + '\n')

console.log(`0729: done=${PREV.done} partial=${PREV.partial} missing=${PREV.missing} deferred=${PREV.deferred} → ${prevPct.toFixed(1)}%`)
console.log(`0802: done=${tally.done} partial=${tally.partial} missing=${tally.missing} deferred=${tally.deferred} → ${pct.toFixed(1)}%`)
console.log(`计分条目 ${counted.length} 条（另 ${deferred.length} 条待触发不计分）；探针记录 ${all.length} 条`)
console.log(`升级 ${upgraded.length}｜降级 ${downgraded.length}｜维持 ${held.length}`)
console.log('\n升级:'); for (const r of upgraded) console.log(`  ${r.id} ${r.title}: ${LABEL[r.prev!]} → ${LABEL[r.verdict]}`)
console.log('降级:'); for (const r of downgraded) console.log(`  ${r.id} ${r.title}: ${LABEL[r.prev!]} → ${LABEL[r.verdict]}`)
console.log(`\n已写入 ${OUT}`)
