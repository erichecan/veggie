import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'

/**
 * POST /api/products/bulk — 商品批量导入(CSV)
 * body: { rows: [{ name*, spec?, price?, stock?, taxRate?, commissionPrice?, internalRef? }] }
 * 每行自动创建 ProductTemplate + Product(系统约定商品必须挂模板)。
 * 重名跳过,一次最多 200 行。
 */

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const rows = Array.isArray(data.rows) ? data.rows : []
      if (rows.length === 0) return NextResponse.json({ error: 'rows 不能为空' }, { status: 400 })
      if (rows.length > 200) return NextResponse.json({ error: '一次最多导入 200 行' }, { status: 400 })

      const num = (v: unknown): number | null => {
        if (v === null || v === undefined || v === '') return null
        const n = Number(v)
        return Number.isFinite(n) ? n : null
      }

      const cleaned = rows
        .map((r: Record<string, unknown>) => ({
          name: String(r.name ?? '').trim().slice(0, 200),
          spec: r.spec ? String(r.spec).trim().slice(0, 200) : null,
          price: num(r.price),
          stock: num(r.stock),
          taxRate: num(r.taxRate),
          commissionPrice: num(r.commissionPrice),
          internalRef: r.internalRef ? String(r.internalRef).trim().slice(0, 100) : null,
        }))
        .filter((r: { name: string }) => r.name.length > 0)

      if (cleaned.length === 0) {
        return NextResponse.json({ error: '没有有效行(name 必填)' }, { status: 400 })
      }

      const existing = await prisma.product.findMany({ select: { name: true } })
      const taken = new Set(existing.map(p => p.name.toLowerCase()))
      const toCreate: typeof cleaned = []
      const skipped: string[] = []
      for (const r of cleaned) {
        const key = r.name.toLowerCase()
        if (taken.has(key)) { skipped.push(r.name); continue }
        taken.add(key)
        toCreate.push(r)
      }

      let created = 0
      // 分批事务:每批 50 行(模板+商品各一条插入)
      for (let i = 0; i < toCreate.length; i += 50) {
        const chunk = toCreate.slice(i, i + 50)
        await prisma.$transaction(async tx => {
          for (const r of chunk) {
            const tpl = await tx.productTemplate.create({
              data: {
                name: r.name,
                internalRef: r.internalRef,
                listPrice: r.price ?? 0,
                customerTaxRate: r.taxRate ?? 0,
                commissionPrice: r.commissionPrice,
              },
            })
            await tx.product.create({
              data: {
                templateId: tpl.id,
                name: r.name,
                internalRef: r.internalRef,
                spec: r.spec,
                price: r.price,
                listPrice: r.price,
                qtyOnHand: r.stock ?? 0,
                customerTaxRate: r.taxRate,
                commissionPrice: r.commissionPrice,
              },
            })
            created++
          }
        })
      }

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'product', resourceId: 'bulk',
        detail: `批量导入商品:成功 ${created},重名跳过 ${skipped.length}`,
      })
      return NextResponse.json({ created, skipped })
    } catch (error) {
      console.error('[POST /api/products/bulk]', error)
      return NextResponse.json({ error: '批量导入失败' }, { status: 500 })
    }
  }, { require: 'master.product.update' })
}
