import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog } from '@/lib/action-log'
import { salesRowScope, isRowVisible } from '@/lib/row-scope'
import { normalizeEmail, isValidEmail, MAX_CONTACTS_PER_CUSTOMER } from '@/lib/customer-contacts'
import type { JwtPayload } from '@/lib/auth'

/**
 * 客户联系人。权限沿用 master.customer 的 read_detail / update ——
 * 不为联系人单开权限点：拆细子动作而不同步补给原本够得着的角色，
 * 会让功能对全公司静默中断（20260807 的教训）。
 */

/** 客户存在且当前用户看得见才继续。看不见回 404 而不是 403 —— 403 等于确认这个客户存在 */
async function assertVisibleCustomer(customerId: string, user: JwtPayload) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, name: true, salesUserId: true },
  })
  if (!customer) return null
  if (!isRowVisible(customer, salesRowScope(user))) return null
  return customer
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const customer = await assertVisibleCustomer(id, user)
      if (!customer) return NextResponse.json({ error: '客户不存在' }, { status: 404 })

      const contacts = await prisma.customerContact.findMany({
        where: { customerId: id },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      })
      return NextResponse.json(serializeApi(contacts))
    } catch (error) {
      console.error('[GET /api/customers/[id]/contacts]', error)
      return NextResponse.json({ error: '获取联系人失败' }, { status: 500 })
    }
  }, { require: 'master.customer.read_detail' })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const body = await req.json() as {
        name?: string; email?: string; role?: string; phone?: string
        isPrimary?: boolean; notes?: string
      }

      const customer = await assertVisibleCustomer(id, user)
      if (!customer) return NextResponse.json({ error: '客户不存在' }, { status: 404 })

      const name = String(body.name ?? '').trim()
      const email = normalizeEmail(body.email)
      if (!name) return NextResponse.json({ error: '联系人姓名不能为空' }, { status: 400 })
      if (!isValidEmail(email)) {
        return NextResponse.json({ error: '邮箱格式不正确' }, { status: 400 })
      }

      const existingCount = await prisma.customerContact.count({ where: { customerId: id } })
      if (existingCount >= MAX_CONTACTS_PER_CUSTOMER) {
        return NextResponse.json(
          { error: `一个客户最多 ${MAX_CONTACTS_PER_CUSTOMER} 个联系人` },
          { status: 400 },
        )
      }
      const dup = await prisma.customerContact.findFirst({ where: { customerId: id, email } })
      if (dup) return NextResponse.json({ error: '该邮箱已在此客户名下' }, { status: 409 })

      // 第一个联系人自动成为主联系人 —— 否则建完一个人却没有默认收件人，
      // 发邮件时弹窗是空选中状态，用户还得回来再点一次
      const isPrimary = body.isPrimary === true || existingCount === 0

      const contact = await prisma.$transaction(async (tx) => {
        if (isPrimary) {
          // partial unique index 只允许一条 isPrimary，先把旧的摘掉
          await tx.customerContact.updateMany({
            where: { customerId: id, isPrimary: true },
            data: { isPrimary: false },
          })
        }
        return tx.customerContact.create({
          data: {
            customerId: id,
            name: name.slice(0, 100),
            email,
            role: String(body.role ?? '').trim().slice(0, 50),
            phone: String(body.phone ?? '').trim().slice(0, 50),
            isPrimary,
            notes: body.notes ? String(body.notes).slice(0, 500) : null,
          },
        })
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'customer', resourceId: id,
        detail: `新增联系人 ${contact.name}（${contact.email}）${isPrimary ? ' — 设为主联系人' : ''}`,
      })

      return NextResponse.json(serializeApi(contact), { status: 201 })
    } catch (error) {
      console.error('[POST /api/customers/[id]/contacts]', error)
      return NextResponse.json({ error: '新增联系人失败' }, { status: 500 })
    }
  }, { require: 'master.customer.update' })
}
