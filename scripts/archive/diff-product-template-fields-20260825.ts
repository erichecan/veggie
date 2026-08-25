/**
 * 合表重构 T2：Product ↔ ProductTemplate 同名字段分歧报表（只读，不写库）
 *
 * 背景：DEV-PLAN.md「合并 ProductTemplate 到 Product」第一节列出的同名字段
 * （name/价格/税率/提成/internalRef/categoryId/images/status/sequence/
 * externalId/createdAt/updatedAt），理论上 1:1 场景下两边应该一致，但除了
 * name（已知 6 条历史分歧）之外从未系统性核实过。T3 的回填 SQL 要按这份报表
 * 的结果决定冲突字段取舍规则，不能盲目 COALESCE。
 *
 * 用法：
 *   node --import tsx -r dotenv/config scripts/diff-product-template-fields-20260825.ts dotenv_config_path=.env.local
 */

import { createPrismaClient } from '@/lib/prisma-factory'
const prisma = createPrismaClient()

type Row = {
  id: string
  name: string
  internalRef: string | null
  categoryId: string | null
  images: string[]
  status: string
  sequence: number | null
  externalId: string | null
  listPrice: unknown
  standardPrice: unknown
  customerTaxRate: unknown
  commissionPrice: unknown
  createdAt: Date
  updatedAt: Date
  template: {
    id: string
    name: string
    internalRef: string | null
    categoryId: string | null
    images: string[]
    status: string
    sequence: number | null
    externalId: string | null
    listPrice: unknown
    standardPrice: unknown
    customerTaxRate: unknown
    commissionPrice: unknown
    createdAt: Date
    updatedAt: Date
  }
}

function decEq(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  return String(a) === String(b)
}
function arrEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

const FIELDS: Array<{ key: string; cmp: (p: Row, t: Row['template']) => boolean }> = [
  { key: 'name', cmp: (p, t) => p.name === t.name },
  { key: 'internalRef', cmp: (p, t) => p.internalRef === t.internalRef },
  { key: 'categoryId', cmp: (p, t) => p.categoryId === t.categoryId },
  { key: 'images', cmp: (p, t) => arrEq(p.images, t.images) },
  { key: 'status', cmp: (p, t) => p.status === t.status },
  { key: 'sequence', cmp: (p, t) => p.sequence === t.sequence },
  { key: 'externalId', cmp: (p, t) => p.externalId === t.externalId },
  { key: 'listPrice', cmp: (p, t) => decEq(p.listPrice, t.listPrice) },
  { key: 'standardPrice', cmp: (p, t) => decEq(p.standardPrice, t.standardPrice) },
  { key: 'customerTaxRate', cmp: (p, t) => decEq(p.customerTaxRate, t.customerTaxRate) },
  { key: 'commissionPrice', cmp: (p, t) => decEq(p.commissionPrice, t.commissionPrice) },
  // createdAt/updatedAt 预期本来就不强制一致（两行是分两次 insert/update 的），
  // 这里只统计不做为"异常"，留给人工判断要不要纳入取舍。
  { key: 'createdAt', cmp: (p, t) => p.createdAt.getTime() === t.createdAt.getTime() },
  { key: 'updatedAt', cmp: (p, t) => p.updatedAt.getTime() === t.updatedAt.getTime() },
]

async function main() {
  console.log('\n=== Product ↔ ProductTemplate 同名字段分歧报表（只读） ===\n')

  const products = (await prisma.product.findMany({
    select: {
      id: true, name: true, internalRef: true, categoryId: true, images: true,
      status: true, sequence: true, externalId: true,
      listPrice: true, standardPrice: true, customerTaxRate: true, commissionPrice: true,
      createdAt: true, updatedAt: true,
      template: {
        select: {
          id: true, name: true, internalRef: true, categoryId: true, images: true,
          status: true, sequence: true, externalId: true,
          listPrice: true, standardPrice: true, customerTaxRate: true, commissionPrice: true,
          createdAt: true, updatedAt: true,
        },
      },
    },
  })) as unknown as Row[]

  console.log(`共 ${products.length} 个 Product（应与 ProductTemplate 数量严格 1:1）\n`)

  const mismatches: Record<string, Row[]> = {}
  for (const f of FIELDS) mismatches[f.key] = []

  for (const p of products) {
    for (const f of FIELDS) {
      if (!f.cmp(p, p.template)) mismatches[f.key].push(p)
    }
  }

  console.log('【按字段统计分歧条数】')
  for (const f of FIELDS) {
    const rows = mismatches[f.key]
    console.log(`  ${f.key.padEnd(18)} : ${rows.length} 条`)
  }
  console.log('')

  for (const f of FIELDS) {
    const rows = mismatches[f.key]
    if (rows.length === 0) continue
    console.log(`--- ${f.key} 分歧样例（最多 10 条）---`)
    for (const p of rows.slice(0, 10)) {
      const pv = (p as unknown as Record<string, unknown>)[f.key]
      const tv = (p.template as unknown as Record<string, unknown>)[f.key]
      console.log(`  id=${p.id}  Product.${f.key}=${JSON.stringify(pv)}  vs  Template.${f.key}=${JSON.stringify(tv)}`)
    }
    console.log('')
  }

  console.log('=== 报表结束，未写任何数据。===\n')
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
