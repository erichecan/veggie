import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog } from '@/lib/action-log'
import { salesRowScope, isRowVisible } from '@/lib/row-scope'
import { normalizeEmail, isValidEmail } from '@/lib/customer-contacts'
import type { JwtPayload } from '@/lib/auth'

/**
 * 单个客户联系人的改 / 删。
 *
 * ⛔ 每个动作都必须先确认「这个联系人确实挂在 URL 里那个客户名下」，
 * 而不是只按 cid 查。否则拿到任意 cid 就能改别人客户的联系人 ——
 * 路径里的 customerId 会退化成纯装饰。
 */
async function loadContact(customerId: string, contactId: string, user: JwtPayload) {
  const contact = await prisma.customerContact.findUnique({
    where: { id: contactId },
    include: { customer: { select: { id: true, salesUserId: true } } },
  })
  if (!contact) return null
  if (contact.customerId !== customerId) return null
  if (!isRowVisible(contact.customer, salesRowScope(user))) return null
  return contact
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; cid: string }> },
) {
  const { id, cid } = await params
  return withAuth(req, async (user) => {
    try {
      const body = await req.json() as {
        name?: string; email?: string; role?: string; phone?: string
        isPrimary?: boolean; isActive?: boolean; notes?: string
      }

      const before = await loadContact(id, cid, user)
      if (!before) return NextResponse.json({ error: '联系人不存在' }, { status: 404 })

      const data: Record<string, unknown> = {}
      if (typeof body.name === 'string') {
        const name = body.name.trim()
        if (!name) return NextResponse.json({ error: '联系人姓名不能为空' }, { status: 400 })
        data.name = name.slice(0, 100)
      }
      if (typeof body.email === 'string') {
        const email = normalizeEmail(body.email)
        if (!isValidEmail(email)) {
          return NextResponse.json({ error: '邮箱格式不正确' }, { status: 400 })
        }
        const dup = await prisma.customerContact.findFirst({
          where: { customerId: id, email, id: { not: cid } },
        })
        if (dup) return NextResponse.json({ error: '该邮箱已在此客户名下' }, { status: 409 })
        data.email = email
      }
      if (typeof body.role === 'string') data.role = body.role.trim().slice(0, 50)
      if (typeof body.phone === 'string') data.phone = body.phone.trim().slice(0, 50)
      if (typeof body.notes === 'string') data.notes = body.notes.slice(0, 500)
      if (typeof body.isActive === 'boolean') data.isActive = body.isActive

      // 停用主联系人时必须同时卸任 —— 否则「默认收件人」指向一个已停用的人，
      // 发送弹窗默认选中它，点发送才发现它不在候选列表里
      const turningInactive = body.isActive === false && before.isPrimary
      const wantsPrimary = body.isPrimary === true
      if (turningInactive) data.isPrimary = false
      else if (typeof body.isPrimary === 'boolean') data.isPrimary = body.isPrimary

      const updated = await prisma.$transaction(async (tx) => {
        if (wantsPrimary && !turningInactive) {
          await tx.customerContact.updateMany({
            where: { customerId: id, isPrimary: true, id: { not: cid } },
            data: { isPrimary: false },
          })
        }
        return tx.customerContact.update({ where: { id: cid }, data })
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'customer', resourceId: id,
        detail: `修改联系人 ${updated.name}（${updated.email}）`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[PATCH /api/customers/[id]/contacts/[cid]]', error)
      return NextResponse.json({ error: '修改联系人失败' }, { status: 500 })
    }
  }, { require: 'master.customer.update' })
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; cid: string }> },
) {
  const { id, cid } = await params
  return withAuth(req, async (user) => {
    try {
      const contact = await loadContact(id, cid, user)
      if (!contact) return NextResponse.json({ error: '联系人不存在' }, { status: 404 })

      await prisma.$transaction(async (tx) => {
        await tx.customerContact.delete({ where: { id: cid } })
        // 删掉的是主联系人的话，把剩下最早的一个顶上来。
        // 留着「一个联系人都不是主」的状态，发送弹窗就没有默认选中项了。
        if (contact.isPrimary) {
          const next = await tx.customerContact.findFirst({
            where: { customerId: id, isActive: true },
            orderBy: { createdAt: 'asc' },
          })
          if (next) {
            await tx.customerContact.update({
              where: { id: next.id },
              data: { isPrimary: true },
            })
          }
        }
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'customer', resourceId: id,
        detail: `删除联系人 ${contact.name}（${contact.email}）`,
      })

      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/customers/[id]/contacts/[cid]]', error)
      return NextResponse.json({ error: '删除联系人失败' }, { status: 500 })
    }
  }, { require: 'master.customer.update' })
}
