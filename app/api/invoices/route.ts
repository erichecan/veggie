import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writebackInvoicedQty } from '@/lib/invoice-invoiced-qty'

/**
 * 不分页调用的兜底上限。
 *
 * 由来（2026-08-05 实测）：这个路由原本无分页也无上限，一次返回全部 148,285 张发票
 * 的**全字段**（`lines` 是 Json，存着整张发票的明细）= 74 MB / 10 秒，且单次请求就把
 * 应用容器内存从 408 MB 推到 1.09 GiB —— 两个人同时打开发票页就会 OOM。
 *
 * 所以这个上限不是"优化"，是**安全阀**：即使将来有人写了个不带分页的新调用方，
 * 也不能再把内存拉爆。要全量请显式分页翻页。
 */
const FLAT_LIMIT = 500

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const customerId = searchParams.get('customerId')
    // ?slim=1 → only id + saleOrderIds (used by orders/quotations pages to detect invoiced orders)
    const slim = searchParams.get('slim') === '1'
    // ?orderIds=a,b,c → 只回传涉及这些订单的发票。配合 slim 用于"这批订单开票了没"，
    // 不必再为判断 20 张单的开票状态而扫全表。
    const orderIdsRaw = searchParams.get('orderIds')?.trim()
    const orderIds = orderIdsRaw ? orderIdsRaw.split(',').map((s) => s.trim()).filter(Boolean) : null

    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
    const rawPageSize = parseInt(searchParams.get('pageSize') ?? '0', 10)
    const paginated = Number.isFinite(rawPageSize) && rawPageSize > 0
    const pageSize = paginated ? Math.min(200, Math.max(1, rawPageSize)) : 0

    const where: Record<string, unknown> = {}
    if (customerId) where.customerId = customerId
    // saleOrderIds 是 String[]，hasSome 命中"这张发票涉及了其中任一订单"
    if (orderIds && orderIds.length > 0) where.saleOrderIds = { hasSome: orderIds }

    if (slim) {
      const invoices = await prisma.invoice.findMany({
        where,
        select: { id: true, saleOrderIds: true },
        orderBy: { createdAt: 'desc' },
        // 按 orderIds 精确查时不截断（结果集本来就小）；否则套用安全阀
        take: orderIds ? undefined : FLAT_LIMIT,
      })
      return NextResponse.json(serializeApi(invoices))
    }

    // 分页模式：返回 { data, total, page, pageSize, totalPages }，与 /api/customers 一致
    if (paginated) {
      const [total, invoices] = await Promise.all([
        prisma.invoice.count({ where }),
        prisma.invoice.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ])
      return NextResponse.json(serializeApi({
        data: invoices,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      }))
    }

    // Legacy：不传 pageSize 仍返回 flat array（保持旧调用方不炸），但受 FLAT_LIMIT 约束
    const invoices = await prisma.invoice.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: FLAT_LIMIT,
    })
    return NextResponse.json(serializeApi(invoices))
  } catch (error) {
    console.error('[GET /api/invoices]', error)
    return NextResponse.json({ error: '获取发票失败' }, { status: 500 })
  }
}

