import { createTripFromWave } from '../../lib/trip-from-wave'
import { PUT as updateWave } from '../../app/api/waves/[id]/route'
import { LOC } from '../../lib/stock-locations'
/** Isolated PostgreSQL + actual authenticated route handlers. Never run on production. */
import assert from 'node:assert/strict'
import { prisma } from '../../lib/db'
import { signToken } from '../../lib/auth'
import { encodePermissions } from '../../lib/rbac/bitmap'
import { createOrderReturn } from '../../lib/order-returns'
import { createDraftInvoiceForOrder, type InvoiceTx } from '../../lib/invoice-from-order'
import { assertReturnsResolved } from '../../lib/return-workflow'
import { PUT as warehouseVerify } from '../../app/api/order-returns/[id]/warehouse-verify/route'
import { PUT as salesReview } from '../../app/api/order-returns/[id]/review/route'
import { PUT as financeReview } from '../../app/api/credit-note-requests/[id]/route'
import { POST as postInvoice } from '../../app/api/invoices/[id]/post/route'
import { PUT as intakeReview } from '../../app/api/order-returns/intakes/[id]/route'
import { POST as driverReport, GET as driverReturns } from '../../app/api/trips/[id]/returns/route'

const url = new URL(process.env.DATABASE_URL ?? '')
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55449'); assert.equal(url.pathname, '/return_workflow_audit')
const checks: string[] = []
let token = ''
let actor: { userId: string; email: string; name: string }
const request = (body: unknown, method = 'PUT', path = '/api/audit') => new Request(`http://localhost${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) })
async function call(handler: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>, id: string, body: unknown, expected = 200) {
  const response = await handler(request(body), { params: Promise.resolve({ id }) })
  const data = await response.json()
  assert.equal(response.status, expected, JSON.stringify(data)); return data
}
let sequence = Date.now() % 100000000
async function fixture(status: 'none' | 'DRAFT' | 'POSTED' | 'PAID' = 'none') {
  const customer = await prisma.customer.create({ data: { name: `Return audit ${++sequence}`, paymentTerm: 'monthly' } })
  const product = await prisma.product.create({ data: { name: `Audit product ${sequence}`, unitOfMeasure: 'CASE', images: [] } })
  const order = await prisma.order.create({ data: { code: `RETURN-AUDIT-${sequence}`, restaurantId: customer.id, restaurantName: customer.name, items: [], status: 'COMPLETED', paymentMethod: 'CASH', totalAmount: 50, deliveryDate: new Date(), returnStatus: 'RETURNED' } })
  const line = await prisma.orderLine.create({ data: { orderId: order.id, productId: product.id, productName: product.name, spec: '6kg / case', uomName: 'CASE', unitPrice: 10, taxRate: 0.23, orderedQty: 5, deliveredQty: 5, subtotal: 50 } })
  const invoice = status === 'none' ? null : await prisma.invoice.create({ data: { name: `AUDIT-INV-${sequence}`, customerId: customer.id, customerName: customer.name, saleOrderIds: [order.id], status, lines: [{ orderLineId: line.id, productId: product.id, qty: 5, unitPrice: 10, taxRate: .23, subtotalExTax: 50, taxAmount: 11.5, subtotalIncTax: 61.5 }], subtotalExTax: 50, totalTax: 11.5, totalIncTax: 61.5, amountDue: status === 'PAID' ? 0 : 61.5 } })
  const ret = await prisma.$transaction(tx => createOrderReturn(tx, { orderId: order.id, orderLineId: line.id, quantity: 2, reason: 'quality issue' }, actor))
  return { customer, product, order, line, invoice, ret }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function reviewed(f: Fixture, disposition = 'SELLABLE', quantity = 2) {
  await call(warehouseVerify, f.ret.id, { action: 'verify', disposition, note: 'Received and quality checked', acceptedQuantity: 2 })
  assert.equal(await prisma.stockMove.count({ where: { sourceId: f.ret.id } }), 0)
  const result = await call(salesReview, f.ret.id, { action: 'approve', approvedQuantity: quantity, note: quantity < 2 ? 'Partial approved after check' : 'Approved' })
  assert.equal(Number((await prisma.orderLine.findUniqueOrThrow({ where: { id: f.line.id } })).deliveredQty), 5)
  assert.equal(await prisma.stockMove.count({ where: { sourceId: f.ret.id } }), 0)
  return result.creditNoteRequests[0]
}
async function state(f: Fixture) {
  const [ret, line, product, notes, moves] = await Promise.all([
    prisma.orderReturn.findUniqueOrThrow({ where: { id: f.ret.id } }), prisma.orderLine.findUniqueOrThrow({ where: { id: f.line.id } }), prisma.product.findUniqueOrThrow({ where: { id: f.product.id } }),
    prisma.creditNote.findMany({ where: { customerId: f.customer.id }, include: { lines: true } }), prisma.stockMove.findMany({ where: { sourceId: f.ret.id } }),
  ]); return { ret, line, product, notes, moves }
}
async function main() {
  for (const [usage, id] of Object.entries(LOC)) await prisma.stockLocation.upsert({ where: { id }, create: { id, code: id, name: id, usage }, update: {} })
  const user = await prisma.user.create({ data: { email: [`return-audit-${Date.now()}`, 'example.invalid'].join('@'), name: 'Return audit', passwordHash: 'synthetic-only', role: 'FINANCE', roles: ['FINANCE'] } })
  actor = { userId: user.id, email: user.email, name: user.name! }
  token = await signToken({ ...actor, role: 'FINANCE', pm: encodePermissions(['dispatch.goods_return.warehouse_verify', 'dispatch.goods_return.review', 'finance.credit_note.create', 'finance.invoice.pay', 'dispatch.trip.read', 'dispatch.trip.report_return', 'dispatch.wave.update']), ds: 'ALL' })
  const a = await fixture()
  await assert.rejects(() => createDraftInvoiceForOrder(prisma as unknown as InvoiceTx, a.order.id), /退货尚未完成/)
  await call(warehouseVerify, a.ret.id, { action: 'verify', disposition: 'SELLABLE' }, 400)
  const ar = await reviewed(a)
  await assert.rejects(() => createDraftInvoiceForOrder(prisma as unknown as InvoiceTx, a.order.id), /退货尚未完成/)
  await call(financeReview, ar.id, { action: 'approve' })
  let s = await state(a); assert.equal(s.ret.status, 'SETTLED'); assert.equal(Number(s.line.deliveredQty), 3); assert.equal(Number(s.product.qtyOnHand), 2); assert.equal(s.notes.length, 0)
  const inv = await prisma.invoice.findFirstOrThrow({ where: { saleOrderIds: { has: a.order.id } } }); assert.equal(Number(inv.totalIncTax), 36.9); assert.equal(Number(inv.amountDue), 36.9)
  await call(financeReview, ar.id, { action: 'approve' }, 409)
  assert.equal((await state(a)).moves.length, 1)
  checks.push('un-invoiced return: all stages, invoice block, no pre-Finance effects, atomic quantity/stock/invoice, repeat confirmation blocked')

  const b = await fixture('DRAFT'); const br = await reviewed(b, 'SCRAP', 1)
  await call(postInvoice, b.invoice!.id, {}, 409)
  await call(financeReview, br.id, { action: 'reject', reviewNote: 'Please check amount again' })
  s = await state(b); assert.equal(s.ret.status, 'PENDING_REVIEW'); assert.equal(s.moves.length, 0)
  const br2 = await call(salesReview, b.ret.id, { action: 'approve', approvedQuantity: 1, note: 'Confirmed partial credit' }); assert.equal(br2.creditNoteRequests[0].id, br.id)
  await call(financeReview, br.id, { action: 'approve' }); s = await state(b)
  assert.equal(s.moves.length, 2); assert.equal(Number(s.product.qtyOnHand), 0); assert.equal(Number(s.line.deliveredQty), 4)
  assert.equal(Number((await prisma.invoice.findUniqueOrThrow({ where: { id: b.invoice!.id } })).totalIncTax), 49.2)
  await assert.rejects(() => prisma.$transaction(tx => createOrderReturn(tx, { orderId: b.order.id, orderLineId: b.line.id, quantity: 4 }, actor)), /可退数量/)
  checks.push('partial approval: physical receipt 2 vs credit 1; scrap net-zero stock; Finance rejection/resubmission; draft recalculated; physical quantity cannot be returned twice')

  const c = await fixture('POSTED'); const cr = await reviewed(c)
  const rollback = await call(financeReview, cr.id, { action: 'approve' }, 409); assert.match(rollback.error, /科目/)
  s = await state(c); assert.equal(s.ret.status, 'APPROVED'); assert.equal(s.notes.length, 0); assert.equal(s.moves.length, 0); assert.equal(Number(s.line.deliveredQty), 5)
  checks.push('missing accounts: CN creation rolled back with status, stock and delivery quantity unchanged')
  for (const [code, type] of [['1100','RECEIVABLE'],['4000','INCOME'],['2200','LIABILITY']] as const) await prisma.account.upsert({ where: { code }, create: { code, name: `Audit ${code}`, type }, update: {} })
  const concurrent = await Promise.all([financeReview(request({ action: 'approve' }), { params: Promise.resolve({ id: cr.id }) }), financeReview(request({ action: 'approve' }), { params: Promise.resolve({ id: cr.id }) })])
  assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 409])
  s = await state(c); assert.equal(s.notes.length, 1); assert.equal(Number(s.notes[0].totalIncTax), 24.6); assert.equal(s.moves.length, 1); assert.equal(s.notes[0].status, 'CONFIRMED')
  const journal = await prisma.journalEntry.findFirstOrThrow({ where: { sourceType: 'credit_note', sourceId: s.notes[0].id }, include: { lines: true } }); assert.equal(journal.lines.reduce((sum,l) => sum + Number(l.debit) - Number(l.credit),0), 0)
  assert.equal(Number((await prisma.invoice.findUniqueOrThrow({ where: { id: c.invoice!.id } })).totalIncTax), 61.5)
  checks.push('posted invoice on delivery day: exactly one confirmed CN + balanced journal, original invoice immutable; concurrent confirmation executes once')

  const d = await fixture('PAID'); const dr = await reviewed(d); await call(financeReview, dr.id, { action: 'approve' }); assert.equal((await state(d)).notes.length, 1)
  checks.push('paid invoice: confirmed credit retained for subsequent refund/allocation')
  const e = await fixture(); await call(warehouseVerify, e.ret.id, { action: 'reject', note: 'Not our goods' }); await assertReturnsResolved(prisma, [e.order.id]); assert.equal((await state(e)).moves.length, 0)
  checks.push('warehouse rejection: reason required, no stock/credit effects, invoice block released')
  const f = await fixture(); await call(warehouseVerify, f.ret.id, { action: 'verify', disposition: 'SELLABLE', note: 'Received' }); await call(salesReview, f.ret.id, { action: 'reject' }, 400); await call(salesReview, f.ret.id, { action: 'reject', note: 'Not eligible for refund, hold physical goods' }); await assertReturnsResolved(prisma, [f.order.id]); assert.equal((await state(f)).moves.length, 0)
  checks.push('sales rejection: reason required, no stock/credit effects, invoice block released')

  const g = await fixture(); await prisma.orderReturn.update({ where: { id: g.ret.id }, data: { status: 'REJECTED' } })
  const trip = await prisma.trip.create({ data: { driverId: user.id, vehiclePlate: '26-D-12345', driverName: actor.name, status: 'IN_PROGRESS', restaurants: [{ restaurantId: g.customer.id, restaurantName: g.customer.name, orderIds: [], items: [], returns: [] }] } })
  const sourceResponse = await driverReturns(request(null, 'GET', `/api/trips/${trip.id}/returns?restaurantId=${g.customer.id}&sourceOrderCode=${g.order.code}`), { params: Promise.resolve({ id: trip.id }) }); assert.equal(sourceResponse.status, 200)
  const reported = await driverReport(request({ restaurantId: g.customer.id, returns: [{ returnKind: 'HISTORICAL', orderId: g.order.id, orderLineId: g.line.id, productId: g.product.id, productName: g.product.name, quantity: 1, photo: 'audit-photo', reason: 'previous delivery' }] }, 'POST'), { params: Promise.resolve({ id: trip.id }) }); assert.equal(reported.status, 200, await reported.text())
  const historical = await prisma.orderReturn.findFirstOrThrow({ where: { sourceTripId: trip.id } }); assert.equal(historical.returnKind, 'HISTORICAL'); assert.equal(historical.orderLineId, g.line.id)
  checks.push('driver historical return: own trip/current customer + exact original order line; retains historical kind and collecting vehicle')

  const unknownResponse = await driverReport(request({ restaurantId: g.customer.id, returns: [{ returnKind: 'HISTORICAL', productName: 'Unidentified broccoli', spec: '6kg case', uomLabel: 'CASE', quantity: 1, photo: 'audit-photo', reason: 'Old delivery, no order number' }] }, 'POST'), { params: Promise.resolve({ id: trip.id }) })
  assert.equal(unknownResponse.status, 200)
  const intake = await prisma.returnIntake.findFirstOrThrow({ where: { sourceTripId: trip.id, status: 'OPEN' } })
  const intakeLinked = await call(intakeReview, intake.id, { action: 'link', orderId: g.order.id, orderLineId: g.line.id, quantity: 1, note: 'Matched original source and checked unit' })
  assert.equal(intakeLinked.status, 'LINKED')
  await call(intakeReview, intake.id, { action: 'link', orderId: g.order.id, orderLineId: g.line.id, quantity: 1, note: 'Repeated' }, 409)
  checks.push('unknown historical goods: intake without order number, warehouse matches exact source, no premature stock/CN, repeated matching blocked')

  const h = await fixture(); const hr = await reviewed(h)
  await prisma.$executeRawUnsafe(`CREATE FUNCTION audit_fail_return_settle() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status::text = 'SETTLED' THEN RAISE EXCEPTION 'Injected failure after stock posting'; END IF; RETURN NEW; END $$`)
  await prisma.$executeRawUnsafe(`CREATE TRIGGER audit_fail_return_settle BEFORE UPDATE ON "OrderReturn" FOR EACH ROW EXECUTE FUNCTION audit_fail_return_settle()`)
  try {
    await call(financeReview, hr.id, { action: 'approve' }, 500)
    const failed = await state(h); assert.equal(failed.moves.length,0); assert.equal(Number(failed.product.qtyOnHand),0); assert.equal(Number(failed.line.deliveredQty),5); assert.equal(failed.ret.status,'APPROVED'); assert.equal((await prisma.creditNoteRequest.findUniqueOrThrow({where:{id:hr.id}})).status,'PENDING')
  } finally { await prisma.$executeRawUnsafe('DROP TRIGGER audit_fail_return_settle ON "OrderReturn"'); await prisma.$executeRawUnsafe('DROP FUNCTION audit_fail_return_settle()') }
  await call(financeReview, hr.id, { action: 'approve' })
  checks.push('injected failure after stock/quantity updates: all stock, quantity, invoice and request changes rolled back; retry succeeds')

  const race = await fixture(); await prisma.orderReturn.update({where:{id:race.ret.id},data:{status:'REJECTED'}})
  let signal!: () => void, release!: () => void
  const locked = new Promise<void>(resolve => {signal=resolve}), unlocked = new Promise<void>(resolve => {release=resolve})
  const registration = prisma.$transaction(async tx => {
    await createOrderReturn(tx, {orderId:race.order.id,orderLineId:race.line.id,quantity:1},actor)
    signal(); await unlocked
  }, {timeout:30000})
  await locked
  const invoicing = createDraftInvoiceForOrder(prisma as unknown as InvoiceTx,race.order.id)
  const prevented = assert.rejects(() => invoicing,/退货尚未完成/)
  release(); await registration; await prevented
  checks.push('return registration versus invoice creation: common order lock makes invoicing see the committed pending return')

  const alternate = await fixture()
  const actualProduct = await prisma.product.create({data:{name:'Actually returned product',unitOfMeasure:'KG',images:[]}})
  await call(warehouseVerify, alternate.ret.id, {action:'verify',note:'Wrong product; received 5kg',disposition:'SELLABLE',acceptedQuantity:2,actualReturnedProductId:actualProduct.id,actualReturnedStockQuantity:5})
  const alternateRequest = await call(salesReview,alternate.ret.id,{action:'approve',approvedQuantity:2,note:'Approve original order refund'})
  await call(financeReview,alternateRequest.creditNoteRequests[0].id,{action:'approve'})
  assert.equal(Number((await prisma.product.findUniqueOrThrow({where:{id:alternate.product.id}})).qtyOnHand),0)
  assert.equal(Number((await prisma.product.findUniqueOrThrow({where:{id:actualProduct.id}})).qtyOnHand),5)
  checks.push('wrong item received: original order credit uses original units; physical stock uses actual product and explicitly verified base-unit quantity')

  const slot = await prisma.driverSlot.create({data:{driverName:actor.name,timeOfDay:'am',batchNum:1,userId:actor.userId}})
  const wave = await prisma.pickingWave.create({data:{driverSlotId:slot.id,driverName:actor.name,orderIds:[g.order.id],waveType:'AM'}})
  await call(updateWave,wave.id,{vehiclePlate:'26-d-12345'})
  const truckTrip = await prisma.$transaction(tx=>createTripFromWave(tx as never,wave.id))
  assert(truckTrip)
  assert.equal((await prisma.trip.findUniqueOrThrow({where:{id:truckTrip.id}})).vehiclePlate,'26-D-12345')
  await prisma.pickingWave.update({where:{id:wave.id},data:{dispatchedAt:new Date()}})
  await call(updateWave,wave.id,{vehiclePlate:'DIFFERENT'},409)
  checks.push('dispatch vehicle: plate normalized and captured with driver on the trip; dispatched plate cannot be overwritten')

  const originalToken = token
  token = await signToken({...actor, role:'WAREHOUSE',pm:encodePermissions(['dispatch.goods_return.warehouse_verify'])})
  await call(financeReview, hr.id, {action:'approve'},403)
  token = await signToken({...actor,role:'DRIVER',pm:encodePermissions(['dispatch.trip.report_return']),ds:'OWN'})
  const owned = await driverReturns(request(null,'GET',`/api/trips/${trip.id}/returns`),{params:Promise.resolve({id:trip.id})}); assert.equal(owned.status,200)
  const wrongTrip = await prisma.trip.create({data:{restaurants:[],status:'IN_PROGRESS'}})
  const denied = await driverReturns(request(null,'GET',`/api/trips/${wrongTrip.id}/returns`),{params:Promise.resolve({id:wrongTrip.id})}); assert.equal(denied.status,404)
  await call(salesReview, h.ret.id,{action:'approve'},403)
  token = originalToken
  checks.push('role separation: warehouse cannot confirm finance requests; driver can read own return sources, not another driver trip or approve returns')

  console.log(JSON.stringify({ database: '127.0.0.1:55449/return_workflow_audit', result: 'passed', checks }, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => prisma.$disconnect())
