import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { buildCsv, csvResponseHeaders } from '@/lib/export/csv'

const PAGE_SIZE = 1000
const HEADERS = [
  'Number',
  'Invoice Date',
  'Source Document',
  'Partner/Sage Account',
  'Partner/Display Name',
  'Total in Invoice Currency',
  'Tax in Invoice Currency',
] as const

function sageDate(postedAt: string | null, createdAt: Date): string {
  const value = postedAt ? new Date(postedAt) : createdAt
  if (Number.isNaN(value.getTime())) return ''
  const day = String(value.getUTCDate()).padStart(2, '0')
  const month = String(value.getUTCMonth() + 1).padStart(2, '0')
  return `${day}/${month}/${value.getUTCFullYear()}`
}

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(buildCsv(HEADERS, [])))
          let cursor: string | undefined

          while (true) {
            const invoices = await prisma.invoice.findMany({
              where: { status: { in: ['POSTED', 'PAID'] } },
              select: {
                id: true,
                name: true,
                createdAt: true,
                postedAt: true,
                customerId: true,
                customerName: true,
                saleOrderIds: true,
                totalIncTax: true,
                totalTax: true,
              },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: PAGE_SIZE,
              ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            })
            if (invoices.length === 0) break

            const customerIds = [...new Set(invoices.map(invoice => invoice.customerId))]
            const orderIds = [...new Set(invoices.flatMap(invoice => invoice.saleOrderIds))]
            const [customers, orders] = await Promise.all([
              prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, sageAccount: true } }),
              orderIds.length
                ? prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, code: true } })
                : Promise.resolve([]),
            ])
            const sageAccountByCustomer = new Map(customers.map(customer => [customer.id, customer.sageAccount ?? '']))
            const orderCodeById = new Map(orders.map(order => [order.id, order.code ?? order.id.slice(-6).toUpperCase()]))
            const rows = invoices.map(invoice => [
              invoice.name,
              sageDate(invoice.postedAt, invoice.createdAt),
              invoice.saleOrderIds.map(id => orderCodeById.get(id)).filter(Boolean).join(', '),
              sageAccountByCustomer.get(invoice.customerId) ?? '',
              invoice.customerName,
              Number(invoice.totalIncTax).toFixed(2),
              Number(invoice.totalTax) === 0 ? '' : Number(invoice.totalTax).toFixed(2),
            ])
            controller.enqueue(encoder.encode(buildCsv([], rows).replace(/^\uFEFF\r\n/, '')))
            cursor = invoices[invoices.length - 1].id
            if (invoices.length < PAGE_SIZE) break
          }
          controller.close()
        } catch (error) {
          console.error('[GET /api/invoices/sage-export]', error)
          controller.error(error)
        }
      },
    })

    return new Response(body, {
      headers: {
        ...csvResponseHeaders(`Sage_Invoices_${new Date().toISOString().slice(0, 10)}.csv`),
        'Cache-Control': 'no-store',
      },
    })
  }, { require: 'finance.invoice.read' })
}
