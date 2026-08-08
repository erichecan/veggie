import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { salesRowScope, isRowVisible } from '@/lib/row-scope'
import { formatDriverSlotFromOrder } from '@/lib/driver-slot'
import { getOrderWaveDisplayMap } from '@/lib/wave-assign'
import { renderOrderHtml, type OrderDocInput } from '@/lib/order-pdf'
import { renderHtmlToPdf } from '@/lib/print/render-pdf'
import { sendOrderDocument } from '@/lib/email'
import { normalizeEmail, MAX_RECIPIENTS_PER_EMAIL } from '@/lib/customer-contacts'

/**
 * 把报价单 / 销售单发给客户。
 *
 * 权限沿用 `sales.order.print` —— 发邮件和打印是同一件事的两种交付方式
 * （把单据交给客户），不为它单开权限点：新权限点若没配给任何角色就是个死开关。
 */
/**
 * 候选收件人。前端发送弹窗调它，而不是去调 /api/customers/[id]/contacts ——
 * 后者要 master.customer.read_detail，而 print_center 这类有打印权限的角色未必有它，
 * 那样弹窗会对一部分本该能发邮件的人空掉。权限口径必须和发送动作一致。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const order = await prisma.order.findUnique({
        where: { id },
        // ⛔ salesUser.managerId 必须 select：isRowVisible 判 TEAM 范围靠它，
        //    不取的话 sales_manager 会被保守拒绝，看不到下属的单。
        select: {
          id: true, restaurantId: true, salesUserId: true, status: true,
          salesUser: { select: { managerId: true } },
        },
      })
      if (!order) return NextResponse.json({ error: '订单不存在' }, { status: 404 })
      if (!isRowVisible(order, salesRowScope(user))) {
        return NextResponse.json({ error: '订单不存在' }, { status: 404 })
      }

      const customer = order.restaurantId
        ? await prisma.customer.findUnique({
            where: { id: order.restaurantId },
            select: { id: true, name: true, email: true },
          })
        : null
      if (!customer) return NextResponse.json({ customerName: null, recipients: [] })

      const contacts = await prisma.customerContact.findMany({
        where: { customerId: customer.id, isActive: true },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        select: { id: true, name: true, email: true, role: true, isPrimary: true },
      })

      const recipients: Array<{
        email: string; name: string; role: string
        isPrimary: boolean; source: 'contact' | 'customer'
      }> = contacts.map((c) => ({
        email: normalizeEmail(c.email),
        name: c.name,
        role: c.role,
        isPrimary: c.isPrimary,
        source: 'contact',
      }))

      // 客户档案上的默认邮箱：联系人表建立之前就有的那一个。
      // 已经在联系人里出现过就不重复列 —— 弹窗里出现两行一样的邮箱很困惑。
      const fallback = normalizeEmail(customer.email)
      if (fallback && !recipients.some((r) => r.email === fallback)) {
        recipients.push({
          email: fallback,
          name: customer.name,
          role: '客户档案邮箱',
          isPrimary: recipients.length === 0,
          source: 'customer',
        })
      }

      return NextResponse.json({
        customerName: customer.name,
        isQuotation: order.status === 'PENDING',
        recipients,
      })
    } catch (error) {
      console.error('[GET /api/orders/[id]/send-email]', error)
      return NextResponse.json({ error: '获取收件人失败' }, { status: 500 })
    }
  }, { require: 'sales.order.print' })
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const body = await req.json().catch(() => ({})) as { to?: unknown; cc?: unknown }

      const order = await prisma.order.findUnique({
        where: { id },
        include: {
          lines: { orderBy: { sequence: 'asc' } },
          driverSlot: { select: { id: true, batchNum: true, timeOfDay: true, driverName: true } },
          // managerId 同上：isRowVisible 的 TEAM 判定要用
          salesUser: { select: { id: true, name: true, managerId: true } },
        },
      })
      if (!order) return NextResponse.json({ error: '订单不存在' }, { status: 404 })
      if (!isRowVisible(order, salesRowScope(user))) {
        return NextResponse.json({ error: '订单不存在' }, { status: 404 })
      }

      const customer = order.restaurantId
        ? await prisma.customer.findUnique({ where: { id: order.restaurantId } })
        : null
      if (!customer) {
        return NextResponse.json(
          { error: 'CUSTOMER_MISSING', message: '该订单没有关联客户，无法发送' },
          { status: 400 },
        )
      }

      // ⛔ 收件人只能取自这个客户名下已登记的邮箱。
      // 不校验的话，这个接口就成了「拿公司域名给任意地址发带客户单据的邮件」的通道 ——
      // 既是数据泄露，也会把发件域拖进垃圾邮件名单。
      const contacts = await prisma.customerContact.findMany({
        where: { customerId: customer.id, isActive: true },
        select: { email: true },
      })
      const allowed = new Set<string>(contacts.map((c) => normalizeEmail(c.email)))
      // Customer.email 也算 —— 它是联系人表建立之前就有的默认邮箱，仍在被采购 RFQ 等处使用
      const fallback = normalizeEmail(customer.email)
      if (fallback) allowed.add(fallback)

      if (allowed.size === 0) {
        return NextResponse.json(
          { error: 'NO_RECIPIENT_AVAILABLE', message: '该客户没有任何邮箱，请先在客户资料里添加联系人' },
          { status: 400 },
        )
      }

      const to = normalizeEmail(body.to)
      const ccRaw = Array.isArray(body.cc) ? body.cc.map(normalizeEmail).filter(Boolean) : []
      // 去重，并且不让同一个地址既是收件人又是抄送 —— 客户会收到两封一模一样的
      const cc = [...new Set(ccRaw)].filter((e) => e !== to)

      if (!to) {
        return NextResponse.json({ error: '请选择主收件人' }, { status: 400 })
      }
      const notAllowed = [to, ...cc].filter((e) => !allowed.has(e))
      if (notAllowed.length > 0) {
        return NextResponse.json(
          { error: 'RECIPIENT_NOT_ALLOWED', message: `以下邮箱不在该客户名下：${notAllowed.join('、')}` },
          { status: 400 },
        )
      }
      if (1 + cc.length > MAX_RECIPIENTS_PER_EMAIL) {
        return NextResponse.json(
          { error: `收件人总数不能超过 ${MAX_RECIPIENTS_PER_EMAIL} 个` },
          { status: 400 },
        )
      }

      const waveDisplay = await getOrderWaveDisplayMap([order.id])
      const deliveryBatch = formatDriverSlotFromOrder({
        ...(order as unknown as { driverSlot?: { id: string; batchNum: number; timeOfDay: string; driverName: string } | null; deliveryBatch?: string | null }),
        deliveryBatchDisplay: waveDisplay[order.id] ?? null,
      })

      const orderCode = (order as unknown as { code?: string }).code ?? order.id.slice(-8).toUpperCase()
      const lines = order.lines ?? []
      const subtotal = lines.reduce((s, l) => s + Number(l.subtotal), 0)
      const totalIncVat = lines.reduce(
        (s, l) => s + Number(l.subtotal) * (1 + Number(l.taxRate ?? 0) / 100),
        0,
      )

      // ⛔ 渲染或发送失败都必须让整个请求失败。
      // 采购单 RFQ 那段注释写着「不允许界面显示已发送但实际没发」，但因为 Resend SDK
      // 不抛异常，它防的正是它自己没防住的东西（见 lib/email.ts 的 dispatch）。
      // 这里靠 dispatch 抛异常 + 下面这个 catch 真正兜住。
      try {
        const pdfBuffer = await renderHtmlToPdf(
          renderOrderHtml(order as unknown as OrderDocInput, customer, deliveryBatch),
        )
        await sendOrderDocument({
          to,
          cc,
          customerName: customer.name,
          orderCode,
          isQuotation: order.status === 'PENDING',
          total: totalIncVat || subtotal,
          pdfBuffer,
          senderName: user.name,
          replyTo: user.email,
        })
      } catch (err) {
        console.error('[POST /api/orders/[id]/send-email] 发送失败', err)
        return NextResponse.json(
          {
            error: 'EMAIL_SEND_FAILED',
            message: err instanceof Error && /not verified/i.test(err.message)
              ? '发件域尚未在邮件服务商处验证，邮件发不出去。请联系管理员配置 DNS。'
              : '邮件发送失败，请稍后重试',
          },
          { status: 502 },
        )
      }

      // 只有真发出去了才留痕 —— 留痕写在 try 里面的话，失败也会记一笔"已发送"
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'order', resourceId: order.id,
        detail: `邮件发送单据 ${orderCode} → ${to}${cc.length ? `（抄送 ${cc.join('、')}）` : ''}`,
      })

      return NextResponse.json({ ok: true, to, cc })
    } catch (error) {
      console.error('[POST /api/orders/[id]/send-email]', error)
      return NextResponse.json({ error: '发送失败' }, { status: 500 })
    }
  }, { require: 'sales.order.print' })
}
