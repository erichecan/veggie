import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { buildCsv, csvResponseHeaders } from '@/lib/export/csv'

const HEADERS = [
  'Number',
  'Invoice Date',
  'Source Document',
  'Partner/Sage Account',
  'Partner/Display Name',
  'Total in Invoice Currency',
  'Tax in Invoice Currency',
] as const

function sageDate(invoiceDate: Date): string {
  const value = invoiceDate
  if (Number.isNaN(value.getTime())) return ''
  const day = String(value.getUTCDate()).padStart(2, '0')
  const month = String(value.getUTCMonth() + 1).padStart(2, '0')
  return `${day}/${month}/${value.getUTCFullYear()}`
}

export async function POST(req: Request) {
  return withAuth(req, async () => {
    try {
      const data = await req.json()
      const ids: string[] = Array.from(new Set<string>(
        (Array.isArray(data?.invoiceIds) ? data.invoiceIds : [])
          .map((id: unknown) => String(id).trim())
          .filter(Boolean),
      ))
      if (ids.length < 1 || ids.length > 500) {
        return NextResponse.json({ error: '请选择 1 至 500 张发票进行 Sage 导出' }, { status: 400 })
      }

      const invoices = await prisma.invoice.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          name: true,
          status: true,
          invoiceDate: true,
          customerId: true,
          customerName: true,
          saleOrderIds: true,
          totalIncTax: true,
          totalTax: true,
        },
      })
      if (invoices.length !== ids.length) {
        return NextResponse.json({ error: '部分所选发票不存在，请刷新列表后重试' }, { status: 404 })
      }
      const invalid = invoices.find(invoice => invoice.status !== 'POSTED' && invoice.status !== 'PAID')
      if (invalid) {
        return NextResponse.json({ error: `发票 ${invalid.name} 尚未过账，不能导出到 Sage` }, { status: 409 })
      }

      // 保持用户列表中勾选的顺序，避免导出结果顺序与所选记录不同。
      const byId = new Map(invoices.map(invoice => [invoice.id, invoice]))
      const selected = ids.map(id => byId.get(id)!)
      const customerIds = [...new Set(selected.map(invoice => invoice.customerId))]
      const orderIds = [...new Set(selected.flatMap(invoice => invoice.saleOrderIds))]
      const [customers, orders] = await Promise.all([
        prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, sageAccount: true } }),
        orderIds.length
          ? prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, code: true } })
          : Promise.resolve([]),
      ])
      const sageAccountByCustomer = new Map(customers.map(customer => [customer.id, customer.sageAccount ?? '']))
      const orderCodeById = new Map(orders.map(order => [order.id, order.code ?? order.id.slice(-6).toUpperCase()]))
      const rows = selected.map(invoice => [
        invoice.name,
        sageDate(invoice.invoiceDate),
        invoice.saleOrderIds.map(id => orderCodeById.get(id)).filter(Boolean).join(', '),
        sageAccountByCustomer.get(invoice.customerId) ?? '',
        invoice.customerName,
        Number(invoice.totalIncTax).toFixed(2),
        Number(invoice.totalTax) === 0 ? '' : Number(invoice.totalTax).toFixed(2),
      ])

      return new Response(buildCsv(HEADERS, rows), {
        headers: {
          ...csvResponseHeaders(`Sage_Invoices_${new Date().toISOString().slice(0, 10)}.csv`),
          'Cache-Control': 'no-store',
        },
      })
    } catch (error) {
      console.error('[POST /api/invoices/sage-export]', error)
      return NextResponse.json({ error: 'Sage 导出失败' }, { status: 500 })
    }
  }, { require: 'finance.invoice.read' })
}
