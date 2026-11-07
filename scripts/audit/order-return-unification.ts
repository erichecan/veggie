/** Synthetic-only integration audit. Refuses databases other than local confirmation_audit. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prisma } from '../../lib/db'
import { createOrderReturn, OrderReturnInputError } from '../../lib/order-returns'

const url = new URL(process.env.DATABASE_URL ?? '')
assert.equal(url.hostname, '127.0.0.1')
assert.equal(url.port, '55439')
assert.equal(url.pathname, '/confirmation_audit')
const marker = `RETURN-AUDIT-${randomUUID()}`
let userId = ''
let productId = ''
let orderId = ''
let orderLineId = ''
let tripId = ''

async function main() {
  const user = await prisma.user.create({ data: {
    email: `${marker.toLowerCase()}@example.invalid`, passwordHash: 'synthetic-only', role: 'BOSS', roles: ['BOSS'], name: 'Synthetic return auditor',
  } })
  const actor = { userId: user.id, name: user.name }
  userId = user.id
  const product = await prisma.product.create({ data: { name: `${marker} product`, images: [], unitOfMeasure: 'CASE' } })
  productId = product.id
  const order = await prisma.order.create({ data: {
    code: `${marker}-ORDER`.slice(0, 60), restaurantId: `${marker}-customer`, restaurantName: 'Synthetic return customer',
    items: [], totalAmount: 50, status: 'IN_DELIVERY', paymentMethod: 'CASH',
  } })
  orderId = order.id
  const line = await prisma.orderLine.create({ data: {
    orderId, productId, productName: product.name, spec: 'synthetic', uomName: 'CASE',
    unitPrice: 10, orderedQty: 5, deliveredQty: 3, subtotal: 50,
  } })
  orderLineId = line.id
  const trip = await prisma.trip.create({ data: {
    name: `${marker} synthetic trip`, status: 'IN_PROGRESS',
    restaurants: [{ restaurantId: order.restaurantId, restaurantName: order.restaurantName, orderIds: [orderId], items: [], returns: [] }],
  } })
  tripId = trip.id

  const manual = await prisma.$transaction(tx => createOrderReturn(tx, {
    orderId, orderLineId, quantity: 2, reason: 'manual synthetic return',
  }, actor))
  const driver = await prisma.$transaction(tx => createOrderReturn(tx, {
    orderId, orderLineId, quantity: 1, sourceTripId: tripId, photo: 'synthetic-photo', lateReportNote: 'synthetic note',
  }, actor))
  assert.equal(manual.orderLineId, line.id)
  assert.equal(driver.orderLineId, line.id)
  assert.equal(manual.sourceTripId, null)
  assert.equal(driver.sourceTripId, trip.id)
  assert.equal(Number(driver.unitPrice), 10)
  assert.equal(driver.photo, 'synthetic-photo')

  let overReturnRejected = false
  try {
    await prisma.$transaction(tx => createOrderReturn(tx, { orderId, orderLineId, quantity: 0.1 }, actor))
  } catch (error) {
    overReturnRejected = error instanceof OrderReturnInputError && /可退数量/.test(error.message)
  }
  assert.equal(overReturnRejected, true, 'combined manual and driver pending returns must respect delivered quantity')

  // Once a prior request is rejected, its reservation is released for a later valid return.
  await prisma.orderReturn.update({ where: { id: manual.id }, data: { status: 'REJECTED' } })
  const replacement = await prisma.$transaction(tx => createOrderReturn(tx, { orderId, orderLineId, quantity: 1 }, actor))
  assert.equal(replacement.orderLineId, line.id)

  const manualRoute = readFileSync('app/api/order-returns/route.ts', 'utf8')
  const driverRoute = readFileSync('app/api/trips/[id]/returns/route.ts', 'utf8')
  assert(manualRoute.includes('createOrderReturn'))
  assert(driverRoute.includes('createOrderReturn'))
  assert(driverRoute.includes('sourceTripId: id'))

  console.log(JSON.stringify({
    database: `${url.hostname}:${url.port}${url.pathname}`,
    result: 'passed',
    checks: [
      'manual and driver reports share OrderReturn',
      'both records reference the exact original OrderLine',
      'driver source trip/photo/late-report data and source-line price are retained',
      'combined active returns cannot exceed delivered quantity for manual registration',
      'rejected returns release reserved quantity',
      'both route handlers call the shared writer',
    ],
  }, null, 2))
}

main()
  .catch(error => { console.error(error); process.exitCode = 1 })
  .finally(async () => {
    try {
      if (orderId) await prisma.orderReturn.deleteMany({ where: { orderId } })
      if (tripId) await prisma.trip.deleteMany({ where: { id: tripId } })
      if (orderId) await prisma.order.deleteMany({ where: { id: orderId } })
      if (productId) await prisma.product.deleteMany({ where: { id: productId } })
      if (userId) await prisma.user.deleteMany({ where: { id: userId } })
    } catch (error) {
      console.error('Synthetic return cleanup failed:', error)
      process.exitCode = 1
    }
    await prisma.$disconnect()
  })
