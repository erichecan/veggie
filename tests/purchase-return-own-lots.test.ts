/**
 * 采购退货先扣本单收进来的批次（20261022 客户：「50 箱误收成 500 箱进了 LOT-01106，退 450 箱应该从
 * LOT-01106 退，不是先退旧批次 LOT-01105」）。用内存假 client 跑 lib/inventory.ts 的扣批次顺序。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { consumeLotsFIFO, consumeLotsPreferring } from '../lib/inventory'

interface FakeLot { id: string; lotNumber: string; productId: string; status: string; currentQty: number; initialQty: number; bestBefore: Date | null; arrivedAt: Date }

function fakeClient(lots: FakeLot[]) {
  return {
    lot: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async (args: any) => {
        const w = args.where
        let rows = lots.filter(l => l.productId === w.productId && l.status === w.status && l.currentQty > 0)
        if (w.id?.in) rows = rows.filter(l => w.id.in.includes(l.id))
        // FEFO：bestBefore 早的先，无保质期排最后，再按到货
        return rows.sort((a, b) =>
          (a.bestBefore?.getTime() ?? Infinity) - (b.bestBefore?.getTime() ?? Infinity) || a.arrivedAt.getTime() - b.arrivedAt.getTime())
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: async (args: any) => {
        const l = lots.find(x => x.id === args.where.id)!
        l.currentQty -= args.data.currentQty.decrement
        if (args.data.status) l.status = args.data.status
        return l
      },
    },
  }
}

const day = (d: number) => new Date(Date.UTC(2026, 9, d))
const mushroomLots = (): FakeLot[] => [
  { id: 'old', lotNumber: 'LOT-01105', productId: 'mush', status: 'AVAILABLE', currentQty: 120, initialQty: 120, bestBefore: day(20), arrivedAt: day(15) },
  { id: 'own', lotNumber: 'LOT-01106', productId: 'mush', status: 'AVAILABLE', currentQty: 500, initialQty: 500, bestBefore: day(25), arrivedAt: day(19) },
]

test('FEFO 本身会先扣旧批次——这正是退货不能用它的原因', async () => {
  const lots = mushroomLots()
  const moved = await consumeLotsFIFO(fakeClient(lots) as never, 'mush', 450)
  assert.deepEqual(moved.map(m => [m.lotNumber, m.qty]), [['LOT-01105', 120], ['LOT-01106', 330]])
})

test('退 450：全部从本单批次 LOT-01106 扣，旧批次 LOT-01105 不动', async () => {
  const lots = mushroomLots()
  const moved = await consumeLotsPreferring(fakeClient(lots) as never, 'mush', 450, ['own'])
  assert.deepEqual(moved.map(m => [m.lotNumber, m.qty]), [['LOT-01106', 450]])
  assert.equal(lots.find(l => l.id === 'old')!.currentQty, 120)
  assert.equal(lots.find(l => l.id === 'own')!.currentQty, 50)
})

test('本单批次已被卖掉一部分、不够退：先扣光本单批次，差额才按 FEFO 扣别的批次', async () => {
  const lots = mushroomLots()
  lots.find(l => l.id === 'own')!.currentQty = 20
  const moved = await consumeLotsPreferring(fakeClient(lots) as never, 'mush', 50, ['own'])
  assert.deepEqual(moved.map(m => [m.lotNumber, m.qty]), [['LOT-01106', 20], ['LOT-01105', 30]])
  assert.equal(lots.find(l => l.id === 'own')!.status, 'DEPLETED')
})

test('采购退货接口按本单批次优先扣，不是纯 FEFO', () => {
  const src = readFileSync('app/api/purchase-orders/[id]/return/route.ts', 'utf-8')
  assert.match(src, /lotsReceivedForPurchaseLine\(/)
  assert.match(src, /lot:\s*\{\s*mode:\s*'fefo',\s*preferLotIds:\s*ownLots\s*\}/)
})
