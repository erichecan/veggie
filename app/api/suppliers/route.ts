import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { toNumOpt } from '@/lib/decimal-helpers'
import { serializeApi } from '@/lib/api-serializer'

/**
 * /api/suppliers
 * ============================================================================
 * 对应 Odoo res.partner 的 is_vendor=true 切面。
 *
 * 本系统按 Odoo 理念：客户和供应商共用 Customer 表，通过 isCustomer / isVendor
 * 两个布尔字段区分。同一个合作伙伴可以既是客户又是供应商（例如餐厅也代售货）。
 */

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const q = searchParams.get('q')?.trim() ?? ''
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
    const pageSize = Math.min(500, Math.max(1, parseInt(searchParams.get('pageSize') ?? '100', 10)))

    const where: Record<string, unknown> = { isVendor: true }
    if (q) {
      where.OR = [
        { name:      { contains: q, mode: 'insensitive' } },
        { email:     { contains: q, mode: 'insensitive' } },
        { vatNumber: { contains: q, mode: 'insensitive' } },
        { phone:     { contains: q } },
      ]
    }

    // 使用 any 绕过类型，因为 isVendor/isCustomer 要等 `prisma generate` 后才在类型里出现
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const [total, rows] = await Promise.all([
      p.customer.count({ where }),
      p.customer.findMany({
        where,
        orderBy: { name: 'asc' },
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
    ])

    return NextResponse.json({
      total,
      page,
      pageSize,
      items: serializeApi(rows),
    })
  } catch (error) {
    console.error('[GET /api/suppliers]', error)
    return NextResponse.json({ error: '获取供应商失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const name = String(data.name ?? '').trim().slice(0, 200)
      if (!name) return NextResponse.json({ error: '供应商名称不能为空' }, { status: 400 })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      // 已存在同名的 Partner 记录？如果存在 → 复用并把 isVendor 翻为 true（同一实体同时是客户+供应商）
      const existing = await p.customer.findFirst({ where: { name } })
      const payload: Record<string, unknown> = {
        name,
        address: String(data.address ?? '').trim().slice(0, 500),
        phone:   String(data.phone ?? '').trim().slice(0, 50),
        email:   String(data.email ?? '').trim().slice(0, 200),
        vatNumber: String(data.vatNumber ?? '').trim().slice(0, 50),
        city:    data.city ?? null,
        notes:   data.notes ?? null,
        supplierPaymentTerm: data.supplierPaymentTerm ?? null,
        vendorTaxRate: toNumOpt(data.vendorTaxRate) ?? null,
        isVendor: true,
        isCustomer: existing?.isCustomer ?? Boolean(data.alsoCustomer ?? false),
      }

      let partner
      if (existing) {
        partner = await p.customer.update({
          where: { id: existing.id },
          data: payload,
        })
      } else {
        partner = await p.customer.create({ data: payload })
      }

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: existing ? 'UPDATE' : 'CREATE', resource: 'supplier', resourceId: partner.id,
        detail: `${existing ? '更新' : '创建'}供应商: ${partner.name}`,
      })

      return NextResponse.json(serializeApi(partner), { status: existing ? 200 : 201 })
    } catch (error) {
      console.error('[POST /api/suppliers]', error)
      return NextResponse.json({ error: '保存供应商失败' }, { status: 500 })
    }
  }, { require: 'master.supplier.create' })
}
