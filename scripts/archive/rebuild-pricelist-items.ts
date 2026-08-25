/**
 * scripts/rebuild-pricelist-items.ts
 *
 * 从 pic/product.pricelist.csv（Odoo product.pricelist 列表页 Action→Export，
 * import-compatible + 展开 Pricelist Items 一对多字段导出）全量重建价格表 + 条目。
 *
 * 2026-07-15 改版：
 *   - 适配新导出的技术字段名表头（id / name / currency_id/id / item_ids/* ...），
 *     不再是旧版展示名表头（"External ID" / "Pricelist Items/Product" ...）
 *   - CSV 中存在但本地不存在的价格表会自动新建（新签客户的价格表）
 *   - 覆盖策略：以 Odoo 为唯一权威来源整体覆盖，不再保留本地手动编辑的条目
 *     （2026-07-15 与用户确认：生产库内通过 /operator/pricelists UI 做的人工调整，
 *      如与本次导出冲突，以 Odoo 为准）
 *   - 补齐 percentage/formula 全字段（discount/surcharge/margin/rounding/base），
 *     旧版只处理了 fixed，formula 一律写死 list_price 无 discount/surcharge
 *   - 按 applyOn 特异度 + minQty 降序生成 sequence，保证多阶梯定价和
 *     variant > product > category > global 的优先级在 lib/pricing-engine.ts 里正确生效
 *     （Odoo 新版 pricelist item 已无手工 sequence 字段，靠"更具体的规则先匹配"隐式排序）
 *
 * 映射：
 *   - 价格表：CSV 顶层 "id" 列 = Odoo external ID → OdooPricelist.externalId
 *   - 变体规则：CSV "item_ids/product_id/id" = __export__.product_product_<num>_<hash> → Product.externalId=<num>
 *   - 模板规则：CSV "item_ids/product_tmpl_id/id" = __export__.product_template_<num>_<hash> → ProductTemplate.externalId=<num>
 *
 * 运行：
 *   node --import tsx -r dotenv/config scripts/rebuild-pricelist-items.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/rebuild-pricelist-items.ts dotenv_config_path=.env.local --apply    # 写入
 */
import { createPrismaClient } from '@/lib/prisma-factory'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

const prisma = createPrismaClient()

const APPLY = process.argv.includes('--apply')

function splitCsv(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q }
    else if (ch === ',' && !q) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur); return out
}
const prodNumFromExt = (s: string) => { const m = s.match(/product_product_(\d+)/); return m ? m[1] : '' }
const tmplNumFromExt = (s: string) => { const m = s.match(/product_(?:product|template)_(\d+)/); return m ? m[1] : '' }
const toNum = (s: string, d = 0) => { const n = parseFloat(s); return isNaN(n) ? d : n }

const mapApplyOn = (r: string): 'variant' | 'product' | 'category' | 'global' =>
  r === 'Product Variant' ? 'variant' : r === 'Product' ? 'product' : r === 'Product Category' ? 'category' : 'global'
const mapCompute = (r: string): 'fixed' | 'percentage' | 'formula' =>
  r === 'Fix Price' ? 'fixed' : r.startsWith('Percentage') ? 'percentage' : 'formula'
const mapBase = (r: string): 'list_price' | 'standard_price' | 'pricelist' =>
  r === 'Cost' ? 'standard_price' : r === 'Other Pricelist' ? 'pricelist' : 'list_price'

// 特异度优先级：越具体的规则 sequence 越小（越先命中）；组内按 minQty 降序（阶梯定价从高往低试）
const GROUP_BASE: Record<string, number> = { variant: 0, product: 100_000, category: 200_000, global: 300_000 }
function computeSequence(applyOn: string, minQty: number): number {
  return GROUP_BASE[applyOn] + (100_000 - Math.min(99_999, Math.round(minQty * 10)))
}

