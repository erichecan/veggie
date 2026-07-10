import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'

/**
 * P0-2: 采购建议
 *
 * GET  /api/purchase-suggestions        — 列表（支持 ?status= 过滤）
 * POST /api/purchase-suggestions        — 自动生成采购建议
 */

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const url = new URL(req.url)
      const status = url.searchParams.get('status')
      const categoryGroupKey = url.searchParams.get('categoryGroupKey')
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
      const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize')) || 50))

      const where: Record<string, unknown> = {}
      if (status) where.status = status
      if (categoryGroupKey) where.categoryGroupKey = categoryGroupKey

      const [items, total] = await Promise.all([
        prisma.purchaseSuggestion.findMany({
          where,
          orderBy: [{ priority: 'asc' }, { generatedAt: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        prisma.purchaseSuggestion.count({ where }),
      ])

      return NextResponse.json(serializeApi({ items, total, page, pageSize }))
    } catch (error) {
      console.error('[GET /api/purchase-suggestions]', error)
      return NextResponse.json({ error: '获取采购建议失败' }, { status: 500 })
    }
  })
}

/**
 * POST /api/purchase-suggestions — 自动生成
 *
 * 算法：
 *   1. 查所有 active Product
 *   2. 对每个 product，demand = SUM(orderLine.orderedQty) WHERE order.status IN (CONFIRMED, WAVE_ASSIGNED)
 *   3. shortage = max(0, demand - product.qtyOnHand)
 *   4. 如果 shortage > 0：
 *      - 找 ProductSupplierInfo（按 sequence ASC）的最佳供应商
 *      - suggestedQty = max(shortage, supplier.minQty)
 *      - estimatedCost = suggestedQty × supplier.price
 *      - priority: shortageRate > 80% → critical, > 50% → high, else normal
 *   5. 写入 PurchaseSuggestion（status=pending）
 *
 * 幂等：先清除当天已有的 pending 建议再重新生成
 */
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      // 1. 查所有 active 产品
      const products = await prisma.product.findMany({
        where: { active: true, status: 'ACTIVE' },
        select: {
          id: true,
          name: true,
          qtyOnHand: true,
          supplierInfos: {
            orderBy: { sequence: 'asc' },
            take: 1,
            include: { supplier: { select: { id: true, name: true } } },
          },
        },
      })

      // 2. 查所有有效订单行的需求量（批量一次查出，避免 N+1）
      const orderLines = await prisma.orderLine.findMany({
        where: {
          order: { status: { in: ['CONFIRMED', 'WAVE_ASSIGNED'] } },
        },
        select: { productId: true, orderedQty: true },
      })

      // 聚合需求
      const demandMap = new Map<string, number>()
      for (const line of orderLines) {
        const existing = demandMap.get(line.productId) ?? 0
        demandMap.set(line.productId, existing + toNum(line.orderedQty))
      }

      // 3. 幂等：清除今天已有的 pending 建议
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      await prisma.purchaseSuggestion.deleteMany({
        where: {
          status: 'pending',
          generatedAt: { gte: todayStart },
        },
      })

      // 4. 计算缺货并生成建议
      const suggestions: Array<{
        productId: string
        productName: string
        currentStock: number
        demandQty: number
        suggestedQty: number
        supplierId: string | null
        supplierName: string | null
        estimatedCost: number | null
        priority: string
      }> = []

      for (const product of products) {
        const demand = demandMap.get(product.id) ?? 0
        const stock = toNum(product.qtyOnHand)
        const shortage = Math.max(0, demand - stock)

        if (shortage <= 0) continue

        const bestSupplier = product.supplierInfos[0]
        const minQty = bestSupplier ? toNum(bestSupplier.minQty) : 0
        const suggestedQty = Math.max(shortage, minQty)
        const estimatedCost = bestSupplier
          ? Number((suggestedQty * toNum(bestSupplier.price)).toFixed(2))
          : null

        // 缺货率 → 优先级
        const shortageRate = demand > 0 ? shortage / demand : 0
        let priority = 'normal'
        if (shortageRate > 0.8) priority = 'critical'
        else if (shortageRate > 0.5) priority = 'high'

        suggestions.push({
          productId: product.id,
          productName: product.name,
          currentStock: stock,
          demandQty: demand,
          suggestedQty,
          supplierId: bestSupplier?.supplier.id ?? null,
          supplierName: bestSupplier?.supplier.name ?? null,
          estimatedCost,
          priority,
        })
      }

      // 5. 批量写入
      if (suggestions.length > 0) {
        await prisma.purchaseSuggestion.createMany({
          data: suggestions.map(s => ({
            productId: s.productId,
            productName: s.productName,
            currentStock: s.currentStock,
            demandQty: s.demandQty,
            suggestedQty: s.suggestedQty,
            supplierId: s.supplierId,
            supplierName: s.supplierName,
            estimatedCost: s.estimatedCost,
            priority: s.priority,
            status: 'pending',
          })),
        })
      }

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'purchase-suggestion',
        detail: `自动生成 ${suggestions.length} 条采购建议`,
      })

      return NextResponse.json(serializeApi({
        generated: suggestions.length,
        suggestions,
      }), { status: 201 })
    } catch (error) {
      console.error('[POST /api/purchase-suggestions]', error)
      return NextResponse.json({ error: '生成采购建议失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'WAREHOUSE'])
}
