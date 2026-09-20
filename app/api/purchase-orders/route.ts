import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { buildPurchaseOrdersWhere } from '@/lib/purchase-orders-query'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { createPurchaseOrder } from '@/lib/create-purchase-order'

/**
 * /api/purchase-orders
 * ============================================================================
 * 采购订单（Odoo purchase.order）
 *
 * GET  → 列表（支持 supplierId / status / 分页）
 * POST → 新建 RFQ / DRAFT 订单。金额由服务端重算。
 *
 * 工作流：
 *   DRAFT(RFQ) → SENT → CONFIRMED → RECEIVED（通过 GoodsReceipt）→ INVOICED（通过 VendorBill）
 *   任何阶段都可以 CANCELLED（除 RECEIVED 后不建议再撤）
 */

/** 表头可排序的 PurchaseOrder 字段白名单。'supplier' 不在其中——它要按名字排，走内存排序分支。 */
const SORTABLE_FIELDS = new Set(['name', 'orderDate', 'expectedDate', 'status', 'subtotalExTax', 'totalIncTax', 'createdAt'])

/** 按供应商名排序时，愿意一次拉进内存的最大结果集行数 */
const SUPPLIER_SORT_MAX_ROWS = 5000

/** createdBy(userId)[] → Map(id → 录入人显示名)，去重后一次查完。用户被删时回退为 null 由调用方兜底 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadUserNames(p: any, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return new Map()
  const users: { id: string; name: string | null; email: string }[] = await p.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, email: true },
  })
  return new Map(users.map(u => [u.id, u.name || u.email]))
}

/** supplierId[] → Map(id → 供应商名)，去重后一次查完 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSupplierNames(p: any, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return new Map()
  const suppliers: { id: string; name: string }[] = await p.customer.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  })
  return new Map(suppliers.map(s => [s.id, s.name]))
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    // 之前这里只有 take，没有 skip/count —— 列表页(purchases/page.tsx)传的 offset 被静默
    // 无视，翻页永远拿到同一批最新的 limit 条，totalPages 也是按"返回了多少条"算的假值。
    // 上限从 500→5000 那次是拿"一次性多拿点"顶替"全部"视图的真分页；现在有了真分页(skip+count)，
    // 这个顶替不再需要，单页上限收回到合理值。
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') ?? '200', 10)))
    const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10))

    // 筛选口径抽在 lib/purchase-orders-query.ts，导出路由用同一个函数
    const where = await buildPurchaseOrdersWhere(searchParams)

    // 表头排序：白名单之外一律退回 createdAt，避免任意字段名直达 Prisma 变成 500
    const sortDir: 'asc' | 'desc' = searchParams.get('sortDir') === 'asc' ? 'asc' : 'desc'
    const sortFieldRaw = searchParams.get('sortField') ?? ''
    const sortField = SORTABLE_FIELDS.has(sortFieldRaw) ? sortFieldRaw : 'createdAt'

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any

    let rows: Record<string, unknown>[]
    let total: number

    // 供应商名不在 PurchaseOrder 上（只存 supplierId，名字是路由事后补的），Prisma 排不了。
    // 走内存排序：整个结果集只取 id+supplierId，按名字排完再切页回查整行。
    // 结果集超过 SUPPLIER_SORT_MAX_ROWS 时退化为按 supplierId 排（顺序不再是字母序，
    // 但不会为了排序把整表拉进内存）。
    let sortBySupplierName = sortFieldRaw === 'supplier'
    if (sortBySupplierName) {
      total = await p.purchaseOrder.count({ where })
      if (total > SUPPLIER_SORT_MAX_ROWS) sortBySupplierName = false
    }

    if (sortBySupplierName) {
      const slim: { id: string; supplierId: string }[] = await p.purchaseOrder.findMany({
        where,
        select: { id: true, supplierId: true },
      })
      const nameMap = await loadSupplierNames(p, slim.map(r => r.supplierId))
      const dir = sortDir === 'asc' ? 1 : -1
      slim.sort((a, b) => {
        const an = nameMap.get(a.supplierId) ?? a.supplierId ?? ''
        const bn = nameMap.get(b.supplierId) ?? b.supplierId ?? ''
        return an.localeCompare(bn, 'en', { sensitivity: 'base' }) * dir
      })
      const pageIds = slim.slice(offset, offset + limit).map(r => r.id)
      const pageRows: Record<string, unknown>[] = pageIds.length > 0
        ? await p.purchaseOrder.findMany({ where: { id: { in: pageIds } }, include: { lines: true } })
        : []
      const byId = new Map(pageRows.map(r => [r.id as string, r]))
      rows = pageIds.map(id => byId.get(id)).filter(Boolean) as Record<string, unknown>[]
      total = slim.length
    } else {
      const orderField = sortFieldRaw === 'supplier' ? 'supplierId' : sortField
      ;[rows, total] = await Promise.all([
        p.purchaseOrder.findMany({
          where,
          orderBy: { [orderField]: sortDir },
          skip: offset,
          take: limit,
          include: { lines: true },
        }),
        p.purchaseOrder.count({ where }),
      ])
    }

    // 补全 supplierName / createdByName —— PurchaseOrder 只存 id，名字要另外查
    const [supplierMap, creatorMap] = await Promise.all([
      loadSupplierNames(p, rows.map(r => r.supplierId as string)),
      loadUserNames(p, rows.map(r => r.createdBy as string)),
    ])

    const enriched = rows.map((r) => ({
      ...r,
      supplierName: supplierMap.get(r.supplierId as string) ?? r.supplierId,
      createdByName: creatorMap.get(r.createdBy as string) ?? null,
    }))

    return NextResponse.json(serializeApi({ items: enriched, total }))
  } catch (error) {
    console.error('[GET /api/purchase-orders]', error)
    return NextResponse.json({ error: '获取采购订单失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const po = await p.$transaction((tx: typeof p) => createPurchaseOrder(tx, {
        supplierId: String(data.supplierId ?? ''),
        lines: Array.isArray(data.lines)
          ? data.lines.map((l: Record<string, unknown>) => ({ ...l, spec: l.spec !== undefined ? String(l.spec ?? '') : undefined }))
          : [],
        orderDate: data.orderDate ?? null,
        expectedDate: data.expectedDate ?? null,
        currency: data.currency,
        exchangeRate: data.exchangeRate ?? null,
        freightAmount: data.freightAmount ?? null,
        sourceDocumentUrl: data.sourceDocumentUrl ?? null,
        sourceDocumentName: data.sourceDocumentName ?? null,
        notes: data.notes ?? null,
        createdBy: user.userId,
      }))

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'purchase_order', resourceId: po.id,
        detail: `创建采购订单 ${po.name}, 金额 €${Number(po.totalIncTax)}`,
      })

      return NextResponse.json(serializeApi(po), { status: 201 })
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: err.status })
      }
      console.error('[POST /api/purchase-orders]', error)
      return NextResponse.json({ error: '创建采购订单失败' }, { status: 500 })
    }
  }, { require: 'purchase.order.create' })
}
