import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { getPricelistUsage, reassignPricelistCustomers } from '@/lib/pricelist-archive'

/**
 * GET /api/pricelists/:id/customers
 * 这张价格表被哪些客户挂着、被哪些启用中的价格表的公式引用（归档弹窗/批量替换弹窗用）。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async () => {
    try {
      const exists = await prisma.odooPricelist.findUnique({ where: { id }, select: { id: true } })
      if (!exists) return NextResponse.json({ error: '价格表不存在' }, { status: 404 })
      return NextResponse.json(await getPricelistUsage(prisma, id))
    } catch (error) {
      console.error('[GET /api/pricelists/[id]/customers]', error)
      return NextResponse.json({ error: '获取价格表使用情况失败' }, { status: 500 })
    }
  }, { require: 'master.pricelist.read' })
}

/**
 * POST /api/pricelists/:id/customers
 * body: { replacementId: string | null, customerIds?: string[], archive?: boolean }
 *
 * 把客户从这张表挪走：replacementId 有值 = 在原优先级位置换成它，null = 直接移除。
 * customerIds 不传 = 全部客户。archive=true 时挪完顺带归档，跟挪客户在同一个事务里——
 * 要么都成功，要么都不做，不会留下「客户挪了一半、表却没归档」的中间状态。
 * 归档时必须挪走**全部**客户、且没有启用中的价格表在公式里引用它（见 lib/pricelist-archive.ts）。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const body = await req.json().catch(() => ({}))
      const replacementId: string | null = typeof body.replacementId === 'string' && body.replacementId ? body.replacementId : null
      const customerIds: string[] | undefined = Array.isArray(body.customerIds)
        ? [...new Set(body.customerIds.map(String).filter(Boolean))] as string[]
        : undefined
      const archive = body.archive === true

      if (archive && customerIds) {
        return NextResponse.json({ error: '归档时必须处理全部客户，不能只选一部分' }, { status: 400 })
      }

      const source = await prisma.odooPricelist.findUnique({ where: { id }, select: { id: true, name: true, active: true } })
      if (!source) return NextResponse.json({ error: '价格表不存在' }, { status: 404 })

      let replacement: { id: string; name: string } | null = null
      if (replacementId) {
        if (replacementId === id) return NextResponse.json({ error: '替换的价格表不能是它自己' }, { status: 400 })
        const r = await prisma.odooPricelist.findUnique({
          where: { id: replacementId }, select: { id: true, name: true, active: true, selectable: true },
        })
        if (!r) return NextResponse.json({ error: '替换的价格表不存在' }, { status: 400 })
        // 跟客户详情页的可选范围一致：归档的/不可选的表不能被新挂给客户
        if (!r.active || !r.selectable) {
          return NextResponse.json({ error: `价格表「${r.name}」已归档或不可选，不能用来替换` }, { status: 400 })
        }
        replacement = { id: r.id, name: r.name }
      }

      if (archive) {
        const { referencedBy } = await getPricelistUsage(prisma, id)
        if (referencedBy.length > 0) {
          return NextResponse.json({
            error: `价格表被以下价格表的公式引用为基准，不能归档：${referencedBy.map(r => r.name).join('、')}。请先修改这些规则。`,
          }, { status: 409 })
        }
      }

      const { result, before, after } = await prisma.$transaction(async (tx) => {
        const affected = (await tx.customerPricelist.findMany({
          where: { pricelistId: id, ...(customerIds ? { customerId: { in: customerIds } } : {}) },
          select: { customerId: true },
        })).map(l => l.customerId)
        const linksOf = async () => tx.customerPricelist.findMany({
          where: { customerId: { in: affected } },
          orderBy: { sequence: 'asc' },
          select: { customerId: true, pricelistId: true },
        })
        const before = await linksOf()
        const result = await reassignPricelistCustomers(tx, id, replacement?.id ?? null, customerIds)
        const after = await linksOf()
        if (archive) {
          await tx.odooPricelist.update({
            where: { id },
            data: { active: false, updatedAt: new Date(), updatedBy: user.name || user.email },
          })
        }
        return { result, before, after }
      })

      // 客户 chatter：沿用客户编辑页写的 pricelistIds before→after 形状，
      // lib/action-log-refs.ts 会把 id 解析成价格表名字显示
      const idsByCustomer = (rows: { customerId: string; pricelistId: string }[]) => {
        const m = new Map<string, string[]>()
        for (const r of rows) m.set(r.customerId, [...(m.get(r.customerId) ?? []), r.pricelistId])
        return m
      }
      const beforeMap = idsByCustomer(before)
      const afterMap = idsByCustomer(after)
      const actionText = replacement ? `替换为「${replacement.name}」` : '移除'
      const customerLogs = [...beforeMap.keys()].map(customerId => ({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE' as const, resource: 'customer', resourceId: customerId,
        detail: `价格表「${source.name}」${archive ? '归档，' : '批量'}${actionText}`,
        changes: { pricelistIds: { before: beforeMap.get(customerId) ?? [], after: afterMap.get(customerId) ?? [] } },
      }))
      try {
        if (customerLogs.length > 0) await prisma.actionLog.createMany({ data: customerLogs })
      } catch {
        // 日志写入不能影响主流程（同 writeLog）
      }

      const moved = result.replaced + result.merged + result.removed
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'pricelist', resourceId: id,
        detail: `${archive ? '归档价格表' : '批量替换价格表客户'}: ${source.name}，${moved} 个客户${actionText}`,
        changes: archive && source.active ? { active: { before: true, after: false } } : undefined,
      })

      return NextResponse.json({ ok: true, ...result, archived: archive })
    } catch (error) {
      console.error('[POST /api/pricelists/[id]/customers]', error)
      return NextResponse.json({ error: '处理价格表客户失败' }, { status: 500 })
    }
  }, { require: 'master.pricelist.update' })
}
