import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'

/** 托盘内一条货物明细：来自某订单某餐馆的某商品 */
type PalletItem = {
  orderId: string
  orderCode?: string
  restaurantId: string
  restaurantName: string
  productId: string
  productName: string
  qty: number
  uomName?: string
}

type OrderItemRaw = {
  productId: string
  productName: string
  spec?: string
  quantity: number
  uomName?: string
}

const lineKey = (orderId: string, productId: string) => `${orderId}::${productId}`

/** GET：返回该波次的托盘列表 + 待分盘池（全部订单明细 − 已入盘明细） */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async () => {
    try {
      const wave = await prisma.pickingWave.findUnique({ where: { id } })
      if (!wave) return NextResponse.json({ error: '波次不存在' }, { status: 404 })

      const orderIds = (wave.orderIds as string[]) ?? []
      const orders = orderIds.length
        ? await prisma.order.findMany({
            where: { id: { in: orderIds } },
            select: { id: true, code: true, restaurantId: true, restaurantName: true, items: true },
          })
        : []

      // 波次全部明细（按 订单×商品 粒度）
      const allLines = new Map<string, PalletItem>()
      for (const o of orders) {
        const items = (o.items as OrderItemRaw[]) ?? []
        for (const it of items) {
          const key = lineKey(o.id, it.productId)
          const prev = allLines.get(key)
          if (prev) {
            prev.qty += it.quantity
          } else {
            allLines.set(key, {
              orderId: o.id,
              orderCode: o.code ?? undefined,
              restaurantId: o.restaurantId,
              restaurantName: o.restaurantName,
              productId: it.productId,
              productName: it.productName,
              qty: it.quantity,
              uomName: it.uomName,
            })
          }
        }
      }

      const pallets = await prisma.pallet.findMany({
        where: { waveId: id },
        orderBy: { seq: 'asc' },
      })

      // 已入盘数量（按 订单×商品 汇总）
      const usedQty = new Map<string, number>()
      for (const p of pallets) {
        for (const it of (p.items as PalletItem[]) ?? []) {
          const key = lineKey(it.orderId, it.productId)
          usedQty.set(key, (usedQty.get(key) ?? 0) + it.qty)
        }
      }

      // 待分盘池 = 全部 − 已入盘，余量 > 0 才保留
      const pool: PalletItem[] = []
      for (const [key, line] of allLines) {
        const remaining = line.qty - (usedQty.get(key) ?? 0)
        if (remaining > 0.0001) pool.push({ ...line, qty: remaining })
      }
      pool.sort(
        (a, b) =>
          a.restaurantName.localeCompare(b.restaurantName, 'zh-CN') ||
          a.productName.localeCompare(b.productName, 'zh-CN'),
      )

      return NextResponse.json({
        wave: {
          id: wave.id,
          name: wave.name,
          driverName: wave.driverName,
          waveType: wave.waveType,
          waveNumber: wave.waveNumber,
        },
        pallets: pallets.map(p => ({ id: p.id, seq: p.seq, label: p.label, items: p.items })),
        pool,
      })
    } catch (error) {
      console.error('[GET /api/waves/[id]/pallets]', error)
      return NextResponse.json({ error: '获取托盘失败' }, { status: 500 })
    }
  })
}

/** PUT：整体保存托盘编排（事务重建本波次全部托盘）。 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const body = (await req.json()) as {
        pallets: Array<{ seq: number; label?: string | null; items: PalletItem[] }>
      }
      const incoming = body.pallets ?? []

      const wave = await prisma.pickingWave.findUnique({ where: { id } })
      if (!wave) return NextResponse.json({ error: '波次不存在' }, { status: 404 })

      // 校验 seq 唯一
      const seqs = incoming.map(p => p.seq)
      if (new Set(seqs).size !== seqs.length) {
        return NextResponse.json({ error: '托盘顺序号重复' }, { status: 400 })
      }

      await prisma.$transaction([
        prisma.pallet.deleteMany({ where: { waveId: id } }),
        prisma.pallet.createMany({
          data: incoming.map(p => ({
            waveId: id,
            seq: p.seq,
            label: p.label ?? null,
            items: (p.items ?? []) as object[],
          })),
        }),
      ])

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'pallet', resourceId: id,
        detail: `保存波次 ${wave.name ?? id} 的托盘编排（${incoming.length} 个托盘）`,
      })

      const saved = await prisma.pallet.findMany({
        where: { waveId: id },
        orderBy: { seq: 'asc' },
      })
      return NextResponse.json({
        pallets: saved.map(p => ({ id: p.id, seq: p.seq, label: p.label, items: p.items })),
      })
    } catch (error) {
      console.error('[PUT /api/waves/[id]/pallets]', error)
      return NextResponse.json({ error: '保存托盘失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'DISPATCH'])
}
