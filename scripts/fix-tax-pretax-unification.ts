/**
 * 订正脚本：销售金额税口径统一为「税前」(A-1 + A-2)
 *
 * 背景：commit 562df3b 把金额口径翻转为税前，但历史数据混存：
 *   - Order.totalAmount：改单(PUT)曾写含税(commit 3be3e14 起)，下单/加行写税前 → 混存
 *   - OrderLine.taxRate：历史存小数(0.23)，新行存百分数(23) → 混存
 *   - OrderLine.subtotal：应恒等于 unitPrice×orderedQty(税前)
 *
 * 已确认(代码考古)：unitPrice 与 subtotal 一直是税前(server-pricing 从不乘税)，
 * 故订正无需对 unitPrice 除税。本脚本三项订正均为幂等、确定性：
 *   1. OrderLine.taxRate：0<x<1 → x×100(归一百分数)；其余(0 或 ≥1)不动
 *   2. OrderLine.subtotal：重算 = round(unitPrice×orderedQty, 2)
 *   3. Order.totalAmount：重算 = Σ round(unitPrice×orderedQty, 2)(税前)
 *
 * 判别新旧：IE VAT 档位 0/4.8/9/13.5/23，小数区间(0,1)与百分数区间[4.8,23]无重叠，
 * 判别无歧义(taxRate==0 两口径同值，无需改)。
 *
 * 用法：
 *   node --import tsx -r dotenv/config scripts/fix-tax-pretax-unification.ts dotenv_config_path=.env.local            # dry-run（只读统计，绝不写库）
 *   node --import tsx -r dotenv/config scripts/fix-tax-pretax-unification.ts dotenv_config_path=.env.local --apply    # 事务写库
 */
import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'

const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })

const APPLY = process.argv.includes('--apply')
const n = (v: unknown) => Number(v ?? 0)
const r2 = (x: number) => Math.round(x * 100) / 100
const IE_VAT_PCT = [0, 4.8, 9, 13.5, 23]