/**
 * POST /api/invoices
 * ── 商业级修复 ─────────────────────────────────────────────────────────
 * 1. 服务端重算金额：subtotalExTax / totalTax / totalIncTax / amountDue 由后端根据 lines 权威计算
 *    前端传入金额仅作参考；与服务端偏差 > €0.01 按服务端为准
 * 2. 事务：发票创建 + 源订单状态更新（saleOrderIds → 该订单的 invoice 外链信息）作为原子事务
 * 3. amountPaid 默认 0；amountDue = totalIncTax
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

interface InboundLine {
  orderLineId?: string
  productId?: string
  productName?: string
  spec?: string
  qty?: number
  quantity?: number
  unitPrice?: number
  taxRate?: number
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()

      const name = String(data.name ?? '').trim().slice(0, 100)
      const customerId = String(data.customerId ?? '').trim()
      const customerName = String(data.customerName ?? '').trim().slice(0, 200)
      if (!name) return NextResponse.json({ error: '发票号不能为空' }, { status: 400 })
      if (!customerId) return NextResponse.json({ error: '客户 ID 不能为空' }, { status: 400 })

      const rawLines = Array.isArray(data.lines) ? data.lines : []
      if (rawLines.length === 0) {
        return NextResponse.json({ error: '发票行不能为空' }, { status: 400 })
      }

      // 服务端重算每一行
      let subtotalExTax = 0
      let totalTax = 0
      const recomputedLines = rawLines.map((raw: InboundLine) => {
        const qty = Number(raw.qty ?? raw.quantity ?? 0)
        const unitPrice = Number(raw.unitPrice ?? 0)
        // taxRate 兼容两种存法：百分数(>1，如 23)归一为小数(0.23)；发票内部一律以小数计税
        const taxRateRaw = Number(raw.taxRate ?? 0)
        const taxRate = taxRateRaw > 1 ? taxRateRaw / 100 : taxRateRaw
        if (!Number.isFinite(qty) || qty <= 0 || qty > 100_000) {
          throw Object.assign(new Error(`发票行数量无效：${raw.productName ?? raw.productId}`), { status: 400 })
        }
        if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 1_000_000) {
          throw Object.assign(new Error(`发票行单价无效：${raw.productName ?? raw.productId}`), { status: 400 })
        }
        if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) {
          throw Object.assign(new Error(`发票行税率无效：${raw.productName ?? raw.productId}`), { status: 400 })
        }
        const exTax = round2(qty * unitPrice)
        const taxAmt = round2(exTax * taxRate)
        const incTax = round2(exTax + taxAmt)
        subtotalExTax += exTax
        totalTax += taxAmt
        return {
          // B-2: 保留前端传入的 orderLineId(若有),供过账按行回写 invoicedQty
          ...(raw.orderLineId ? { orderLineId: String(raw.orderLineId) } : {}),
          productId: String(raw.productId ?? ''),
          productName: String(raw.productName ?? '').trim().slice(0, 200),
          spec: String(raw.spec ?? '').trim().slice(0, 100),
          qty,
          unitPrice,
          taxRate,
          subtotalExTax: exTax,
          taxAmount: taxAmt,
          subtotalIncTax: incTax,
        }
      })
      subtotalExTax = round2(subtotalExTax)
      totalTax = round2(totalTax)
      const totalIncTax = round2(subtotalExTax + totalTax)

      const saleOrderIds: string[] = Array.isArray(data.saleOrderIds) ? data.saleOrderIds : []

      // 事务：发票创建 + 回写 OrderLine.invoicedQty = deliveredQty
      const invoice = await prisma.$transaction(async (tx) => {
        const created = await tx.invoice.create({
          data: {
            name,
            customerId,
            customerName,
            saleOrderIds,
            lines: recomputedLines as unknown as object,
            subtotalExTax,
            totalTax,
            totalIncTax,
            amountPaid: 0,
            amountDue: totalIncTax,
            status: String(data.status ?? 'DRAFT').toUpperCase() as 'DRAFT',
            paymentTerms: String(data.paymentTerms ?? 'monthly'),
            dueDate: data.dueDate ?? null,
          },
        })

        // 回写：开票数量 = 已交货数量(B-2: 优先按发票行 orderLineId 精确到行,回退整单)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await writebackInvoicedQty(tx as any, recomputedLines, saleOrderIds)

        return created
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'invoice', resourceId: invoice.id,
        detail: `创建发票: ${invoice.name}, 金额 €${totalIncTax}`,
      })

      return NextResponse.json(serializeApi(invoice), { status: 201 })
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: err.status })
      }
      console.error('[POST /api/invoices]', error)
      return NextResponse.json({ error: '创建发票失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'FINANCE', 'BOSS'])
}
