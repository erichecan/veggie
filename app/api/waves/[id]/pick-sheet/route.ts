import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'

type PalletItem = {
  orderId: string
  restaurantId: string
  restaurantName: string
  productId: string
  productName: string
  qty: number
  uomName?: string
}

/** GET：按司机批次出一张拣货单，分托盘列明细。供打印。 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async () => {
    try {
      const wave = await prisma.pickingWave.findUnique({ where: { id } })
      if (!wave) return NextResponse.json({ error: '波次不存在' }, { status: 404 })

      const slot = wave.driverSlotId
        ? await prisma.driverSlot.findUnique({
            where: { id: wave.driverSlotId },
            select: { timeOfDay: true, batchNum: true, driverName: true },
          })
        : null

      const pallets = await prisma.pallet.findMany({
        where: { waveId: id },
        orderBy: { seq: 'asc' },
      })

      const r3 = (n: number) => Math.round(n * 1000) / 1000
      let totalSku = 0
      let totalQty = 0
      const palletViews = pallets.map(p => {
        const items = (p.items as PalletItem[]) ?? []
        const skuCount = items.length
        const qtyCount = r3(items.reduce((s, it) => s + it.qty, 0))
        totalSku += skuCount
        totalQty += qtyCount
        return {
          seq: p.seq,
          label: p.label,
          skuCount,
          qtyCount,
          items: items.map(it => ({
            productName: it.productName,
            qty: it.qty,
            uomName: it.uomName,
            restaurantName: it.restaurantName,
          })),
        }
      })

      return NextResponse.json({
        waveId: wave.id,
        waveName: wave.name,
        driverName: wave.driverName ?? slot?.driverName ?? '',
        timeOfDay: slot?.timeOfDay ?? null,
        batchNum: slot?.batchNum ?? wave.waveNumber ?? null,
        waveType: wave.waveType,
        waveDate: wave.waveDate ? wave.waveDate.toISOString().slice(0, 10) : null,
        palletCount: pallets.length,
        totalSku,
        totalQty: r3(totalQty),
        pallets: palletViews,
      })
    } catch (error) {
      console.error('[GET /api/waves/[id]/pick-sheet]', error)
      return NextResponse.json({ error: '获取拣货单失败' }, { status: 500 })
    }
  })
}
