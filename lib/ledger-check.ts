/**
 * 账本核对（每日）—— 20261014（复式改造 L2，docs/20261014-double-entry-ledger-plan.md）
 * ============================================================================
 * 原则：余额 = Σ 明细。这里把每一种缓存余额按明细重算一遍，和存着的值比对。
 * **只报告、不修复**——差异要人看过才知道该改哪边（是明细漏记，还是缓存被别处写坏）。
 *
 * severity:
 *   - error：新系统里本不该出现的不一致（缓存 ≠ 明细、借贷不平……），有一条就算核对失败
 *   - info ：口径/历史差异，给人看量级，不算失败（如 Odoo 导入的历史发票没有总账凭证，
 *            总账应收和发票子账永远差一截）
 *
 * 触发：
 *   - 定时：/api/cron/backup-database 备份完顺带跑（droplet 上已有每日 timer，不另加定时器）；
 *     也可以单独 POST /api/cron/ledger-check（x-cron-secret）
 *   - 手动：财务「账本核对」页「立即核对」
 * 纯 SQL、只读；跑完写一行 LedgerCheckRun。
 */
import { prisma } from '@/lib/db'

export type LedgerSeverity = 'error' | 'info'

export interface LedgerCheckResult {
  key: string
  label: string
  labelEn: string
  severity: LedgerSeverity
  /** 不一致的条数（info 类为涉及条数） */
  diffCount: number
  /** 涉及金额/数量合计（可选） */
  amount?: number
  /** 附加的汇总数字（如总账余额 vs 子账余额） */
  figures?: Record<string, number>
  /** 最多 20 条样本，供人点进去查 */
  samples: Array<Record<string, unknown>>
  note?: string
}

const SAMPLE = 20
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
const num = (v: unknown) => (v == null ? 0 : Number(v))

async function q(sql: string): Promise<Row[]> {
  return (await prisma.$queryRawUnsafe(sql)) as Row[]
}

function cleanSamples(rows: Row[]): Array<Record<string, unknown>> {
  return rows.slice(0, SAMPLE).map(r => Object.fromEntries(
    Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v && typeof v === 'object' && 'toNumber' in v ? Number(v) : v]),
  ))
}

type Check = () => Promise<LedgerCheckResult>

const invoiceBalance: Check = async () => {
  const rows = await q(`
    WITH p AS (SELECT "invoiceId", SUM(amount) s FROM "Payment" WHERE "invoiceId" IS NOT NULL GROUP BY 1),
         a AS (SELECT "invoiceId", SUM(amount) s FROM "CreditNoteAllocation" WHERE kind = 'INVOICE' AND "invoiceId" IS NOT NULL GROUP BY 1)
    SELECT i.id, i.name, i.status::text AS status, i."totalIncTax"::float AS total,
           i."amountPaid"::float AS cached_paid, (i."openingPaid" + COALESCE(p.s, 0))::float AS ledger_paid,
           i."amountCredited"::float AS cached_credited, (i."openingCredited" + COALESCE(a.s, 0))::float AS ledger_credited,
           i."amountDue"::float AS cached_due,
           GREATEST(0, i."totalIncTax" - i."openingPaid" - COALESCE(p.s, 0) - i."openingCredited" - COALESCE(a.s, 0))::float AS ledger_due
    FROM "Invoice" i LEFT JOIN p ON p."invoiceId" = i.id LEFT JOIN a ON a."invoiceId" = i.id
    WHERE i.status IN ('POSTED', 'PAID') AND (
      ABS(i."amountPaid" - i."openingPaid" - COALESCE(p.s, 0)) > 0.005
      OR ABS(i."amountCredited" - i."openingCredited" - COALESCE(a.s, 0)) > 0.005
      OR ABS(i."amountDue" - GREATEST(0, i."totalIncTax" - i."openingPaid" - COALESCE(p.s, 0) - i."openingCredited" - COALESCE(a.s, 0))) > 0.005
      OR (i.status = 'PAID' AND i."totalIncTax" - i."openingPaid" - COALESCE(p.s, 0) - i."openingCredited" - COALESCE(a.s, 0) > 0.005)
    )
    ORDER BY i."createdAt" DESC`)
  return {
    key: 'invoice_balance', label: '发票余额 = 期初 + 收款 + 贷记单抵扣', labelEn: 'Invoice balance = opening + payments + credit notes',
    severity: 'error', diffCount: rows.length,
    amount: rows.reduce((s, r) => s + Math.abs(num(r.cached_due) - num(r.ledger_due)), 0),
    samples: cleanSamples(rows),
  }
}

