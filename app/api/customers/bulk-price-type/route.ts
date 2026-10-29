import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { salesRowScope, isRowVisible } from '@/lib/row-scope'

const PRICE_TYPES = new Set(['multi', 'default', 'last'])
const MAX_IDS = 200

/** POST /api/customers/bulk-price-type — update Price Type for selected customers only. */
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const body = await req.json().catch(() => ({}))
      const ids = Array.isArray(body.ids)
        ? [...new Set((body.ids as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0))]
        : []
      const priceType = typeof body.priceType === 'string' ? body.priceType : ''

      if (ids.length === 0) return NextResponse.json({ error: 'ids 不能为空' }, { status: 400 })
      if (ids.length > MAX_IDS) return NextResponse.json({ error: `单次最多更新 ${MAX_IDS} 个客户` }, { status: 400 })
      if (!PRICE_TYPES.has(priceType)) return NextResponse.json({ error: '无效的 Price Type' }, { status: 400 })

      const found = await prisma.customer.findMany({
        where: { id: { in: ids }, isCustomer: true },
        select: { id: true, name: true, priceType: true, salesUserId: true, salesUser: { select: { managerId: true } } },
      })
      const scope = salesRowScope(user)
      const visible = found.filter(customer => isRowVisible(customer, scope))
      const changed = visible.filter(customer => customer.priceType !== priceType)
      const unchanged = visible.length - changed.length

      if (changed.length > 0) {
        const result = await prisma.customer.updateMany({
          where: { id: { in: changed.map(customer => customer.id) }, isCustomer: true },
          data: { priceType, updatedBy: user.name || user.email },
        })
        await Promise.all(changed.map(customer => writeLog({
          userId: user.userId,
          userEmail: user.email,
          userName: user.name,
          action: 'UPDATE',
          resource: 'customer',
          resourceId: customer.id,
          detail: `批量修改客户定价模式: ${customer.name} (${customer.priceType} → ${priceType})`,
        })))
        return NextResponse.json({ updated: result.count, unchanged, notFound: ids.length - visible.length })
      }

      return NextResponse.json({ updated: 0, unchanged, notFound: ids.length - visible.length })
    } catch (error) {
      console.error('[POST /api/customers/bulk-price-type]', error)
      return NextResponse.json({ error: '批量更新 Price Type 失败' }, { status: 500 })
    }
  }, { require: 'master.customer.update' })
}