async function main() {
  console.log(`\n=== 税口径统一订正 (${APPLY ? 'APPLY 写库' : 'DRY-RUN 只读'}) ===\n`)

  const orders = await prisma.order.findMany({
    select: {
      id: true, code: true, totalAmount: true,
      lines: { select: { id: true, unitPrice: true, orderedQty: true, taxRate: true, subtotal: true } },
    },
  })
  const allLines = orders.flatMap(o => o.lines)
  console.log(`订单 ${orders.length} 单，订单行 ${allLines.length} 行\n`)

  // ---- 1) taxRate 分布 ----
  const bucket = { zero: 0, fractionOld: 0, pctNew: 0, anomaly: [] as number[] }
  for (const l of allLines) {
    if (l.taxRate == null) { bucket.zero++; continue }
    const t = n(l.taxRate)
    if (t === 0) bucket.zero++
    else if (t > 0 && t < 1) bucket.fractionOld++
    else if (t >= 1) {
      bucket.pctNew++
      if (t > 0 && t < 4.8 && t >= 1) bucket.anomaly.push(t) // 落在 [1,4.8) 的异常值
    }
  }
  console.log('【taxRate 分布】')
  console.log(`  = 0 / null                : ${bucket.zero}  (无需改)`)
  console.log(`  小数 0<x<1 (旧,将×100)    : ${bucket.fractionOld}`)
  console.log(`  百分数 x≥1 (新,不动)      : ${bucket.pctNew}`)
  if (bucket.anomaly.length) console.log(`  ⚠️ 异常值 [1,4.8)         : ${bucket.anomaly.length} 行 → 样本 ${[...new Set(bucket.anomaly)].slice(0, 10).join(', ')}`)
  const distinctRates = [...new Set(allLines.map(l => n(l.taxRate)))].sort((a, b) => a - b)
  console.log(`  实际出现的 taxRate 取值   : ${distinctRates.join(', ')}\n`)

  // ---- 2) subtotal 漂移 (现值 vs unitPrice×qty) ----
  const subDrift = allLines
    .map(l => ({ id: l.id, cur: n(l.subtotal), calc: r2(n(l.unitPrice) * n(l.orderedQty)), up: n(l.unitPrice), qty: n(l.orderedQty), tr: n(l.taxRate) }))
    .filter(x => Math.abs(x.cur - x.calc) > 0.01)
  console.log(`【OrderLine.subtotal 漂移】不等于 unitPrice×qty 的行：${subDrift.length}`)
  // 关键存疑核验：漂移是否恰好=一个 VAT 倍数(说明历史 subtotal 曾含税)
  let looksTaxIncl = 0
  for (const x of subDrift) {
    if (x.calc > 0) {
      const ratio = x.cur / x.calc
      if (IE_VAT_PCT.some(p => Math.abs(ratio - (1 + p / 100)) < 0.005)) looksTaxIncl++
    }
  }
  console.log(`  其中「现值≈计算值×(1+某VAT档)」(疑似历史含税) : ${looksTaxIncl}  ← 若>0 需人工确认是否 unitPrice/subtotal 曾含税`)
  for (const x of subDrift.slice(0, 15)) console.log(`   line ${x.id}: 现 ${x.cur} vs 算 ${x.calc}  (up=${x.up} qty=${x.qty} tr=${x.tr})`)
  console.log('')

  // ---- 3) Order.totalAmount 漂移 (现值 vs Σ税前 subtotal) ----
  const totDrift = orders.map(o => {
    const preTax = r2(o.lines.reduce((s, l) => s + r2(n(l.unitPrice) * n(l.orderedQty)), 0))
    const incTax = r2(o.lines.reduce((s, l) => {
      const ex = r2(n(l.unitPrice) * n(l.orderedQty))
      const tr = n(l.taxRate)
      const frac = tr > 1 ? tr / 100 : tr
      return s + ex * (1 + frac)
    }, 0))
    return { code: o.code, cur: n(o.totalAmount), preTax, incTax }
  }).filter(x => Math.abs(x.cur - x.preTax) > 0.01)
  const looksIncl = totDrift.filter(x => Math.abs(x.cur - x.incTax) < 0.02).length
  console.log(`【Order.totalAmount 漂移】不等于 Σ税前 subtotal 的订单：${totDrift.length} / ${orders.length}`)
  console.log(`  其中「现值≈Σ含税」(确系被改单写成含税) : ${looksIncl}  ← 这些就是 A-2 混存，重算为税前即订正`)
  console.log(`  其余「现值既非税前也非含税」           : ${totDrift.length - looksIncl}  ← 若>0 需人工看样本`)
  for (const x of totDrift.slice(0, 20)) {
    const tag = Math.abs(x.cur - x.incTax) < 0.02 ? '含税' : '?'
    console.log(`   ${x.code}: 现 ${x.cur}  税前 ${x.preTax}  含税 ${x.incTax}  [${tag}] 差 ${r2(x.cur - x.preTax)}`)
  }
  console.log('')

  if (!APPLY) {
    console.log('=== DRY-RUN 结束，未写任何数据。确认无误后加 --apply 执行订正。===\n')
    return
  }

  // ---- APPLY：事务订正 ----
  console.log('=== APPLY：开始写库 ===')
  let lineUpd = 0, orderUpd = 0
  await prisma.$transaction(async (tx) => {
    for (const o of orders) {
      let preTaxTotal = 0
      for (const l of o.lines) {
        const tr = n(l.taxRate)
        const newTax = tr > 0 && tr < 1 ? r2(tr * 100) : tr
        const newSub = r2(n(l.unitPrice) * n(l.orderedQty))
        preTaxTotal += newSub
        if (Math.abs(newTax - tr) > 1e-9 || Math.abs(newSub - n(l.subtotal)) > 0.01) {
          await tx.orderLine.update({ where: { id: l.id }, data: { taxRate: newTax, subtotal: newSub } })
          lineUpd++
        }
      }
      preTaxTotal = r2(preTaxTotal)
      if (Math.abs(preTaxTotal - n(o.totalAmount)) > 0.01) {
        await tx.order.update({ where: { id: o.id }, data: { totalAmount: preTaxTotal } })
        orderUpd++
      }
    }
  }, { timeout: 120_000 })
  console.log(`✅ 订正完成：OrderLine 更新 ${lineUpd} 行，Order.totalAmount 更新 ${orderUpd} 单。\n`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