const vendorBillBalance: Check = async () => {
  const rows = await q(`
    WITH p AS (SELECT "vendorBillId", SUM(amount) s FROM "VendorPayment" GROUP BY 1)
    SELECT b.id, b.name, b.status::text AS status, b."totalIncTax"::float AS total,
           b."amountPaid"::float AS cached_paid, COALESCE(p.s, 0)::float AS ledger_paid,
           b."amountDue"::float AS cached_due, GREATEST(0, b."totalIncTax" - COALESCE(p.s, 0))::float AS ledger_due
    FROM "VendorBill" b LEFT JOIN p ON p."vendorBillId" = b.id
    WHERE b.status IN ('POSTED', 'PAID') AND (
      ABS(b."amountPaid" - COALESCE(p.s, 0)) > 0.005
      OR ABS(b."amountDue" - GREATEST(0, b."totalIncTax" - COALESCE(p.s, 0))) > 0.005
    )
    ORDER BY b."createdAt" DESC`)
  return {
    key: 'vendor_bill_balance', label: '供应商账单余额 = Σ 付款流水', labelEn: 'Vendor bill balance = Σ vendor payments',
    severity: 'error', diffCount: rows.length,
    amount: rows.reduce((s, r) => s + Math.abs(num(r.cached_due) - num(r.ledger_due)), 0),
    samples: cleanSamples(rows),
  }
}

const creditNoteBounds: Check = async () => {
  const rows = await q(`
    SELECT c.id, c.name, c.status, c."totalIncTax"::float AS total, COALESCE(SUM(a.amount), 0)::float AS used
    FROM "CreditNote" c JOIN "CreditNoteAllocation" a ON a."creditNoteId" = c.id
    GROUP BY c.id
    HAVING COALESCE(SUM(a.amount), 0) > c."totalIncTax" + 0.005 OR COALESCE(SUM(a.amount), 0) < -0.005
       OR c.status NOT IN ('CONFIRMED', 'SETTLED')`)
  return {
    key: 'credit_note_bounds', label: '贷记单抵扣/退款不超额、只出现在已确认的贷记单上', labelEn: 'Credit note usage within total, only on confirmed notes',
    severity: 'error', diffCount: rows.length, samples: cleanSamples(rows),
  }
}

const journalBalanced: Check = async () => {
  const rows = await q(`
    SELECT e.id, e.name, e."sourceType", e."totalDebit"::float AS head_debit, e."totalCredit"::float AS head_credit,
           COALESCE(SUM(l.debit), 0)::float AS line_debit, COALESCE(SUM(l.credit), 0)::float AS line_credit
    FROM "JournalEntry" e LEFT JOIN "JournalEntryLine" l ON l."entryId" = e.id
    WHERE e.status = 'POSTED'
    GROUP BY e.id
    HAVING ABS(COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0)) > 0.005
        OR ABS(COALESCE(SUM(l.debit), 0) - e."totalDebit") > 0.005`)
  return {
    key: 'journal_balanced', label: '每张凭证借贷平衡', labelEn: 'Every journal entry balances',
    severity: 'error', diffCount: rows.length, samples: cleanSamples(rows),
  }
}

const missingAccounts: Check = async () => {
  const need = ['1100', '1110', '1200', '1300', '2100', '2150', '2200', '2300', '4000', '5000', '5100', '5200']
  const rows = await q(`SELECT code FROM "Account" WHERE code IN (${need.map(c => `'${c}'`).join(',')})`)
  const have = new Set(rows.map(r => String(r.code)))
  const missing = need.filter(c => !have.has(c))
  return {
    key: 'accounts_present', label: '自动记账需要的科目都存在', labelEn: 'Accounts required by auto-posting exist',
    severity: 'error', diffCount: missing.length, samples: missing.map(code => ({ code })),
    note: '缺科目时自动凭证会被跳过，总账就会漏记',
  }
}

