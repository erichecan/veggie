import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog, diffChanges } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'
import { createDraftVendorBillForPurchaseOrder } from '@/lib/vendor-bill-from-po'
import { notifyRole } from '@/lib/notify'
import { eur } from '@/lib/format-money'
import { eurAmount, resolveExchangeRate } from '@/lib/fx-eur'
import { renderPurchaseOrderHtml } from '@/lib/purchase-order-pdf'
import { renderHtmlToPdf } from '@/lib/print/render-pdf'
import { sendPurchaseOrderRfq } from '@/lib/email'

const PO_TRACKED_FIELDS = ['status', 'confirmedAt', 'cancelledAt', 'lockedAt', 'notes', 'expectedDate', 'editApprovalRequired']

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  DRAFT:       ['SENT', 'CONFIRMED', 'CANCELLED'],
  SENT:        ['CONFIRMED', 'TO_APPROVE', 'CANCELLED'],
  TO_APPROVE:  ['CONFIRMED', 'CANCELLED'],
  CONFIRMED:   ['RECEIVED', 'CANCELLED'],
  RECEIVED:    ['INVOICED', 'CANCELLED'],
  INVOICED:    ['LOCKED', 'CANCELLED'],
  LOCKED:      [],
  CANCELLED:   ['DRAFT'],
}

