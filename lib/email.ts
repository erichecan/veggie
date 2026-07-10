import { Resend } from 'resend'
import { eur } from './format-money'

const FROM = 'VeggieSupply <noreply@veggiesupply.ie>'

function getResend() {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set')
  return new Resend(process.env.RESEND_API_KEY)
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

  await getResend().emails.send({
    from: FROM,
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

  await getResend().emails.send({
    from: FROM,
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