const arGlVsSubledger: Check = async () => {
  const [gl] = await q(`
    SELECT COALESCE(SUM(l.debit - l.credit), 0)::float AS bal
    FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e.id = l."entryId" JOIN "Account" a ON a.id = l."accountId"
    WHERE a.code = '1100' AND e.status = 'POSTED'`)
  const [sub] = await q(`SELECT COALESCE(SUM("amountDue"), 0)::float AS due FROM "Invoice" WHERE status = 'POSTED'`)
  const [cn] = await q(`
    SELECT COALESCE(SUM(c."totalIncTax" - COALESCE(a.s, 0)), 0)::float AS unapplied
    FROM "CreditNote" c LEFT JOIN (SELECT "creditNoteId", SUM(amount) s FROM "CreditNoteAllocation" GROUP BY 1) a ON a."creditNoteId" = c.id
    WHERE c.status IN ('CONFIRMED', 'SETTLED')`)
  const subledger = num(sub?.due) - num(cn?.unapplied)
  const diff = Math.round((num(gl?.bal) - subledger) * 100) / 100
  return {
    key: 'ar_gl_vs_subledger', label: '总账应收(1100) vs 发票未付 − 未用贷项', labelEn: 'GL receivable (1100) vs open invoices − unapplied credits',
    severity: 'info', diffCount: Math.abs(diff) > 0.005 ? 1 : 0, amount: diff,
    figures: { glReceivable: num(gl?.bal), openInvoices: num(sub?.due), unappliedCredits: num(cn?.unapplied), difference: diff },
    samples: [],
    note: 'Odoo 导入的历史发票没有总账凭证，这一项会长期有差额；看的是差额是否随新业务继续变大',
  }
}

const unappliedCreditNotes: Check = async () => {
  const rows = await q(`
    SELECT c.id, c.name, c."customerName", c.status, c."totalIncTax"::float AS total,
           (c."totalIncTax" - COALESCE(a.s, 0))::float AS remaining, c."creditDate"
    FROM "CreditNote" c LEFT JOIN (SELECT "creditNoteId", SUM(amount) s FROM "CreditNoteAllocation" GROUP BY 1) a ON a."creditNoteId" = c.id
    WHERE c.status IN ('CONFIRMED', 'SETTLED') AND c."totalIncTax" - COALESCE(a.s, 0) > 0.005
    ORDER BY c."creditDate"`)
  return {
    key: 'unapplied_credit_notes', label: '已确认但未抵扣/退款的贷记单', labelEn: 'Confirmed credit notes not yet applied or refunded',
    severity: 'info', diffCount: rows.length, amount: rows.reduce((s, r) => s + num(r.remaining), 0),
    samples: cleanSamples(rows),
    note: '其中状态为 SETTLED 的是改造前手工「标记已结算」、去向没有记录的；请在贷记单页把它们抵扣到发票或登记退款',
  }
}

const paymentsWithoutJournal: Check = async () => {
  const rows = await q(`
    SELECT p.id, p."invoiceId", p."customerId", p.amount::float AS amount, p.source, p.method, p."paidAt", p.note
    FROM "Payment" p
    WHERE NOT EXISTS (SELECT 1 FROM "JournalEntry" e WHERE e."sourceId" = p.id)
    ORDER BY p."paidAt" DESC`)
  return {
    key: 'payments_without_journal', label: '没有总账凭证的收款', labelEn: 'Payments without a journal entry',
    severity: 'info', diffCount: rows.length, amount: rows.reduce((s, r) => s + num(r.amount), 0),
    samples: cleanSamples(rows),
    note: '20261014 之前司机收款核销不出凭证；之后新增的收款若出现在这里说明还有路径漏记',
  }
}