const PO_CONFIRMED_SAFE_FIELDS = ['notes', 'expectedDate']

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const po = await p.purchaseOrder.findUnique({
      where: { id },
      include: { lines: { orderBy: { sequence: 'asc' } }, receipts: true, bills: true },
    })
    if (!po) return NextResponse.json({ error: '采购订单不存在' }, { status: 404 })

    // 操作时间线：复用 ActionLog（创建询价单/状态流转已有记录），供详情页展示"何时发生了什么"
    const activityLog = await p.actionLog.findMany({
      where: { resource: 'purchase_order', resourceId: id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, action: true, detail: true, userName: true, createdAt: true },
    })

    return NextResponse.json(serializeApi({ ...po, activityLog }))
  } catch (error) {
    console.error('[GET /api/purchase-orders/:id]', error)
    return NextResponse.json({ error: '获取失败' }, { status: 500 })
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const data = await req.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      const poBefore = await p.purchaseOrder.findUnique({ where: { id }, include: { lines: true } })
      if (!poBefore) return NextResponse.json({ error: '采购订单不存在' }, { status: 404 })

      // LOCKED state is immutable
      if (poBefore.status === 'LOCKED') {
        return NextResponse.json({ error: '已锁定的采购单不可编辑' }, { status: 409 })
      }

      if (!['DRAFT', 'SENT'].includes(poBefore.status)) {
        return NextResponse.json({ error: '只有草稿/已发送状态可编辑' }, { status: 409 })
      }

      const { notes, expectedDate, supplierId, exchangeRate: exchangeRateInput, lines: linesPayload } = data

      const headerUpdate: Record<string, unknown> = {}
      if (notes !== undefined) headerUpdate.notes = notes ? String(notes) : null
      if (expectedDate !== undefined) headerUpdate.expectedDate = expectedDate ? new Date(expectedDate) : null
      if (supplierId !== undefined) headerUpdate.supplierId = String(supplierId)

      // 汇率可在 DRAFT/SENT 阶段补录/修正(币种下单后不可再改，见 lib/create-purchase-order.ts)；
      // 补上汇率后连带把行/表头的 *Eur 字段一起重算，不能只改 exchangeRate 留下陈旧的折算值(20260713)。
      const rateProvided = exchangeRateInput !== undefined
      const { exchangeRate: effectiveRate, exchangeRatePending: effectivePending } = rateProvided
        ? resolveExchangeRate(poBefore.currency, exchangeRateInput)
        : { exchangeRate: poBefore.exchangeRate == null ? null : Number(poBefore.exchangeRate), exchangeRatePending: poBefore.exchangeRatePending }
      if (rateProvided) {
        headerUpdate.exchangeRate = effectiveRate
        headerUpdate.exchangeRatePending = effectivePending
      }

      // P1-2: Capture old line state for audit
      const oldLines = (poBefore.lines as Array<Record<string, unknown>>).reduce(
        (acc: Record<string, Record<string, unknown>>, l: Record<string, unknown>) => {
          acc[l.id as string] = l
          return acc
        },
        {} as Record<string, Record<string, unknown>>,
      )
      const lineChanges: { modified: Array<{ lineId: string; productName: string; field: string; from: unknown; to: unknown }> } = { modified: [] }

      if (Array.isArray(linesPayload)) {
        // 新增行：客户端给临时 id（"new-" 前缀），必须带 productId 才能落库
        const isNewLine = (l: Record<string, unknown>) => String(l.id ?? '').startsWith('new-')
        const payloadIds = new Set(
          linesPayload.filter((l: Record<string, unknown>) => !isNewLine(l)).map((l: Record<string, unknown>) => String(l.id)),
        )
        // 删除行：原有行里，这次提交没带回来的即视为被删
        const deletedIds = Object.keys(oldLines).filter(lid => !payloadIds.has(lid))

        const maxSequence = Object.values(oldLines).reduce(
          (max, l) => Math.max(max, Number((l as Record<string, unknown>).sequence ?? 0)), 0,
        )
        let nextSequence = maxSequence

        // 准入闸门：只查新增行，已有行（哪怕它引用的商品后来被关闭 canBePurchased）永远不受影响
        const newLinePOProductIds = linesPayload
          .filter((l: Record<string, unknown>) => isNewLine(l))
          .map((l: Record<string, unknown>) => String(l.productId ?? ''))
          .filter(Boolean)
        if (newLinePOProductIds.length > 0) {
          const newLinePOProducts = await p.product.findMany({
            where: { id: { in: newLinePOProductIds } },
            include: { template: { select: { canBePurchased: true } } },
          })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const notPurchasable = newLinePOProducts.filter((prod: any) => prod.template?.canBePurchased === false)
          if (notPurchasable.length > 0) {
            return NextResponse.json(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              { error: `商品「${notPurchasable.map((prod: any) => prod.name).join('、')}」不可采购，无法加入采购单` },
              { status: 400 },
            )
          }
        }

        const lineOps = linesPayload.map((l: Record<string, unknown>) => {
          const orderedQty = Number(l.orderedQty)
          const unitCost = Number(l.unitCost)
          const taxRate = l.taxRate !== undefined ? Number(l.taxRate) : 0
          const subtotalExTax = orderedQty * unitCost
          const taxAmount = subtotalExTax * taxRate / 100
          const subtotalIncTax = subtotalExTax + taxAmount
          const bestBefore = l.bestBefore
            ? new Date(l.bestBefore as string)
            : null

          if (isNewLine(l)) {
            const productId = String(l.productId ?? '')
            if (!productId) throw Object.assign(new Error('新增采购行缺少商品'), { status: 400 })
            nextSequence += 10
            lineChanges.modified.push({ lineId: String(l.id), productName: String(l.productName ?? ''), field: 'added', from: null, to: orderedQty })
            return p.purchaseOrderLine.create({
              data: {
                purchaseOrderId: id,
                productId,
                productName: String(l.productName ?? ''),
                uomId: l.uomId ? String(l.uomId) : null,
                orderedQty, unitCost, taxRate, subtotalExTax, taxAmount, subtotalIncTax,
                unitCostEur: eurAmount(unitCost, effectiveRate, 4),
                subtotalExTaxEur: eurAmount(subtotalExTax, effectiveRate),
                taxAmountEur: eurAmount(taxAmount, effectiveRate),
                subtotalIncTaxEur: eurAmount(subtotalIncTax, effectiveRate),
                bestBefore,
                sequence: nextSequence,
              },
            })
          }

          // P1-2: Detect per-line changes
          const lineId = String(l.id)
          const old = oldLines[lineId]
          if (old) {
            const pName = String(old.productName ?? '')
            if (toNum(old.orderedQty) !== orderedQty) {
              lineChanges.modified.push({ lineId, productName: pName, field: 'orderedQty', from: toNum(old.orderedQty), to: orderedQty })
            }
            if (toNum(old.unitCost) !== unitCost) {
              lineChanges.modified.push({ lineId, productName: pName, field: 'unitCost', from: toNum(old.unitCost), to: unitCost })
            }
            if (toNum(old.taxRate) !== taxRate) {
              lineChanges.modified.push({ lineId, productName: pName, field: 'taxRate', from: toNum(old.taxRate), to: taxRate })
            }
          }

          return p.purchaseOrderLine.update({
            where: { id: lineId },
            data: {
              orderedQty, unitCost, taxRate, subtotalExTax, taxAmount, subtotalIncTax,
              unitCostEur: eurAmount(unitCost, effectiveRate, 4),
              subtotalExTaxEur: eurAmount(subtotalExTax, effectiveRate),
              taxAmountEur: eurAmount(taxAmount, effectiveRate),
              subtotalIncTaxEur: eurAmount(subtotalIncTax, effectiveRate),
              ...(l.bestBefore !== undefined && { bestBefore }),
            },
          })
        })

        for (const lid of deletedIds) {
          const old = oldLines[lid]
          lineChanges.modified.push({ lineId: lid, productName: String(old?.productName ?? ''), field: 'deleted', from: toNum(old?.orderedQty), to: null })
          lineOps.push(p.purchaseOrderLine.delete({ where: { id: lid } }))
        }

        await prisma.$transaction(lineOps)

        // Recalculate PO totals from the final line set (更新行 + 新增行，去掉被删的)
        const finalLines = linesPayload.filter((l: Record<string, unknown>) => !deletedIds.includes(String(l.id)))
        let subtotalExTax = 0, totalTax = 0
        for (const l of finalLines) {
          const qty = Number(l.orderedQty)
          const cost = Number(l.unitCost)
          const tax = l.taxRate !== undefined ? Number(l.taxRate) : 0
          const sub = qty * cost
          subtotalExTax += sub
          totalTax += sub * tax / 100
        }
        headerUpdate.subtotalExTax = subtotalExTax
        headerUpdate.totalTax = totalTax
        headerUpdate.totalIncTax = subtotalExTax + totalTax
        headerUpdate.subtotalExTaxEur = eurAmount(subtotalExTax, effectiveRate)
        headerUpdate.totalTaxEur = eurAmount(totalTax, effectiveRate)
        headerUpdate.totalIncTaxEur = eurAmount(subtotalExTax + totalTax, effectiveRate)
        headerUpdate.freightAmountEur = eurAmount(poBefore.freightAmount, effectiveRate, 2)
      } else if (rateProvided) {
        // 只补汇率、没有重提行数据：沿用现存行/表头的原币金额，按新汇率重算全部 *Eur 字段
        headerUpdate.subtotalExTaxEur = eurAmount(poBefore.subtotalExTax, effectiveRate)
        headerUpdate.totalTaxEur = eurAmount(poBefore.totalTax, effectiveRate)
        headerUpdate.totalIncTaxEur = eurAmount(poBefore.totalIncTax, effectiveRate)
        headerUpdate.freightAmountEur = eurAmount(poBefore.freightAmount, effectiveRate, 2)
        await prisma.$transaction(
          (poBefore.lines as Array<Record<string, unknown>>).map(l => p.purchaseOrderLine.update({
            where: { id: l.id as string },
            data: {
              unitCostEur: eurAmount(l.unitCost, effectiveRate, 4),
              subtotalExTaxEur: eurAmount(l.subtotalExTax, effectiveRate),
              taxAmountEur: eurAmount(l.taxAmount, effectiveRate),
              subtotalIncTaxEur: eurAmount(l.subtotalIncTax, effectiveRate),
            },
          })),
        )
      }

      const po = await p.purchaseOrder.update({
        where: { id },
        data: headerUpdate,
        include: { lines: { orderBy: { sequence: 'asc' } } },
      })

      const changes = diffChanges(
        poBefore as Record<string, unknown>,
        po as Record<string, unknown>,
        PO_TRACKED_FIELDS,
      )
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'purchase_order', resourceId: id,
        detail: `编辑采购单 ${poBefore.name}`,
        changes: Object.keys(changes).length > 0 ? changes : undefined,
        ...(lineChanges.modified.length > 0 && { lineChanges }),
      })

      return NextResponse.json(serializeApi(po))
    } catch (error) {
      console.error('[PUT /api/purchase-orders/:id]', error)
      return NextResponse.json({ error: '保存失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'WAREHOUSE'])
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const { action } = await req.json()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const po = await p.purchaseOrder.findUnique({
        where: { id },
        include: { lines: true },
      })
      if (!po) return NextResponse.json({ error: '采购订单不存在' }, { status: 404 })

      // LOCKED is immutable — reject all actions
      if (po.status === 'LOCKED') {
        return NextResponse.json({ error: '已锁定的采购单不可变更' }, { status: 409 })
      }

      const targetStatus: string | null = ({
        send:           'SENT',
        confirm:        'CONFIRMED',
        cancel:         'CANCELLED',
        receive:        'RECEIVED',
        invoice:        'INVOICED',
        lock:           'LOCKED',
        reset_to_draft: 'DRAFT',
        approve:        'CONFIRMED',
        to_approve:     'TO_APPROVE',
      } as Record<string, string>)[action] ?? null

      if (!targetStatus) {
        return NextResponse.json({ error: `未知 action: ${action}` }, { status: 400 })
      }

      // 汇率待确认(非欧元单接口取不到实时汇率)不许推进到「确认」——这是自动生成供应商账单
      // /通知财务的触发点，真金白银的应付账款不能拿一个未知汇率算出来的数(20260713)。
      // 挡在这里而不是创建时，是为了不阻塞询价单本身的编辑/发送流程，只在真正要花钱这一步拦。
      if (targetStatus === 'CONFIRMED' && po.exchangeRatePending) {
        return NextResponse.json({ error: `汇率待确认（${po.currency}→EUR），请先在采购单里补充汇率再确认` }, { status: 409 })
      }

      if (!(ALLOWED_TRANSITIONS[po.status] ?? []).includes(targetStatus)) {
        return NextResponse.json({
          error: `状态转换不合法: ${po.status} → ${targetStatus}`,
        }, { status: 409 })
      }

      // 真正把询价单发给供应商：邮箱缺失/邮件发送失败都在这里挡住，
      // 不允许出现"界面显示已发送但实际没发邮件"的假成功(20260730)
      if (action === 'send') {
        const supplier = await p.customer.findUnique({ where: { id: po.supplierId } })
        if (!supplier?.email) {
          return NextResponse.json({
            error: 'SUPPLIER_EMAIL_MISSING',
            message: '该供应商未设置邮箱地址，请先在客户资料中补全邮箱后再发送',
          }, { status: 400 })
        }
        try {
          // po.lines 在本函数开头是无序 include 出来的（不像 pdf/route.ts 那样 orderBy sequence），
          // 邮件附件要展示跟详情页/打印页一致的行顺序，这里补一次排序，不用为此多打一次 DB
          const orderedLines = [...po.lines].sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0))
          const pdfBuffer = await renderHtmlToPdf(renderPurchaseOrderHtml({ ...po, lines: orderedLines }, supplier))
          await sendPurchaseOrderRfq({
            to: supplier.email,
            poName: po.name,
            supplierName: supplier.name,
            pdfBuffer,
          })
        } catch (err) {
          console.error('[PATCH /api/purchase-orders/:id] send RFQ email failed', err)
          return NextResponse.json({
            error: 'EMAIL_SEND_FAILED',
            message: '邮件发送失败，请稍后重试',
          }, { status: 502 })
        }
      }

      // P0-1: Cancel check — reject if related documents exist
      if (targetStatus === 'CANCELLED') {
        const receiptCount = await p.goodsReceipt.count({ where: { purchaseOrderId: id } })
        if (receiptCount > 0) {
          return NextResponse.json({ error: '已有收货单，无法取消。请先删除收货单。' }, { status: 409 })
        }
        const activeBillCount = await p.vendorBill.count({
          where: { purchaseOrderId: id, status: { notIn: ['DRAFT', 'CANCELLED'] } },
        })
        if (activeBillCount > 0) {
          return NextResponse.json({ error: '已有已过账的供应商账单，无法取消。请先取消账单。' }, { status: 409 })
        }
      }

      // Build update data
      const updateData: Record<string, unknown> = {
        status: targetStatus,
      }

      // P0-2: CANCELLED → DRAFT reset — clear timestamps, keep stock as-is
      if (action === 'reset_to_draft') {
        updateData.confirmedAt = null
        updateData.cancelledAt = null
        updateData.lockedAt = null
        updateData.editApprovalRequired = false
      }

      if (targetStatus === 'CONFIRMED') {
        updateData.confirmedAt = po.confirmedAt ?? new Date()
      }
      if (targetStatus === 'CANCELLED') {
        updateData.cancelledAt = new Date()
      }
      if (targetStatus === 'LOCKED') {
        updateData.lockedAt = new Date()
      }

      const updated = await p.purchaseOrder.update({
        where: { id },
        data: updateData,
        include: { lines: true },
      })

      // SSOT：库存只能通过实际收货（GoodsReceipt）增加，"确认采购"只代表供应商接单，
      // 不产生任何库存/批次副作用——避免和收货单重复计数（历史 bug，见 20260710 采购模块升级）。

      // 确认采购单即代表应付款项已确定，自动生成 DRAFT 供应商账单并通知财务
      if (targetStatus === 'CONFIRMED' && po.status !== 'CONFIRMED') {
        const bill = await createDraftVendorBillForPurchaseOrder(p, id)
        if (bill) {
          const supplier = await p.customer.findUnique({ where: { id: bill.supplierId }, select: { name: true } })
          await notifyRole(['FINANCE'], {
            type: 'vendor_bill_draft',
            title: `新草稿账单：${bill.name}`,
            body: `采购单 ${po.name}（供应商 ${supplier?.name ?? bill.supplierId}）已确认，金额 ${eur(bill.totalIncTax)}，请核对并过账。`,
            data: { purchaseOrderId: id, vendorBillId: bill.id },
          })
        }
      }

      const changes = diffChanges(
        po as Record<string, unknown>,
        updated as Record<string, unknown>,
        PO_TRACKED_FIELDS,
      )
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'purchase_order', resourceId: id,
        detail: `PO ${po.name}: ${po.status} → ${targetStatus}`,
        changes: Object.keys(changes).length > 0 ? changes : undefined,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[PATCH /api/purchase-orders/:id]', error)
      return NextResponse.json({ error: '状态更新失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'WAREHOUSE'])
}
