
import { apiRouteErrorResponse } from '@/lib/api-route-error'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth, userHasPermission } from '@/lib/auth'
import { markUnreportedReceiptIssues } from '@/lib/receipt-manifest'
import { serializeApi } from '@/lib/api-serializer'
import { toDayKey } from '@/lib/analytics/metrics'
import { assertReturnReviewComplete, lockReturnOrders, returnError } from '@/lib/return-invoice-guard'

const permissions = ['finance.write_off.confirm', 'dispatch.goods_return.review'] as const

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const date = new URL(req.url).searchParams.get('date') || toDayKey(new Date())
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: '日期无效' }, { status: 400 })
    const [manifests, claims, reviews, exceptions, legacyIssues] = await Promise.all([
      prisma.receiptManifest.findMany({ where: { businessDate: date }, include: { entries: { orderBy: { orderCode: 'asc' } } }, orderBy: { departedAt: 'asc' } }),
      prisma.returnIntake.findMany({ where: { status: { in: ['OPEN', 'CUSTOMER_IDENTIFIED'] } }, select: { id: true, customerName: true, productName: true, createdAt: true, vehiclePlate: true, candidateOrderIds: true }, orderBy: { createdAt: 'asc' } }),
      prisma.orderReturn.findMany({ where: { status: { in: ['PENDING_REVIEW', 'WAREHOUSE_PENDING'] } }, select: { id: true, orderId: true, productName: true, createdAt: true, status: true }, orderBy: { createdAt: 'asc' } }),
      prisma.receiptManifest.findMany({ where: { OR: [
        { businessDate: { lt: toDayKey(new Date()) }, handedOverAt: null },
        { businessDate: { lt: toDayKey(new Date()) }, scanClosedAt: null, entries: { some: { scannedAt: null } } }, { scanClosedAt: { not: null }, entries: { some: { scannedAt: null } } },
        { entries: { some: { paperIssue: { not: null }, paperReviewedAt: null } } },
      ] }, select: { tripId: true, businessDate: true, driverName: true, handedOverAt: true, departedAt: true, scanClosedAt: true,
        entries: { where: { OR: [{ scannedAt: null }, { paperIssue: { not: null }, paperReviewedAt: null }] }, select: { orderId: true, orderCode: true, scannedAt: true, paperIssue: true, paperReviewedAt: true } },
      }, orderBy: { businessDate: 'asc' } }),
      prisma.order.findMany({ where: { returnStatus: 'ISSUE' }, select: { id: true, code: true, restaurantName: true, returnIssueNote: true, returnIssueAt: true, createdAt: true }, orderBy: { returnIssueAt: 'asc' } }),
    ])
    const orderIds = [...new Set(manifests.flatMap(manifest => manifest.entries.map(entry => entry.orderId)))]
    const [orders, returns, invoices, warehouseDiscoveries] = await Promise.all([
      prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, returnStatus: true } }),
      prisma.orderReturn.findMany({ where: { orderId: { in: orderIds } }, select: { id: true, orderId: true, status: true, sourceTripId: true, registeredById: true } }),
      prisma.invoice.findMany({ where: { saleOrderIds: { hasSome: orderIds }, status: { in: ['POSTED', 'PAID'] } }, select: { saleOrderIds: true } }),
      prisma.returnIntake.groupBy({ by: ['sourceTripId'], where: { sourceType: 'WAREHOUSE', sourceTripId: { in: manifests.map(manifest => manifest.tripId) }, status: { not: 'REJECTED' } }, _count: { _all: true } }),
    ])
    const unclaimedDetections = new Map(warehouseDiscoveries.map(row => [row.sourceTripId, row._count._all]))
    const byOrder = new Map(orders.map(order => [order.id, order.returnStatus]))
    const invoiced = new Set(invoices.flatMap(invoice => invoice.saleOrderIds))
    const hasReturn = new Set(returns.map(ret => ret.orderId))
    const pending = new Set(reviews.map(ret => ret.orderId))
    const unresolvedPhotos = new Set(claims.flatMap(claim => claim.candidateOrderIds))
    return NextResponse.json(serializeApi({ date, claims, reviews, exceptions, legacyIssues, manifests: manifests.map(manifest => ({
      ...manifest, unmatchedDiscoveries: unclaimedDetections.get(manifest.tripId) ?? 0, entries: manifest.entries.map(entry => {
        const paperPending = Boolean(entry.paperIssue && !entry.paperReviewedAt)
        const problem = hasReturn.has(entry.orderId) || unresolvedPhotos.has(entry.orderId) || Boolean(entry.paperIssue) || byOrder.get(entry.orderId) === 'ISSUE'
        const held = pending.has(entry.orderId) || unresolvedPhotos.has(entry.orderId) || paperPending || byOrder.get(entry.orderId) === 'ISSUE'
        return { ...entry, held, reconciled: byOrder.get(entry.orderId) === 'RETURNED',
          lane: !entry.scannedAt ? (manifest.scanClosedAt ? 'missing' : 'expected') : problem ? invoiced.has(entry.orderId) ? 'red' : 'yellow' : 'green',
          unreported: entry.unreportedDetectedAt != null,
        }
      }),
    })) }))
  }, { require: ['finance.write_off.confirm', 'dispatch.goods_return.review'] })
}