// ── 库存（20261014 复式改造 L3/L5）────────────────────────────────────────────

const stockOnHand: Check = async () => {
  const rows = await q(`
    SELECT p.id, p.name, p."qtyOnHand"::float AS cached, COALESCE(m.s, 0)::float AS ledger
    FROM "Product" p LEFT JOIN (SELECT "productId", SUM(qty) s FROM "StockMove" GROUP BY 1) m ON m."productId" = p.id
    WHERE ABS(p."qtyOnHand" - COALESCE(m.s, 0)) > 0.0005
    ORDER BY ABS(p."qtyOnHand" - COALESCE(m.s, 0)) DESC`)
  return {
    key: 'stock_on_hand', label: '商品在手量 = Σ 库存流水', labelEn: 'On hand = Σ stock moves',
    severity: 'error', diffCount: rows.length, samples: cleanSamples(rows),
  }
}

const lotBalance: Check = async () => {
  const rows = await q(`
    SELECT l.id, l."lotNumber", p.name AS product, l."currentQty"::float AS cached, COALESCE(m.s, 0)::float AS ledger
    FROM "Lot" l JOIN "Product" p ON p.id = l."productId"
    LEFT JOIN (SELECT "lotId", SUM(qty) s FROM "StockMove" WHERE "lotId" IS NOT NULL GROUP BY 1) m ON m."lotId" = l.id
    WHERE ABS(l."currentQty" - COALESCE(m.s, 0)) > 0.0005`)
  return {
    key: 'lot_balance', label: '批次余量 = Σ 该批次流水', labelEn: 'Lot quantity = Σ lot moves',
    severity: 'error', diffCount: rows.length, samples: cleanSamples(rows),
  }
}

const moveLocations: Check = async () => {
  const rows = await q(`
    SELECT id, "productName", type::text AS type, qty::float AS qty, "sourceType", "sourceRef", "fromLocationId", "toLocationId", "movedAt"
    FROM "StockMove"
    WHERE "fromLocationId" IS NULL OR "toLocationId" IS NULL
       OR (qty > 0 AND "toLocationId" <> 'loc_wh_stock')
       OR (qty < 0 AND "fromLocationId" <> 'loc_wh_stock')
       OR "fromLocationId" = "toLocationId"
    ORDER BY "createdAt" DESC`)
  return {
    key: 'stock_move_locations', label: '每笔流水都有来源/去向库位，且方向与数量正负一致（复式）', labelEn: 'Every move has from/to locations consistent with its sign',
    severity: 'error', diffCount: rows.length, samples: cleanSamples(rows),
  }
}

const locationBalances: Check = async () => {
  const rows = await q(`
    SELECT loc.code, loc."nameZh",
           (COALESCE((SELECT SUM(ABS(qty)) FROM "StockMove" WHERE "toLocationId" = loc.id), 0)
          - COALESCE((SELECT SUM(ABS(qty)) FROM "StockMove" WHERE "fromLocationId" = loc.id), 0))::float AS balance
    FROM "StockLocation" loc ORDER BY loc.code`)
  const total = rows.reduce((s, r) => s + num(r.balance), 0)
  return {
    key: 'stock_location_balances', label: '各库位累计数量（全部库位相加应为 0）', labelEn: 'Quantity by location (sums to zero)',
    severity: Math.abs(total) > 0.001 ? 'error' : 'info', diffCount: Math.abs(total) > 0.001 ? 1 : 0,
    samples: cleanSamples(rows), note: '虚拟库位（客户、供应商、报废、期初）的余额是累计流向那里的量，WH/Stock 的余额就是全部商品的在手量合计',
  }
}

/**
 * 已出库（配送中）却从没扣过库存的订单。20261015 起确认不扣、货离仓（确认出发）才扣；
 * 出发前就已在配送中、且从没扣过的单（改造前绕过扣减的）在这里列出，可一键补扣。
 * 已确认待出库的单本来就不该有出库流水，不在此列。
 */
