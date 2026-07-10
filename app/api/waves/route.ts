import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { nextWaveCode } from '@/lib/order-code'

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const dateStr = url.searchParams.get('date')

    if (dateStr) {
      const waveDate = new Date(dateStr + 'T00:00:00Z')
      const waves = await prisma.pickingWave.findMany({
        where: { waveDate },
        orderBy: { waveNumber: 'asc' },
        // 调度台需要按托盘(batchNum)子分组展示波次内部的订单，见 lib/wave-assign.ts
        include: { pallets: { orderBy: { seq: 'asc' } } },
      })
      return NextResponse.json(serializeApi(waves))
    }

    const waves = await prisma.pickingWave.findMany({ orderBy: { createdAt: 'desc' } })
    return NextResponse.json(serializeApi(waves))
  } catch (error) {
    console.error('[GET /api/waves]', error)
    return NextResponse.json({ error: '获取波次失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()

      // Auto-populate zones from order items when creating a new wave
      let zones = data.zones ?? []
      if (data.orderIds?.length > 0 && zones.length === 0) {
        const orders = await prisma.order.findMany({
          where: { id: { in: data.orderIds } },
        })

        // Collect all unique productIds to batch-fetch images
        const allProductIds = new Set<string>()
        for (const order of orders) {
          const items = (order.items as Array<{
            productId: string; productName: string; spec?: string; quantity: number
          }>) ?? []
          for (const item of items) allProductIds.add(item.productId)
        }

        // Fetch product images in one query
        const products = await prisma.product.findMany({
          where: { id: { in: Array.from(allProductIds) } },
          select: { id: true, images: true, templateId: true },
        })
        const templates = await prisma.productTemplate.findMany({
          where: { id: { in: products.map(p => p.templateId).filter(Boolean) as string[] } },
          select: { id: true, images: true, uom: { select: { name: true } } },
        })
        const templateImageMap = new Map(templates.map(t => [t.id, t.images[0] ?? '']))
        const templateUomMap = new Map(templates.map(t => [t.id, t.uom?.name ?? '']))
        const productImageMap = new Map(
          products.map(p => [
            p.id,
            p.images[0] ?? (p.templateId ? (templateImageMap.get(p.templateId) ?? '') : ''),
          ]),
        )
        // Product → UOM name fallback (when order item doesn't carry uomName)
        const productUomMap = new Map(
          products.map(p => [p.id, p.templateId ? (templateUomMap.get(p.templateId) ?? '') : '']),
        )

        // Aggregate items across all orders, grouped by productId
        const productMap = new Map<string, {
          productId: string; productName: string; spec: string; image: string
          requiredQty: number; pickedQty: number; restaurants: string[]; done: boolean
          uomName?: string
        }>()

        for (const order of orders) {
          const items = (order.items as Array<{
            productId: string; productName: string; spec?: string; quantity: number; uomName?: string
          }>) ?? []
          for (const item of items) {
            const existing = productMap.get(item.productId)
            if (existing) {
              existing.requiredQty += item.quantity
              if (!existing.restaurants.includes(order.restaurantName)) {
                existing.restaurants.push(order.restaurantName)
              }
            } else {
              productMap.set(item.productId, {
                productId: item.productId,
                productName: item.productName,
                spec: item.spec ?? '',
                image: productImageMap.get(item.productId) ?? '',
                requiredQty: item.quantity,
                pickedQty: 0,
                restaurants: [order.restaurantName],
                done: false,
                uomName: item.uomName || productUomMap.get(item.productId) || undefined,
              })
            }
          }
        }

        if (productMap.size > 0) {
          zones = [{
            name: '待拣货区',
            items: Array.from(productMap.values()).sort((a, b) =>
              a.productName.localeCompare(b.productName, 'zh-CN')
            ),
          }]
        }
      }

      const waveCode = await nextWaveCode(prisma, new Date())
      // 原子：建波次 + 回写订单状态。波次带 orderIds 时，SSOT=wave.orderIds，
      // 订单 status 是其派生镜像，进入波次即由 CONFIRMED 升级为 WAVE_ASSIGNED。
      const wave = await prisma.$transaction(async (tx) => {
        const w = await tx.pickingWave.create({
          data: {
            ...data,
            name: waveCode,
            status: data.status?.toUpperCase() ?? 'PENDING',
            orderIds: data.orderIds ?? [],
            zones,
          },
        })
        const oids = (data.orderIds ?? []) as string[]
        if (oids.length > 0) {
          await tx.order.updateMany({
            where: { id: { in: oids }, status: 'CONFIRMED' },
            data: { status: 'WAVE_ASSIGNED' },
          })
        }
        return w
      })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'picking-wave', resourceId: wave.id,
        detail: `创建拣货波次: ${wave.id}` })
      return NextResponse.json(serializeApi(wave), { status: 201 })
    } catch (error) {
      console.error('[POST /api/waves]', error)
      return NextResponse.json({ error: '创建波次失败' }, { status: 500 })
    }
  })
}
