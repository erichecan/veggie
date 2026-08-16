import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { forgetPermVersions } from '@/lib/rbac/perm-version'

/**
 * POST /api/gdpr/delete
 * ============================================================================
 * GDPR Article 17 (Right to erasure / "Right to be forgotten")
 *
 * 对 B2B 财务数据，完全物理删除会破坏发票/对账链——
 * 我们的策略是 "匿名化 + 停用"：
 *   1) Customer 表：name → "DELETED USER <shortId>"，email/phone/vat/address 清空；isActive=false
 *   2) User 表：email → <shortId>@deleted.local，name → "Deleted User"，passwordHash 改为不可用占位；isActive=false
 *   3) Invoice/Order 等保留（业务审计需要），仅关联资料脱敏
 *   4) 写审计日志记录删除原因和执行人
 *
 * 权限：OPERATOR/BOSS 可代用户删；FINANCE 用户删自己（自服务场景）
 */

interface DeleteBody {
  subject: string           // "userId:XXX" 或 "customerId:XXX"
  reason: string
  confirmText?: string      // 前端要求输入 "DELETE <subject>" 以防误操作
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const { subject, reason, confirmText }: DeleteBody = await req.json()
      if (!subject) return NextResponse.json({ error: '缺少 subject' }, { status: 400 })
      if (!reason || reason.length < 5) {
        return NextResponse.json({ error: '必须说明删除原因（至少 5 字）' }, { status: 400 })
      }
      if (confirmText !== `DELETE ${subject}`) {
        return NextResponse.json({ error: `请在 confirmText 输入 "DELETE ${subject}" 以确认` }, { status: 400 })
      }

      const isCustomer = subject.startsWith('customerId:')
      const isUser = subject.startsWith('userId:')
      if (!isCustomer && !isUser) {
        return NextResponse.json({ error: 'subject 格式错误，应为 userId:XXX 或 customerId:XXX' }, { status: 400 })
      }
      const targetId = isCustomer ? subject.slice('customerId:'.length) : subject.slice('userId:'.length)

      // 权限：OPERATOR/BOSS 可代删；其他角色只能删自己
      const isPrivileged = ['OPERATOR', 'BOSS'].includes(user.role)
      if (!isPrivileged) {
        const selfMatch = (isUser && targetId === user.userId)
                       || (isCustomer && targetId === user.customerId)
        if (!selfMatch) {
          return NextResponse.json({ error: '无权删除他人数据' }, { status: 403 })
        }
      }

      const shortId = targetId.slice(-8)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      if (isCustomer) {
        await p.customer.update({
          where: { id: targetId },
          data: {
            name: `DELETED CUSTOMER ${shortId}`,
            email: '',
            phone: '',
            vatNumber: '',
            address: '',
            city: null,
            notes: 'GDPR deletion',
            isActive: false,
          },
        })
        // 同时把关联的 user 也脱敏。
        // ⛔ isActive=false 挡的只是**下一次登录**——withAuth 不查这个字段，
        //    已签发的 token 仍有效最长 7 天。对 GDPR 删除来说，"删了还能继续访问"
        //    直接违背 Article 17 的目的，所以必须 permVersion +1 把 token 打掉。
        const linked = await p.user.findMany({
          where: { customerId: targetId },
          select: { id: true },
        })
        await p.user.updateMany({
          where: { customerId: targetId },
          data: { isActive: false, permVersion: { increment: 1 } },
        })
        forgetPermVersions(linked.map((u: { id: string }) => u.id))
      } else {
        await p.user.update({
          where: { id: targetId },
          data: {
            email: `${shortId}@deleted.local`,
            name: 'Deleted User',
            passwordHash: 'DELETED_ACCOUNT_NO_LOGIN',
            isActive: false,
            permVersion: { increment: 1 },
          },
        })
        forgetPermVersions([targetId])
      }

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'gdpr_deletion', resourceId: targetId,
        detail: `GDPR 删除 ${subject}, 原因: ${reason}`,
      })

      return NextResponse.json({
        status: 'ok',
        message: '已匿名化；关联业务单据保留用于审计',
      })
    } catch (error) {
      console.error('[GDPR delete]', error)
      return NextResponse.json({ error: '删除失败' }, { status: 500 })
    }
  }, { require: 'master.customer.delete_gdpr' })
}
