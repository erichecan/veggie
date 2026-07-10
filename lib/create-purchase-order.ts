import { round2 } from '@/lib/decimal-helpers'

/**
 * 采购单创建 SSOT —— POST /api/purchase-orders 和"采购建议转采购单"共用同一份
 * 金额重算 + 编号生成逻辑，避免两处各写一套导致金额算法跑偏。
 */

export interface CreatePOLineInput {
  productId: string
  productName?: string
  uomId?: string | null
  orderedQty: number
  unitCost: number
  taxRate?: number
  sequence?: number
  bestBefore?: string | Date | null
}

export interface CreatePOInput {
  supplierId: string
  lines: CreatePOLineInput[]
  orderDate?: string | Date | null
  expectedDate?: string | Date | null
  currency?: string
  notes?: string | null
  createdBy?: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

export async function createPurchaseOrder(tx: Tx, input: CreatePOInput) {
  const supplierId = input.supplierId.trim()
  if (!supplierId) throw Object.assign(new Error('供应商不能为空'), { status: 400 })
  if (input.lines.length === 0) throw Object.assign(new Error('采购行不能为空'), { status: 400 })

  let subtotalExTax = 0
  let totalTax = 0
  const recomputedLines = input.lines.map((raw, i) => {
    const qty = Number(raw.orderedQty)
    const unitCost = Number(raw.unitCost)
    const taxRate = Number(raw.taxRate ?? 0)
    if (!Number.isFinite(qty) || qty <= 0) {
      throw Object.assign(new Error(`采购行数量无效：${raw.productName ?? raw.productId}`), { status: 400 })
    }
    if (!Number.isFinite(unitCost) || unitCost < 0 || unitCost > 1_000_000) {
      throw Object.assign(new Error(`采购行单价无效：${raw.productName ?? raw.productId}`), { status: 400 })
    }
    const ex = round2(qty * unitCost)
    const tax = round2(ex * taxRate)
    const inc = round2(ex + tax)
    subtotalExTax += ex
    totalTax += tax
    return {
      productId: raw.productId,
      productName: (raw.productName ?? '').trim().slice(0, 200),
      uomId: raw.uomId ?? null,
      orderedQty: qty,
      receivedQty: 0,
      invoicedQty: 0,
      unitCost,
      taxRate,
      subtotalExTax: ex,
      taxAmount: tax,
      subtotalIncTax: inc,
      bestBefore: raw.bestBefore ? new Date(raw.bestBefore) : null,
      sequence: raw.sequence ?? (i + 1) * 10,
    }
  })
  subtotalExTax = round2(subtotalExTax)
  totalTax = round2(totalTax)
  const totalIncTax = round2(subtotalExTax + totalTax)

  const count = await tx.purchaseOrder.count()
  const name = `PO-${String(count + 1).padStart(5, '0')}`

  return tx.purchaseOrder.create({
    data: {
      name,
      supplierId,
      status: 'DRAFT',
      orderDate: input.orderDate ? new Date(input.orderDate) : new Date(),
      expectedDate: input.expectedDate ? new Date(input.expectedDate) : null,
      currency: input.currency ?? 'EUR',
      subtotalExTax,
      totalTax,
      totalIncTax,
      notes: input.notes ?? null,
      createdBy: input.createdBy ?? null,
      lines: { create: recomputedLines },
    },
    include: { lines: true },
  })
}