export async function findOrdersWithoutStock(): Promise<Row[]> {
  return q(`
    SELECT o.id, o.code, o."restaurantName", o.status::text AS status, o."confirmationDate"
    FROM "Order" o
    WHERE o.status IN ('IN_DELIVERY')
      AND EXISTS (SELECT 1 FROM "OrderLine" l JOIN "Product" p ON p.id = l."productId" WHERE l."orderId" = o.id AND p.type = 'PRODUCT' AND l."orderedQty" > 0)
      AND NOT EXISTS (SELECT 1 FROM "StockMove" m WHERE m."sourceId" = o.id AND m."sourceType" IN ('ORDER', 'SO'))
    ORDER BY o."confirmationDate" DESC NULLS LAST`)
}

const ordersWithoutStock: Check = async () => {
  const rows = await findOrdersWithoutStock()
  return {
    key: 'orders_without_stock', label: '配送中但从未出库扣库存的订单', labelEn: 'Orders in delivery that never took stock',
    severity: 'info', diffCount: rows.length, samples: cleanSamples(rows),
    note: '货已离仓却没扣在手量（改造前绕过扣减的单）。可点「统一补扣」按订单行出库（与确认出发同一套逻辑，可重复点，已补过的不会再扣）',
  }
}

/**
 * 统一补扣（客户 20261015 确认）：对上面列出的每张单跑一次 syncOrderStock，
 * 与确认订单同一套逻辑（单位换算、FEFO 扣批次、出库凭证）。每张单一个事务，单张失败不影响其它。
 * 幂等：补过的单流水里已有记录，不会再出现在名单里。
 */