export async function POST(req: Request) {
  return withAuth(req, async user => {
    try {
      const body = await req.json()
      const sales = ['review_paper', 'review_legacy'].includes(body.action)
      if (!userHasPermission(user, sales ? permissions[1] : permissions[0])) returnError('权限不足', 403)
      if (body.action === 'review_legacy') {
        const orderId = typeof body.orderId === 'string' ? body.orderId : ''
        const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : ''
        if (!orderId || !note) returnError('请选择问题单并填写销售核对结果', 400)
        await prisma.$transaction(async tx => {
          await lockReturnOrders(tx, [orderId])
          await assertReturnReviewComplete(tx, [orderId])
          const updated = await tx.order.updateMany({ where: { id: orderId, returnStatus: 'ISSUE' }, data: { returnStatus: 'PENDING', returnIssueNote: null, returnIssueAt: null } })
          if (!updated.count) returnError('该订单已处理或无需销售核对')
          await tx.orderAuditLog.create({ data: { orderId, userId: user.userId, action: 'updated', changedFields: { detail: '签收单问题经销售核对', note } } })
        })
        return NextResponse.json({ completed: true })
      }
      const tripId = typeof body.tripId === 'string' ? body.tripId : ''
      if (!tripId) returnError('请选择司机行程', 400)

      const manifest = await prisma.receiptManifest.findUnique({ where: { tripId }, select: { entries: { select: { orderId: true, orderCode: true } } } })
      if (!manifest) returnError('应回清单不存在', 404)

      if (body.action === 'handover') {
        const received = body.actualReceived, pieces = body.returnPieces
        if (body.paperDelivered !== true || body.goodsDelivered !== true || typeof received !== 'number' || !Number.isFinite(received) || received < 0 || received >= 1e12 || !Number.isInteger(pieces) || pieces < 0 || pieces >= 1e11) {
          returnError('请确认已交签收单和退货实物，并填写实交款、退货件数（没有填 0）', 400)
        }
        const updated = await prisma.receiptManifest.updateMany({ where: { tripId, handedOverAt: null }, data: {
          handedOverAt: new Date(), handedOverBy: user.name ?? user.email, actualReceived: received, returnPieces: pieces,
        } })
        return NextResponse.json({ completed: Boolean(updated.count) })
      }
      if (sales) {
        const orderId = String(body.orderId ?? '')
        const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : ''
        if (!note) returnError('请填写销售核对结果', 400)
        await prisma.$transaction(async tx => {
          await lockReturnOrders(tx, [orderId])
          const updated = await tx.receiptManifestEntry.updateMany({ where: { tripId, orderId, paperIssue: { not: null }, paperReviewedAt: null }, data: {
            paperReviewedAt: new Date(), paperReviewedBy: user.name ?? user.email, paperReviewNote: note,
          } })
          if (!updated.count) returnError('该签收单已处理或无需销售核对')
        })
        return NextResponse.json({ completed: true })
      }

      if (body.action === 'manual_receipt') {
        const orderId = String(body.orderId ?? '')
        const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : ''
        if (!orderId || !note) returnError('请选择缺单并填写人工确认依据', 400)
        await prisma.$transaction(async tx => {
          await lockReturnOrders(tx, [orderId])
          const updated = await tx.receiptManifestEntry.updateMany({
            where: { tripId, orderId, scannedAt: null, manifest: { scanClosedAt: { not: null } } },
            data: { scannedAt: new Date() },
          })
          if (!updated.count) returnError('该单不是待确认的缺单')
          await tx.orderAuditLog.create({ data: { orderId, userId: user.userId, action: 'updated', changedFields: { detail: '人工确认缺失签收单', note, tripId } } })
        })
        return NextResponse.json({ completed: true })
      }

      if (body.action !== 'scan' || !Array.isArray(body.scans) || body.scans.length > 1000) returnError('请选择有效扫码批次', 400)
      const byCode = new Map(manifest.entries.filter(entry => entry.orderCode).map(entry => [entry.orderCode!.toUpperCase(), entry.orderId]))
      const scanned = new Map<string, string | null>()
      const unknown = new Set<string>()
      for (const item of body.scans) {
        if (typeof item?.code !== 'string' || !item.code.trim()) returnError('扫码单号不能为空', 400)
        const code = item.code.trim().toUpperCase()
        const id = byCode.get(code)
        if (!id) { unknown.add(code); continue }
        const note = typeof item.paperIssue === 'string' ? item.paperIssue.trim().slice(0, 500) : ''
        scanned.set(id, note || scanned.get(id) || null)
      }
      if (unknown.size) return NextResponse.json({ error: `以下单号不在此行程应回清单：${[...unknown].join('、')}` }, { status: 400 })
      const now = new Date()
      await prisma.$transaction(async tx => {
        await lockReturnOrders(tx, [...scanned.keys()])
        await tx.$queryRaw`SELECT "tripId" FROM "ReceiptManifest" WHERE "tripId" = ${tripId} FOR UPDATE`
        if (scanned.size) {
          const payload = JSON.stringify([...scanned].map(([orderId, issue]) => ({ orderId, issue })))
          await tx.$executeRaw`
            UPDATE "ReceiptManifestEntry" AS entry
            SET "scannedAt" = COALESCE(entry."scannedAt", ${now}),
                "paperIssue" = COALESCE(incoming.issue, entry."paperIssue"),
                "paperReviewedAt" = CASE WHEN incoming.issue IS NOT NULL AND incoming.issue IS DISTINCT FROM entry."paperIssue" THEN NULL ELSE entry."paperReviewedAt" END,
                "paperReviewedBy" = CASE WHEN incoming.issue IS NOT NULL AND incoming.issue IS DISTINCT FROM entry."paperIssue" THEN NULL ELSE entry."paperReviewedBy" END,
                "paperReviewNote" = CASE WHEN incoming.issue IS NOT NULL AND incoming.issue IS DISTINCT FROM entry."paperIssue" THEN NULL ELSE entry."paperReviewNote" END
            FROM jsonb_to_recordset(${payload}::jsonb) AS incoming("orderId" text, issue text)
            WHERE entry."tripId" = ${tripId} AND entry."orderId" = incoming."orderId"
          `
        }
        const problemOrderIds = [...scanned].filter(([, issue]) => issue).map(([orderId]) => orderId)
        await markUnreportedReceiptIssues(tx, problemOrderIds, tripId)
        if (body.close === true) await tx.receiptManifest.updateMany({ where: { tripId, scanClosedAt: null }, data: { scanClosedAt: now } })
      })
      return NextResponse.json({ scanned: scanned.size, closed: body.close === true })
    } catch (error) {
      const err = error as { status?: number; message?: string }
      if (err.status) return NextResponse.json({ error: err.message }, { status: err.status })
      console.error('[receipt-manifests]', error)
      return apiRouteErrorResponse(error, '回单处理失败')
    }
  }, { require: ['finance.write_off.confirm', 'dispatch.goods_return.review'] })
}
