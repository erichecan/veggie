/**
 * 存货估值凭证（永续盘存）—— 20261014（复式改造 L5，客户 20261014 确认「库存金额进总账」）
 * ============================================================================
 * 每次 postStockMove 入账后，按「对方库位」生成一张凭证，金额 = Σ |数量| × 单位成本：
 *
 *   收货         Vendors   → Stock   Dr 1300 存货         / Cr 2150 已收货未开票
 *   退供应商     Stock     → Vendors Dr 2150              / Cr 1300
 *   销售出库     Stock     → Customers Dr 5100 销售成本   / Cr 1300
 *   客户退回     Customers → Stock   Dr 1300              / Cr 5100
 *   报废         Stock     → Scrap   Dr 5200 存货损耗     / Cr 1300
 *   盘亏/盘盈    Stock ⇄ Inventory   Dr 5200 / Cr 1300（盘盈反向）
 *   期初         Opening   → Stock   Dr 1300              / Cr 3000 未分配利润
 *
 * 供应商账单过账时，已估值收货的那部分借记 2150 冲平（见 lib/accounting.ts postVendorBillToJournal），
 * 其余（改造前收的货、价差、非库存商品）仍进 5000。
 * 出库时点沿用现状「订单确认即出库」（计划 D2-①），所以销售成本在确认订单时确认。
 * 没有任何成本可用（批次无成本、商品无平均成本）的流水不出凭证，ledger-check 会把它们列出来。
 */
import { postJournalEntry } from '@/lib/accounting'
import { LOC } from '@/lib/stock-locations'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

const COUNTER_ACCOUNT: Record<string, { inbound: string; outbound: string; label: string }> = {
  // inbound = 货进仓时贷记的科目；outbound = 货出仓时借记的科目
  [LOC.VENDORS]: { inbound: '2150', outbound: '2150', label: 'Receipt' },
  [LOC.CUSTOMERS]: { inbound: '5100', outbound: '5100', label: 'COGS' },
  [LOC.SCRAP]: { inbound: '5200', outbound: '5200', label: 'Scrap' },
  [LOC.INVENTORY]: { inbound: '5200', outbound: '5200', label: 'Inventory adjustment' },
  [LOC.OPENING]: { inbound: '3000', outbound: '3000', label: 'Opening inventory' },
}

export function valuationAccounts(from: string, to: string): { debit: string; credit: string; label: string } | null {
  if (to === LOC.STOCK) {
    const c = COUNTER_ACCOUNT[from]
    return c ? { debit: '1300', credit: c.inbound, label: c.label } : null
  }
  if (from === LOC.STOCK) {
    const c = COUNTER_ACCOUNT[to]
    return c ? { debit: c.outbound, credit: '1300', label: c.label } : null
  }
  return null
}

export function moveValue(moves: Array<{ qty: number; unitCost: number | null }>): number {
  const v = moves.reduce((s, m) => s + (m.unitCost == null ? 0 : Math.abs(m.qty) * m.unitCost), 0)
  return Math.round(v * 100) / 100
}

export async function postStockValuation(
  tx: Tx,
  p: {
    moves: Array<{ id: string; qty: number; unitCost: number | null }>
    from: string
    to: string
    type: string
    productName: string
    reference: string | null
    partnerId: string | null
    movedAt: Date
  },
  userId: string,
) {
  if (p.moves.length === 0) return null
  const acc = valuationAccounts(p.from, p.to)
  if (!acc) return null
  const value = moveValue(p.moves)
  if (!(value > 0)) return null
  const desc = `${acc.label} - ${p.productName}${p.reference ? ` (${p.reference})` : ''}`
  return postJournalEntry(tx, {
    narration: desc,
    sourceType: 'stock_move',
    sourceId: p.moves[0].id,
    date: p.movedAt,
    lines: [
      { code: acc.debit, debit: value, description: desc, partnerId: acc.debit === '2150' ? p.partnerId : null },
      { code: acc.credit, credit: value, description: desc, partnerId: acc.credit === '2150' ? p.partnerId : null },
    ],
  }, userId)
}
