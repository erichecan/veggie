/**
 * scripts/rebuild-pricelist-items.ts
 *
 * 从 pic/product.pricelist.csv 重建全部价格表条目(items)，并正确写入商品关联
 * (productVariantId / productTemplateId)，修复"条目无商品关联导致价格表全失效"的问题。
 *
 * 背景：DB 现有 6403 条 items 中仅 3 条带商品关联（其余无法命中任何商品，一律回退牌价）。
 * CSV 是 Odoo 干净来源，3274 条全部带关联列，是重建的权威依据。
 *
 * 映射：
 *   - 变体规则: CSV "…/Product"          = __export__.product_product_<num>_<hash>      → 商品 externalId=<num> → Product.id
 *   - 模板规则: CSV "…/Product Template"  = __export__.product_product_<num>_..._product_template → 商品 externalId=<num> → Product.templateId
 *   - 价格表:   CSV "…/Pricelist"         经 OdooPricelist.externalId 映射到本地 pl_xx
 *
 * 保留手动编辑：DB 中已带商品关联的条目（极可能是 UI 手动维护，如 CITY CENTRE 的 Red Onion=2.2）
 *              默认以最高优先级(sequence=0)叠加保留，除非 --no-preserve。
 *
 * 运行：
 *   node --import tsx -r dotenv/config scripts/rebuild-pricelist-items.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/rebuild-pricelist-items.ts dotenv_config_path=.env.local --apply    # 写入
 *   附加 --no-preserve 则不保留手动条目（完全以 CSV 为准）
 */
import fs from 'fs'
import path from 'path'
import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'
import { randomUUID } from 'crypto'

neonConfig.webSocketConstructor = ws
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })

const APPLY = process.argv.includes('--apply')
const PRESERVE = !process.argv.includes('--no-preserve')

function splitCsv(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q }
    else if (ch === ',' && !q) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur); return out
}
const num = (s: string) => { const m = s.match(/product_product_(\d+)/); return m ? m[1] : '' }
const toNum = (s: string, d = 0) => { const n = parseFloat(s); return isNaN(n) ? d : n }
const mapApplyOn = (r: string) => r === 'Product Variant' ? 'variant' : r === 'Product' ? 'product' : r === 'Product Category' ? 'category' : 'global'
const mapCompute = (r: string) => r === 'Fix Price' ? 'fixed' : r === 'Percentage' ? 'percentage' : 'formula'

