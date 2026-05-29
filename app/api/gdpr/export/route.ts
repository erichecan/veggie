import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { toNum } from '@/lib/decimal-helpers'

/**
 * GET /api/gdpr/export?subject=USER_ID  → 导出该用户全部数据（JSON）
 *     /api/gdpr/export?subject=customerId:XXX → 导出该客户全部数据
 * ============================================================================
 * GDPR Article 15 (Right of access) + Article 20 (Data portability)
 *
 * 返回：JSON 文件下载，包含该主体的所有个人数据：
 *   - 基本资料（user/customer）
 *   - 订单历史
 *   - 发票
 *   - 审计日志中 user/resource=该用户的所有条目
 *
 * 权限：只有本人能导出自己的数据；或 OPERATOR/BOSS 能代导（需审计记录）
 */

export async function GET(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const url = new URL(req.url)
      const subjectParam = url.searchParams.get('subject') ?? ''
      const isCustomer = subjectParam.startsWith('customerId:')
      const subjectId = isCustomer ? subjectParam.slice('customerId:'.length) : subjectParam

      if (!subjectId) {
        return NextResponse.json({ error: '缺少 subject 参数' }, { status: 400 })
      }

      // 权限校验：非本人访问只允许 OPERATOR/BOSS
      const isSelf = (!isCustomer && subjectId === user.userId)
                  || (isCustomer && subjectId === user.customerId)
      const isPrivileged = ['OPERATOR', 'BOSS'].includes(user.role)
      if (!isSelf && !isPrivileged) {
        return NextResponse.json({ error: '无权导出他人数据' }, { status: 403 })
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      const customerId = isCustomer
        ? subjectId
        : (await p.user.findUnique({ where: { id: subjectId } }))?.customerId ?? null

      const [profile, orders, invoices, logs, restaurantUsers] = await Promise.all([
        customerId ? p.customer.findUnique({ where: { id: customerId }, include: { specialPrices: true } }) : null,
        customerId ? (async () => {
          const us = await p.user.findMany({ where: { customerId }, select: { id: true } })
          const ids = us.map((u: { id: string }) => u.id)
          if (ids.length === 0) return []
          return p.order.findMany({ where: { restaurantId: { in: ids } }, orderBy: { createdAt: 'desc' } })
        })() : [],
        customerId ? p.invoice.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' } }) : [],
        p.actionLog.findMany({
          where: isCustomer
            ? { OR: [{ resource: 'customer', resourceId: customerId }] }
            : { userId: subjectId },
          orderBy: { createdAt: 'desc' },
        }),
        customerId ? p.user.findMany({ where: { customerId } }) : [],
      ])

      // Decimal → number
      const normalize = (x: unknown): unknown => {
        if (Array.isArray(x)) return x.map(normalize)
        if (x && typeof x === 'object') {
          const obj = x as Record<string, unknown>
          const out: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(obj)) {
            if (v && typeof v === 'object' && 'toNumber' in (v as object)) {
              out[k] = toNum(v)
            } else if (v instanceof Date) {
              out[k] = v.toISOString()
            } else {
              out[k] = normalize(v)
            }
          }
          return out
        }
        return x
      }

      const payload = normalize({
        exportedAt: new Date().toISOString(),
        subject: { type: isCustomer ? 'customer' : 'user', id: subjectId },
        profile,
        orders,
        invoices,
        actionLogs: logs,
        relatedUsers: restaurantUsers.map((u: Record<string, unknown>) => ({
          id: u.id, email: u.email, role: u.role, name: u.name,
        })),
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'gdpr_export', resourceId: subjectId,
        detail: `GDPR 导出 ${isCustomer ? 'customer' : 'user'}=${subjectId}`,
      })

      const json = JSON.stringify(payload, null, 2)
      return new Response(json, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="gdpr-export-${subjectId}.json"`,
        },
      })
    } catch (error) {
      console.error('[GDPR export]', error)
      return NextResponse.json({ error: '导出失败' }, { status: 500 })
    }
  })
}
