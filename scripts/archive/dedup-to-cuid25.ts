/**
 * scripts/dedup-to-cuid25.ts
 *
 * 上线前数据去重：把商品/客户/模板收敛到 cuid25 正版，删除旧重复代次(pnum/uuid/cust_n)，
 * 并清空一次性测试交易数据（订单/发票/采购/物流/库存）。用户(登录账号)与配置保留。
 *
 *   node --import tsx -r dotenv/config scripts/dedup-to-cuid25.ts dotenv_config_path=.env.local            # 备份 + dry-run
 *   node --import tsx -r dotenv/config scripts/dedup-to-cuid25.ts dotenv_config_path=.env.local --apply     # 执行
 */
import { createPrismaClient } from '@/lib/prisma-factory'
import fs from 'fs'
import path from 'path'

const prisma = createPrismaClient()
const APPLY = process.argv.includes('--apply')

const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
const isPnum = (id: string) => /^p\d+$/.test(id)
const isTmplPnum = (id: string) => /^tmpl_p\d+$/.test(id)
const isCustN = (id: string) => /^cust_\d+$/.test(id)

async function chunkDelete(label: string, model: any, ids: string[]) {
  let done = 0
  for (let i = 0; i < ids.length; i += 500) {
    const r = await model.deleteMany({ where: { id: { in: ids.slice(i, i + 500) } } })
    done += r.count
  }
  console.log(`  删除 ${label}: ${done}`)
  return done
}

async function main() {
  const TS = process.env.STAMP || 'run'
  // ── 1) 备份关键主数据 ──
  if (APPLY) {
    fs.mkdirSync('backups', { recursive: true })
    const [prods, custs, tmpls] = await Promise.all([
      prisma.product.findMany(),
      prisma.customer.findMany(),
      prisma.productTemplate.findMany(),
    ])
    fs.writeFileSync(`backups/dedup-master-${TS}.json`, JSON.stringify({ products: prods, customers: custs, templates: tmpls }))
    console.log(`✅ 备份: backups/dedup-master-${TS}.json (商品${prods.length} 客户${custs.length} 模板${tmpls.length})`)
  }

  // ── 2) 分类待删 ──
  const prods = await prisma.product.findMany({ select: { id: true } })
  const delProd = prods.filter(p => isPnum(p.id) || isUuid(p.id)).map(p => p.id)
  const tmpls = await prisma.productTemplate.findMany({ select: { id: true } })
  const delTmpl = tmpls.filter(t => isTmplPnum(t.id) || isUuid(t.id)).map(t => t.id)
  const userCustIds = new Set((await prisma.user.findMany({ where: { customerId: { not: null } }, select: { customerId: true } })).map(u => u.customerId!))
  const custs = await prisma.customer.findMany({ select: { id: true } })
  const delCust = custs.filter(c => isCustN(c.id) && !userCustIds.has(c.id)).map(c => c.id)
  const keptCustN = custs.filter(c => isCustN(c.id) && userCustIds.has(c.id)).length

  console.log('\n── 待删重复代次 ──')
  console.log(`  商品: ${delProd.length} / ${prods.length}（保留 cuid25 ${prods.length - delProd.length}）`)
  console.log(`  模板: ${delTmpl.length} / ${tmpls.length}（保留 ${tmpls.length - delTmpl.length}）`)
  console.log(`  客户: ${delCust.length} / ${custs.length}（保留 ${custs.length - delCust.length}，其中因被用户引用而保留的 cust_n: ${keptCustN}）`)

  // ── 3) 一次性测试交易数据（清空） ──
  const txTables: [string, any][] = [
    ['orderLine', prisma.orderLine], ['orderDiscrepancy', prisma.orderDiscrepancy], ['orderAuditLog', prisma.orderAuditLog],
    ['invoice', prisma.invoice], ['creditNoteLine', prisma.creditNoteLine], ['creditNote', prisma.creditNote], ['statement', prisma.statement],
    ['stockMove', prisma.stockMove], ['lot', prisma.lot],
    ['deliverySlip', prisma.deliverySlip], ['trip', prisma.trip], ['pickingWave', prisma.pickingWave],
    ['purchaseOrderLine', prisma.purchaseOrderLine], ['purchaseOrder', prisma.purchaseOrder], ['purchaseRecord', prisma.purchaseRecord],
    ['purchaseSuggestion', prisma.purchaseSuggestion], ['goodsReceipt', prisma.goodsReceipt], ['vendorBill', prisma.vendorBill],
    ['order', prisma.order],
  ]
  console.log('\n── 待清空交易表 ──')
  for (const [name, model] of txTables) {
    const c = await (model as any).count().catch(() => -1)
    if (c > 0) console.log(`  ${name}: ${c}`)
  }

  if (!APPLY) { console.log('\n[DRY-RUN] 未改动。加 --apply 执行。'); return }

  // ── 执行：先清交易数据（解除对旧商品/客户的引用），再删重复代次 ──
  console.log('\n[APPLY] 清空交易数据…')
  for (const [name, model] of txTables) {
    try { const r = await (model as any).deleteMany({}); if (r.count) console.log(`  清空 ${name}: ${r.count}`) }
    catch (e) { console.warn(`  ⚠️ ${name} 清空失败:`, (e as Error).message.slice(0, 120)) }
  }

  console.log('[APPLY] 删除重复代次…')
  await chunkDelete('商品(pnum/uuid)', prisma.product, delProd)
  await chunkDelete('模板(tmpl_p/uuid)', prisma.productTemplate, delTmpl)
  await chunkDelete('客户(cust_n)', prisma.customer, delCust)

  // ── 校验 ──
  console.log('\n── 校验 ──')
  const [np, nc, nt] = await Promise.all([prisma.product.count(), prisma.customer.count(), prisma.productTemplate.count()])
  console.log(`  剩余 商品 ${np} 客户 ${nc} 模板 ${nt}`)
  const leftoverP = (await prisma.product.findMany({ select: { id: true } })).filter(p => isPnum(p.id) || isUuid(p.id)).length
  console.log(`  残留旧体系商品: ${leftoverP}`)
  const ro = await prisma.product.findFirst({ where: { name: { contains: 'Red Onion 10kg' } }, select: { id: true, externalId: true } })
  console.log(`  Red Onion 还剩:`, JSON.stringify(ro))
  console.log('✅ 去重完成')
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