async function main() {
  // DB 映射表
  const pls = await prisma.odooPricelist.findMany({ select: { id: true, externalId: true, items: true } })
  const plByExt = new Map<string, string>()
  for (const p of pls) if (p.externalId) plByExt.set(p.externalId, p.id)

  // 商品按 Odoo 编号归一化；存在跨代次重复时，选 canonical = cuid25(订单/定价正版) > pnum > uuid
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

  // 模板按"模板号"归一化：DB 模板纯数字 externalId = Odoo 模板号（cuid25 代次），用于 CSV 的 product_template_<num> 格式
  const tmpls = await prisma.productTemplate.findMany({ select: { id: true, externalId: true } })
  const tmplByNum = new Map<string, string>()
  for (const t of tmpls) { const e = t.externalId ?? ''; if (/^\d+$/.test(e) && !tmplByNum.has(e)) tmplByNum.set(e, t.id) }

  // 保留 DB 中已带关联的"手动条目"（按 pricelist 本地 id 分组）
  const manual = new Map<string, any[]>()
  if (PRESERVE) {
    for (const p of pls) {
      const keep = ((p.items as any[]) ?? []).filter(it => it.productVariantId || it.productTemplateId)
        .map(it => ({ ...it, sequence: 0 })) // 最高优先级
      if (keep.length) manual.set(p.id, keep)
    }
  }

  // 解析 CSV
  const raw = fs.readFileSync(path.join(process.cwd(), 'pic/product.pricelist.csv'), 'utf-8')
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const headers = splitCsv(lines[0])
  const col = (cols: string[], name: string) => cols[headers.indexOf(name)] ?? ''

  const itemsByPl = new Map<string, any[]>()
  let curPlExt = ''
  let parsed = 0, linkedOk = 0, linkMiss = 0, plMiss = 0
  const missSamples: string[] = []

  for (const line of lines.slice(1)) {
    const cols = splitCsv(line)
    const plExtRow = col(cols, 'External ID').trim()
    if (plExtRow) curPlExt = plExtRow
    const itemExt = col(cols, 'Pricelist Items').trim()
    if (!itemExt || !curPlExt) continue

    const localPl = plByExt.get(curPlExt)
    if (!localPl) { plMiss++; continue }

    const applyOn = mapApplyOn(col(cols, 'Pricelist Items/Apply On').trim())
    const computeType = mapCompute(col(cols, 'Pricelist Items/Compute Price').trim())
    const fixedPrice = toNum(col(cols, 'Pricelist Items/Fixed Price'))
    const minQty = toNum(col(cols, 'Pricelist Items/Min. Quantity'))
    const dateStart = col(cols, 'Pricelist Items/Start Date').trim() || undefined
    const dateEnd = col(cols, 'Pricelist Items/End Date').trim() || undefined
    const prodNum = num(col(cols, 'Pricelist Items/Product'))
    const tmplRaw = col(cols, 'Pricelist Items/Product Template')
    const tmplPpNum = (tmplRaw.match(/product_product_(\d+)/) ?? [])[1] ?? ''   // 格式1: 经商品拿 templateId
    const tmplPtNum = (tmplRaw.match(/product_template_(\d+)/) ?? [])[1] ?? ''   // 格式2: 经模板 externalId

    const item: Record<string, unknown> = {
      id: randomUUID(), applyOn, minQty, computeType, sequence: 10,
      ...(dateStart ? { dateStart } : {}), ...(dateEnd ? { dateEnd } : {}),
      ...(computeType === 'fixed' ? { fixedPrice } : {}),
      ...(computeType === 'formula' ? { formulaBase: 'list_price', priceDiscount: 0, priceSurcharge: 0 } : {}),
    }

    parsed++
    if (applyOn === 'variant') {
      const p = prodNum ? prodByNum.get(prodNum) : undefined
      if (p) { item.productVariantId = p.id; linkedOk++ }
      else { linkMiss++; if (missSamples.length < 5) missSamples.push(`variant prod#${prodNum} 未找到`) }
    } else if (applyOn === 'product') {
      const tid = (tmplPpNum && prodByNum.get(tmplPpNum)?.templateId) || (tmplPtNum && tmplByNum.get(tmplPtNum)) || undefined
      if (tid) { item.productTemplateId = tid; linkedOk++ }
      else { linkMiss++; if (missSamples.length < 5) missSamples.push(`template ${tmplRaw.slice(0,40)} 未找到`) }
    }

    if (!itemsByPl.has(localPl)) itemsByPl.set(localPl, [])
    itemsByPl.get(localPl)!.push(item)
  }

  // 叠加保留的手动条目
  let manualKept = 0
  if (PRESERVE) {
    for (const [plId, keep] of manual) {
      const arr = itemsByPl.get(plId) ?? []
      arr.unshift(...keep)
      itemsByPl.set(plId, arr)
      manualKept += keep.length
    }
  }

  const totalItems = [...itemsByPl.values()].reduce((s, a) => s + a.length, 0)
  console.log('── 重建解析 ──')
  console.log(`  CSV 解析条目: ${parsed} | 关联成功: ${linkedOk} | 关联失败(商品缺失): ${linkMiss} | 价格表缺失: ${plMiss}`)
  console.log(`  保留手动条目: ${manualKept}（PRESERVE=${PRESERVE}）`)
  console.log(`  将写入价格表: ${itemsByPl.size} 张，合计条目: ${totalItems}`)
  if (missSamples.length) console.log('  关联失败样例:', missSamples.join(' | '))

  // CITY CENTRE Red Onion 抽查
  const cc = itemsByPl.get('pl_35') ?? []
  const ro = prodByNum.get('18944')
  const roItems = cc.filter(it => it.productVariantId === ro?.id || it.productTemplateId === ro?.templateId)
  console.log('\n── CITY CENTRE (pl_35) Red Onion 抽查 ──')
  for (const it of roItems) console.log(`   applyOn=${it.applyOn} seq=${it.sequence} price=${it.fixedPrice ?? '(formula)'} ${it.productVariantId ? 'variant' : 'template'}`)
  console.log(`   → 解析后 Red Onion 在 CITY CENTRE 命中: ${roItems.length ? `${[...roItems].sort((a,b)=>a.sequence-b.sequence)[0].fixedPrice} (seq 最小者)` : '无规则→回退牌价'}`)

  if (!APPLY) { console.log('\n[DRY-RUN] 未写入。加 --apply 执行。'); return }

  console.log('\n[APPLY] 写入中…')
  let n = 0
  for (const [plId, items] of itemsByPl) {
    await prisma.odooPricelist.update({ where: { id: plId }, data: { items: items as never } })
    if (++n % 50 === 0) console.log(`  …${n}/${itemsByPl.size}`)
  }
  console.log(`✅ 完成：重建 ${n} 张价格表的条目`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