export async function fixOrdersWithoutStock(actor: { userId: string; name?: string | null }) {
  const { syncOrderStock } = await import('@/lib/order-stock')
  const rows = await findOrdersWithoutStock()
  const fixed: Array<{ code: string; products: number }> = []
  const failed: Array<{ code: string; error: string }> = []
  const now = new Date()
  for (const r of rows) {
    const code = String(r.code ?? r.id)
    try {
      const res = await prisma.$transaction(tx => syncOrderStock(tx, String(r.id), {
        reason: '补扣：已出库但改造前未扣库存（统一补扣）',
        movedAt: now,
        shipping: true,
        userId: actor.userId,
        createdBy: actor.name ?? null,
      }), { maxWait: 10000, timeout: 60000 })
      fixed.push({ code, products: res.changed.length })
    } catch (e) {
      failed.push({ code, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { total: rows.length, fixed, failed }
}

/**
 * 已完成且已核销确认却没有发票的订单（20261021「待开票」）。本该在核销确认时自动出草稿发票
 * （见 app/api/orders/bulk/route.ts mark_returned），以下几种情况漏掉了：
 *   - 订单页直接改「已完成」不回填实送量，草稿发票按实送量 0 开不出来（已修，见 fillDeliveredQtyIfUnrecorded）；
 *   - 发票号撞号失败被静默吞掉（20261020 已修）；
 *   - 核销确认时触发开票本身失败（20261026，mark_returned 里失败只记日志不回滚核销）。
 * Odoo 导入的历史单是 LOCKED，不在此列。
 *
 * ⛔ 20261026 code-review 修复：加 returnStatus=RETURNED 条件。20261026 之前这里只看
 * status=COMPLETED，开票本来就挂在"标记完成"那一步；改成挂在"核销确认"之后，COMPLETED
 * 但还没核销的单（新增的、设计内的中间状态）会被这条探针误判成"漏开票"，「统一补开草稿
 * 发票」会在会计核对送达量之前就按下单量全送把发票开出来，正是这次改动要防的场景。
 */
export async function findUninvoicedCompletedOrders(): Promise<Row[]> {
  return q(`
    SELECT o.id, o.code, o."restaurantName", o."deliveryDate", o."totalAmount"::float AS "totalAmount",
           NOT EXISTS (SELECT 1 FROM "OrderLine" l WHERE l."orderId" = o.id AND l."deliveredQty" > 0) AS "noDeliveredQty"
    FROM "Order" o
    WHERE o.status = 'COMPLETED'
      AND o."returnStatus" = 'RETURNED'
      AND o.id NOT IN (SELECT unnest("saleOrderIds") FROM "Invoice" WHERE status <> 'CANCELLED')
    ORDER BY o."deliveryDate" DESC NULLS LAST`)
}

const uninvoicedOrders: Check = async () => {
  const rows = await findUninvoicedCompletedOrders()
  return {
    key: 'completed_without_invoice', label: '已核销但没有发票的订单（待开票）', labelEn: 'Written-off orders without an invoice',
    severity: 'info', diffCount: rows.length, amount: rows.reduce((s, r) => s + num(r.totalAmount), 0), samples: cleanSamples(rows),
    note: '可点「统一补开草稿发票」：实送量没记过的按全送补上，再按核销确认时同一套逻辑开草稿发票（可重复点，已开过的跳过）',
  }
}

/** 统一补开草稿发票（客户 20261021）：每张单独立，单张失败不影响其它 */
export async function fixUninvoicedOrders() {
  const { fillDeliveredQtyIfUnrecorded } = await import('@/lib/delivery-complete')
  const { createDraftInvoiceForOrder } = await import('@/lib/invoice-from-order')
  const rows = await findUninvoicedCompletedOrders()
  const fixed: Array<{ code: string; invoiceId: string; filledDeliveredQty: boolean }> = []
  const skipped: Array<{ code: string; reason: string }> = []
  const failed: Array<{ code: string; error: string }> = []
  for (const r of rows) {
    const id = String(r.id)
    const code = String(r.code ?? r.id)
    try {
      const filled = await fillDeliveredQtyIfUnrecorded(id)
      const inv = await createDraftInvoiceForOrder(prisma as never, id)
      if (inv) fixed.push({ code, invoiceId: inv.id, filledDeliveredQty: filled })
      else skipped.push({ code, reason: '没有可开票的行（全部为 0 数量）' })
    } catch (e) {
      failed.push({ code, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { total: rows.length, fixed, skipped, failed }
}

/** 调度台已「标记完成」、出发时生成的行程却还没完成（20261020 之前的标记完成不回写行程） */
export async function findCompletedWavesWithOpenTrips(): Promise<Row[]> {
  return q(`
    SELECT t.id, t.name, t."driverName", t.status::text AS status, w.name AS "waveName", w."completedAt"
    FROM "Trip" t JOIN "PickingWave" w ON w.id = t."waveId"
    WHERE w."completedAt" IS NOT NULL AND t.status <> 'COMPLETED'
    ORDER BY w."completedAt" DESC`)
}

const openTripsOfCompletedWaves: Check = async () => {
  const rows = await findCompletedWavesWithOpenTrips()
  return {
    key: 'completed_wave_open_trips', label: '波次已标记完成但行程未完成', labelEn: 'Completed waves whose trip is still open',
    severity: 'info', diffCount: rows.length, samples: cleanSamples(rows),
    note: '司机端还显示这一趟、司机提成没结。可点「统一补完成行程」（订单此前已随波次完成，这里只补行程状态与司机提成）',
  }
}

export async function fixOpenTripsOfCompletedWaves() {
  const { recalcTripDriverCommission } = await import('@/lib/commission')
  const rows = await findCompletedWavesWithOpenTrips()
  const ids = rows.map(r => String(r.id))
  if (ids.length) await prisma.trip.updateMany({ where: { id: { in: ids } }, data: { status: 'COMPLETED' } })
  const failed: Array<{ trip: string; error: string }> = []
  for (const id of ids) {
    try { await recalcTripDriverCommission(id, prisma) } catch (e) { failed.push({ trip: id, error: e instanceof Error ? e.message : String(e) }) }
  }
  return { total: ids.length, fixed: rows.map(r => String(r.name ?? r.id)), failed }
}

/**
 * 状态是「已排波次 / Driver Assigned」，却不在任何有排程日期的波次里的订单（20261021）。
 * 来源：销售单列表原「生成拣货波次」按钮建的波次没有日期也没有司机，调度台按日期看不到它，
 * 22 点自动出发也不管，单子就悬着（按钮已改成跳调度台排车，POST /api/waves 也不再接受无日期带单）。
 */
export async function findOrphanWaveOrders(): Promise<Row[]> {
  return q(`
    SELECT o.id, o.code, o."restaurantName", o."deliveryDate",
           (SELECT string_agg(w.name, ', ') FROM "PickingWave" w WHERE o.id = ANY(w."orderIds")) AS "waves"
    FROM "Order" o
    WHERE o.status = 'WAVE_ASSIGNED'
      AND NOT EXISTS (SELECT 1 FROM "PickingWave" w WHERE w."waveDate" IS NOT NULL AND o.id = ANY(w."orderIds"))
    ORDER BY o."deliveryDate" NULLS LAST, o.code`)
}

const orphanWaveOrders: Check = async () => {
  const rows = await findOrphanWaveOrders()
  return {
    key: 'orphan_wave_orders', label: '显示「已排波次」但不在任何司机车上的订单', labelEn: 'Orders marked wave-assigned but on no dated wave',
    severity: 'info', diffCount: rows.length, samples: cleanSamples(rows),
    note: '调度台哪天都看不到这些单、也不会自动出发。可点「统一退回已确认」，再到调度台按日期拖给司机',
  }
}

/** 统一退回已确认：移出这些没有日期的波次，状态 WAVE_ASSIGNED → CONFIRMED（与调度台「移出」同一套逻辑） */
export async function fixOrphanWaveOrders() {
  const { removeOrderFromAllWaves } = await import('@/lib/wave-assign')
  const rows = await findOrphanWaveOrders()
  const fixed: string[] = []
  const failed: Array<{ code: string; error: string }> = []
  for (const r of rows) {
    const code = String(r.code ?? r.id)
    try {
      await removeOrderFromAllWaves(String(r.id))
      // 一个波次都不在、只是状态停在 WAVE_ASSIGNED 的，removeOrderFromAllWaves 不会改状态，这里补上
      await prisma.order.updateMany({ where: { id: String(r.id), status: 'WAVE_ASSIGNED' }, data: { status: 'CONFIRMED' } })
      fixed.push(code)
    } catch (e) {
      failed.push({ code, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { total: rows.length, fixed, failed }
}

const inventoryValue: Check = async () => {
  const [gl] = await q(`
    SELECT COALESCE(SUM(l.debit - l.credit), 0)::float AS bal
    FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e.id = l."entryId" JOIN "Account" a ON a.id = l."accountId"
    WHERE a.code = '1300' AND e.status = 'POSTED'`)
  const [sv] = await q(`SELECT COALESCE(SUM(GREATEST("qtyOnHand", 0) * COALESCE("standardPrice", 0)), 0)::float AS v FROM "Product" WHERE type = 'PRODUCT'`)
  const [grni] = await q(`
    SELECT COALESCE(SUM(l.credit - l.debit), 0)::float AS bal
    FROM "JournalEntryLine" l JOIN "JournalEntry" e ON e.id = l."entryId" JOIN "Account" a ON a.id = l."accountId"
    WHERE a.code = '2150' AND e.status = 'POSTED'`)
  const [nocost] = await q(`
    SELECT COUNT(*)::int AS n FROM "StockMove"
    WHERE "unitCost" IS NULL AND "sourceType" IS DISTINCT FROM 'OPENING' AND "createdBy" IS NOT NULL`)
  const diff = Math.round((num(gl?.bal) - num(sv?.v)) * 100) / 100
  return {
    key: 'inventory_value', label: '总账存货(1300) vs 在手量 × 平均成本', labelEn: 'GL inventory (1300) vs on hand × average cost',
    severity: 'info', diffCount: Math.abs(diff) > 0.005 ? 1 : 0, amount: diff,
    figures: { glInventory: num(gl?.bal), stockValue: num(sv?.v), difference: diff, openGrni: num(grni?.bal), movesWithoutCost: num(nocost?.n) },
    samples: [],
    note: '出库按批次实际成本记，平均成本只是近似，这一项会有小额差；已收货未开票(2150)是收了货还没过账供应商账单的金额',
  }
}

/**
 * 采购行已收量 = Σ 收货/退货流水的业务单位数量（复式改造 L4）。
 * 只核对「所有收退货流水都挂了采购行」的行；改造前收的货流水上没有 purchaseOrderLineId，跳过。
 */
const poLineReceived: Check = async () => {
  const rows = await q(`
    WITH mv AS (
      SELECT "purchaseOrderLineId" AS lid, SUM(SIGN(qty) * COALESCE("uomQty", ABS(qty))) AS s
      FROM "StockMove" WHERE "purchaseOrderLineId" IS NOT NULL GROUP BY 1
    )
    SELECT pol.id, po.name AS po, pol."productName", pol."receivedQty"::float AS cached, mv.s::float AS ledger
    FROM "PurchaseOrderLine" pol
    JOIN mv ON mv.lid = pol.id
    JOIN "PurchaseOrder" po ON po.id = pol."purchaseOrderId"
    WHERE NOT EXISTS (
      SELECT 1 FROM "StockMove" m
      WHERE m."sourceId" = pol."purchaseOrderId" AND m."productId" = pol."productId"
        AND m."sourceType" IN ('PURCHASE_RECEIVE', 'PURCHASE_RETURN') AND m."purchaseOrderLineId" IS NULL
    )
    AND ABS(pol."receivedQty" - mv.s) > 0.0005`)
  return {
    key: 'po_line_received', label: '采购行已收量 = Σ 收货/退货流水', labelEn: 'PO line received qty = Σ receipt/return moves',
    severity: 'error', diffCount: rows.length, samples: cleanSamples(rows),
  }
}

const STOCK_CHECKS: Check[] = [stockOnHand, lotBalance, moveLocations, locationBalances, ordersWithoutStock, orphanWaveOrders, poLineReceived, inventoryValue]

/** 其它模块在这里登记自己的检查项 */
const EXTRA_CHECKS: Check[] = []
export function registerLedgerCheck(c: Check) { EXTRA_CHECKS.push(c) }

export const FINANCE_CHECKS: Check[] = [
  invoiceBalance, vendorBillBalance, creditNoteBounds, journalBalanced, missingAccounts,
  arGlVsSubledger, unappliedCreditNotes, paymentsWithoutJournal, uninvoicedOrders, openTripsOfCompletedWaves,
]

export async function runLedgerChecks(): Promise<LedgerCheckResult[]> {
  const out: LedgerCheckResult[] = []
  for (const c of [...FINANCE_CHECKS, ...STOCK_CHECKS, ...EXTRA_CHECKS]) {
    try {
      out.push(await c())
    } catch (e) {
      out.push({
        key: c.name || 'unknown', label: '检查执行失败', labelEn: 'Check failed to run', severity: 'error',
        diffCount: 1, samples: [{ error: e instanceof Error ? e.message : String(e) }],
      })
    }
  }
  return out
}

export function ledgerOk(results: LedgerCheckResult[]): boolean {
  return results.every(r => r.severity !== 'error' || r.diffCount === 0)
}

/** 跑一遍、存一行 LedgerCheckRun；失败项给老板/财务发站内通知 */
export async function runAndRecordLedgerCheck(trigger: 'AUTO' | 'MANUAL', createdBy?: string | null) {
  const t0 = Date.now()
  const results = await runLedgerChecks()
  const ok = ledgerOk(results)
  const run = await prisma.ledgerCheckRun.create({
    data: { trigger, ok, results: results as never, durationMs: Date.now() - t0, createdBy: createdBy ?? null },
  })
  if (!ok) {
    const failed = results.filter(r => r.severity === 'error' && r.diffCount > 0)
    const { notifyRole } = await import('@/lib/notify')
    await notifyRole(['BOSS', 'FINANCE'], {
      type: 'ledger_check_failed',
      title: '账本核对发现不一致',
      body: failed.map(f => `${f.label}：${f.diffCount} 条`).join('；'),
      data: { runId: run.id },
    })
  }
  return run
}
