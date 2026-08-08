import { Resend } from 'resend'
import { eur } from './format-money'

/**
 * 发件地址。⛔ 不要写死 —— 域名必须在 Resend 验证过，否则 API 直接 403，
 * 一封都发不出去。2026-08-08 实测 `veggiesupply.ie` 从未验证过，也就是说在此之前
 * 生产上的订单确认 / 密码重置 / 采购 RFQ 三处**全部**是发不出去的。
 *
 * 迁到客户自有服务器后照样靠环境变量注入，不依赖任何云厂商的配置中心。
 */
const FROM = process.env.EMAIL_FROM || 'Johnstone Bros <noreply@johnstonebros.ie>'

function getResend() {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set')
  return new Resend(process.env.RESEND_API_KEY)
}

export interface EmailAttachment {
  filename: string
  content: Buffer
}

/**
 * 所有发信的唯一出口。
 *
 * ⛔ Resend SDK 失败时**不抛异常**，而是把错误放进返回值的 `error` 字段。
 * 只 `await` 不看返回值 = 发送失败被静默咽掉，调用方以为发成功了。
 * 这里统一把它翻译成异常，让调用方的 try/catch 真正有意义。
 */
async function dispatch(payload: {
  to: string | string[]
  cc?: string[]
  subject: string
  html: string
  attachments?: EmailAttachment[]
  replyTo?: string
}): Promise<{ id: string }> {
  const { error, data } = await getResend().emails.send({
    from: FROM,
    to: payload.to,
    ...(payload.cc?.length ? { cc: payload.cc } : {}),
    ...(payload.replyTo ? { replyTo: payload.replyTo } : {}),
    subject: payload.subject,
    html: payload.html,
    ...(payload.attachments?.length ? { attachments: payload.attachments } : {}),
  })

  if (error) {
    throw new Error(`[resend] ${error.name}: ${error.message}`)
  }
  if (!data?.id) {
    throw new Error('[resend] 发送未返回消息 id，无法确认是否送达')
  }
  return { id: data.id }
}

export async function sendOrderConfirmation(params: {
  to: string
  customerName: string
  orderId: string
  items: { name: string; qty: number; unit: string; price: number }[]
  total: number
}) {
  const { to, customerName, orderId, items, total } = params

  const itemRows = items
    .map(
      (i) =>
        `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${i.name}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:center">${i.qty} ${i.unit}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right">${eur(i.price * i.qty)}</td></tr>`
    )
    .join('')

  await dispatch({
    to,
    subject: `订单确认 #${orderId.slice(-6).toUpperCase()} — VeggieSupply`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#16a34a">VeggieSupply 订单确认</h2>
        <p>您好 ${customerName}，</p>
        <p>您的订单已收到，我们将尽快处理。</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <thead>
            <tr style="background:#f3f4f6">
              <th style="padding:8px 12px;text-align:left">商品</th>
              <th style="padding:8px 12px;text-align:center">数量</th>
              <th style="padding:8px 12px;text-align:right">小计</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
          <tfoot>
            <tr>
              <td colspan="2" style="padding:10px 12px;font-weight:bold">合计</td>
              <td style="padding:10px 12px;font-weight:bold;text-align:right">${eur(total)}</td>
            </tr>
          </tfoot>
        </table>
        <p style="color:#6b7280;font-size:14px">订单编号：${orderId}</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
        <p style="color:#9ca3af;font-size:12px">VeggieSupply Ireland · 如有问题请联系您的销售代表</p>
      </div>
    `,
  })
}

export async function sendPasswordReset(params: {
  to: string
  userName: string
  tempPassword: string
}) {
  const { to, userName, tempPassword } = params

  await dispatch({
    to,
    subject: '您的 VeggieSupply 临时密码',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#16a34a">VeggieSupply 密码重置</h2>
        <p>您好 ${userName}，</p>
        <p>您的账号密码已被管理员重置。请使用以下临时密码登录，登录后请立即修改密码。</p>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:20px 0;text-align:center">
          <p style="margin:0 0 8px;color:#15803d;font-size:12px">临时密码</p>
          <code style="font-size:28px;font-weight:bold;letter-spacing:4px;color:#14532d">${tempPassword}</code>
        </div>
        <p style="color:#ef4444;font-size:13px">⚠️ 此密码仅显示一次，请妥善保管。</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
        <p style="color:#9ca3af;font-size:12px">VeggieSupply Ireland · 如非本人操作，请联系管理员</p>
      </div>
    `,
  })
}

export async function sendPurchaseOrderRfq(params: {
  to: string
  poName: string
  supplierName: string
  pdfBuffer: Buffer
}) {
  const { to, poName, supplierName, pdfBuffer } = params

  await dispatch({
    to,
    subject: `Request for Quotation ${poName} — VeggieSupply`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#16a34a">VeggieSupply — Request for Quotation</h2>
        <p>Dear ${supplierName},</p>
        <p>Please find attached our request for quotation <strong>${poName}</strong>. Kindly review the items and quantities and let us know your confirmed pricing and availability at your earliest convenience.</p>
        <p>If you have any questions, please reply to this email or contact your usual VeggieSupply contact.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
        <p style="color:#9ca3af;font-size:12px">VeggieSupply Ireland</p>
      </div>
    `,
    attachments: [
      { filename: `${poName}.pdf`, content: pdfBuffer },
    ],
  })
}

/**
 * 把报价单 / 销售单当作 PDF 附件发给客户。
 *
 * 报价单与销售单是同一个 Order（PENDING 是报价单，确认后是销售单），
 * 只有措辞不同 —— 所以是一个函数带 `isQuotation` 开关，不是两份几乎相同的模板。
 *
 * `replyTo` 传发送人自己的邮箱：客户回复时直接回到经办的销售手上，
 * 而不是回到那个没人看的 noreply 信箱。
 */
export async function sendOrderDocument(params: {
  to: string
  cc?: string[]
  customerName: string
  orderCode: string
  isQuotation: boolean
  total: number
  pdfBuffer: Buffer
  senderName: string
  replyTo?: string
}) {
  const { to, cc, customerName, orderCode, isQuotation, total, pdfBuffer, senderName, replyTo } = params
  const docLabel = isQuotation ? 'Quotation' : 'Order Confirmation'

  await dispatch({
    to,
    cc,
    replyTo,
    subject: `${docLabel} ${orderCode} — Johnstone Bros`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#16a34a">Johnstone Bros — ${docLabel}</h2>
        <p>Dear ${customerName},</p>
        <p>Please find attached ${isQuotation ? 'our quotation' : 'your order confirmation'} <strong>${orderCode}</strong>, total <strong>${eur(total)}</strong> (incl. VAT).</p>
        <p>${isQuotation
          ? 'Please review the items and prices and let us know if you would like to proceed.'
          : 'We will be in touch regarding delivery. If anything looks incorrect, please reply to this email as soon as possible.'}</p>
        <p>Kind regards,<br/>${senderName}<br/>Johnstone Bros</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
        <p style="color:#9ca3af;font-size:12px">Johnstone Bros · Wholesale Fresh Produce &amp; Grocery</p>
      </div>
    `,
    attachments: [
      { filename: `${orderCode}.pdf`, content: pdfBuffer },
    ],
  })
}
