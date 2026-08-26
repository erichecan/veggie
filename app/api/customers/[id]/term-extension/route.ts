import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

/**
 * 客户账期临时延期（20260826）——POST 一次即新增一条审批记录并覆盖当前生效值。
 * 只放宽逾期检查与信用额度检查两项，欠款/逾期金额依旧如实计算，不隐藏。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const body = await req.json()
      const days = Number(body.days)
      if (!Number.isFinite(days) || !Number.isInteger(days) || days < 1 || days > 365) {
        return NextResponse.json({ error: '延长天数必须是 1–365 之间的整数' }, { status: 400 })
      }
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null

      const customer = await prisma.customer.findUnique({ where: { id }, select: { id: true, name: true } })
      if (!customer) return NextResponse.json({ error: '客户不存在' }, { status: 404 })

      const until = new Date(Date.now() + days * 86_400_000)

      const [, updated] = await prisma.$transaction([
        prisma.customerTermExtension.create({
          data: {
            customerId: id,
            days,
            until,
            note,
            createdById: user.userId,
            createdByName: user.name,
          },
        }),
        prisma.customer.update({
          where: { id },
          data: { termExtendedUntil: until, termExtendedNote: note },
          select: { id: true, termExtendedUntil: true, termExtendedNote: true },
        }),
      ])

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'customer_term_extension', resourceId: id,
        detail: `延长客户「${customer.name}」账期 ${days} 天，至 ${until.toISOString().slice(0, 10)}${note ? `（${note}）` : ''}`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[POST /api/customers/[id]/term-extension]', error)
      return NextResponse.json({ error: '延长账期失败' }, { status: 500 })
    }
  }, { require: 'master.customer.extend_term' })
}