async function main() {
  // ── DB 映射表 ──
  const pls = await prisma.odooPricelist.findMany({ select: { id: true, externalId: true, name: true } })
  const plByExt = new Map<string, string>()
  for (const p of pls) if (p.externalId) plByExt.set(p.externalId, p.id)

  const cats = await prisma.productCategory.findMany({ select: { id: true, externalId: true } })
  const catByExt = new Map<string, string>()
  for (const c of cats) if (c.externalId) catByExt.set(c.externalId, c.id)

  const prods = await prisma.product.findMany({ select: { id: true, templateId: true, externalId: true } })
  const prodNumOf = (e: string | null) => { if (!e) return ''; if (/^\d+$/.test(e)) return e; const m = e.match(/product_product_(\d+)/); return m ? m[1] : '' }
  const idRank = (id: string) => /^[0-9a-f]{25}$/.test(id) ? 0 : /^p\d+$/.test(id) ? 1 : 2  // cuid25 优先
  const prodByNum = new Map<string, { id: string; templateId: string }>()
  const prodRank = new Map<string, number>()
  for (const p of prods) {
    const n = prodNumOf(p.externalId)
    if (!n) continue
    const r = idRank(p.id)
    if (!prodByNum.has(n) || r < (prodRank.get(n) ?? 9)) { prodByNum.set(n, { id: p.id, templateId: p.templateId }); prodRank.set(n, r) }
  }

  const tmpls = await prisma.productTemplate.findMany({ select: { id: true, externalId: true } })
  const tmplByNum = new Map<string, string>()
  for (const t of tmpls) { const e = t.externalId ?? ''; if (/^\d+$/.test(e) && !tmplByNum.has(e)) tmplByNum.set(e, t.id) }

  // ── 解析 CSV（技术字段名表头） ──
  const raw = fs.readFileSync(path.join(process.cwd(), 'pic/product.pricelist.csv'), 'utf-8')
  const lines = raw.split(/\r?\n/).filter(Boolean)
  const headers = splitCsv(lines[0])
  const idx = (name: string) => headers.indexOf(name)
  const col = (cols: string[], name: string) => cols[idx(name)] ?? ''

  interface NewPl { externalId: string; name: string; currency: string; selectable: boolean; sequence: number }
  const newPls: NewPl[] = []
  const itemsByPlExt = new Map<string, Record<string, unknown>[]>()

  let curPlExt = ''
  let parsed = 0, linkedOk = 0, linkMiss = 0
  const missSamples: string[] = []

  for (const line of lines.slice(1)) {
    const cols = splitCsv(line)
    const plExtRow = col(cols, 'id').trim()
    if (plExtRow) {
      curPlExt = plExtRow
      if (!plByExt.has(plExtRow)) {
        newPls.push({
          externalId: plExtRow,
          name: col(cols, 'name').trim(),
          currency: 'EUR',
          selectable: col(cols, 'selectable').trim().toLowerCase() === 'true',
          sequence: toNum(col(cols, 'sequence'), 10),
        })
      }
    }
    const itemExt = col(cols, 'item_ids/id').trim()
    if (!itemExt || !curPlExt) continue

    const applyOn = mapApplyOn(col(cols, 'item_ids/applied_on').trim())
    const computeType = mapCompute(col(cols, 'item_ids/compute_price').trim())
    const minQty = toNum(col(cols, 'item_ids/min_quantity'))
    const dateStart = col(cols, 'item_ids/date_start').trim() || undefined
    const dateEnd = col(cols, 'item_ids/date_end').trim() || undefined
    const prodExt = col(cols, 'item_ids/product_id/id').trim()
    const tmplExt = col(cols, 'item_ids/product_tmpl_id/id').trim()
    const categExt = col(cols, 'item_ids/categ_id/id').trim()

    const item: Record<string, unknown> = {
      id: randomUUID(),
      applyOn,
      minQty,
      computeType,
      sequence: computeSequence(applyOn, minQty),
      ...(dateStart ? { dateStart } : {}),
      ...(dateEnd ? { dateEnd } : {}),
    }

    if (computeType === 'fixed') {
      item.fixedPrice = toNum(col(cols, 'item_ids/fixed_price'))
    } else if (computeType === 'percentage') {
      item.percentDiscount = toNum(col(cols, 'item_ids/percent_price'))
    } else {
      const base = mapBase(col(cols, 'item_ids/base').trim())
      item.formulaBase = base
      item.priceDiscount = toNum(col(cols, 'item_ids/price_discount'))
      item.priceSurcharge = toNum(col(cols, 'item_ids/price_surcharge'))
      const minMargin = col(cols, 'item_ids/price_min_margin').trim()
      const maxMargin = col(cols, 'item_ids/price_max_margin').trim()
      if (minMargin && toNum(minMargin) !== 0) item.priceMinMargin = toNum(minMargin)
      if (maxMargin && toNum(maxMargin) !== 0) item.priceMaxMargin = toNum(maxMargin)
      const rounding = col(cols, 'item_ids/price_round').trim()
      if (rounding && toNum(rounding) !== 0) item.roundingMethod = toNum(rounding)
      if (base === 'pricelist') {
        const otherExt = col(cols, 'item_ids/base_pricelist_id/id').trim()
        const otherLocal = plByExt.get(otherExt)
        if (otherLocal) item.basedOnPricelistId = otherLocal
      }
    }

    parsed++
    let linked = true
    if (applyOn === 'variant') {
      const p = prodExt ? prodByNum.get(prodNumFromExt(prodExt)) : undefined
      if (p) { item.productVariantId = p.id; linkedOk++ }
      else { linked = false; linkMiss++; if (missSamples.length < 5) missSamples.push(`variant ${prodExt || '(空)'} 未找到`) }
    } else if (applyOn === 'product') {
      const num = tmplExt ? tmplNumFromExt(tmplExt) : ''
      const tid = (num && prodByNum.get(num)?.templateId) || (num && tmplByNum.get(num)) || undefined
      if (tid) { item.productTemplateId = tid; linkedOk++ }
      else { linked = false; linkMiss++; if (missSamples.length < 5) missSamples.push(`template ${tmplExt || '(空)'} 未找到`) }
    } else if (applyOn === 'category') {
      const cid = categExt ? catByExt.get(categExt) : undefined
      if (cid) item.categoryId = cid
      else linked = false
    }

    // 未能关联到商品/类目的规则在本地永远不会命中(matchesItem 需要精确 id)，
    // 不写入，避免 items 数组里堆积死条目；数量计入 linkMiss 供报告
    if (!linked) continue

    if (!itemsByPlExt.has(curPlExt)) itemsByPlExt.set(curPlExt, [])
    itemsByPlExt.get(curPlExt)!.push(item)
  }

  const totalItems = [...itemsByPlExt.values()].reduce((s, a) => s + a.length, 0)
  console.log('── 重建解析 ──')
  console.log(`  CSV 解析条目: ${parsed} | 关联成功: ${linkedOk} | 商品/类目未在本地找到而跳过(该商品在此价格表回退到全局规则或牌价): ${linkMiss}`)
  console.log(`  CSV 中价格表: ${itemsByPlExt.size} 张，合计条目: ${totalItems}`)
  console.log(`  需新建价格表: ${newPls.length} 张`)
  newPls.forEach(p => console.log(`    + ${p.name} (${p.externalId})`))
  if (missSamples.length) console.log('  关联失败样例:', missSamples.join(' | '))

  if (!APPLY) { console.log('\n[DRY-RUN] 未写入。加 --apply 执行。'); return }

  console.log('\n[APPLY] 新建缺失价格表…')
  for (const p of newPls) {
    const created = await prisma.odooPricelist.create({
      data: {
        externalId: p.externalId,
        name: p.name,
        currency: p.currency,
        selectable: p.selectable,
        sequence: p.sequence,
        active: true,
        items: [],
      },
    })
    plByExt.set(p.externalId, created.id)
  }
  console.log(`  新建 ${newPls.length} 张`)

  console.log('\n[APPLY] 写入条目…')
  let n = 0
  for (const [plExt, items] of itemsByPlExt) {
    const localId = plByExt.get(plExt)
    if (!localId) continue
    await prisma.odooPricelist.update({ where: { id: localId }, data: { items: items as never, updatedAt: new Date() } })
    if (++n % 50 === 0) console.log(`  …${n}/${itemsByPlExt.size}`)
  }
  console.log(`✅ 完成：重建 ${n} 张价格表的条目`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
