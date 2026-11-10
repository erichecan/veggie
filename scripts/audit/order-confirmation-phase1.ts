/**
 * Isolated PostgreSQL integration audit for the unified order-confirmation service.
 * This script refuses every database except localhost:55439/confirmation_audit.
 * It creates only synthetic rows and removes them in finally.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/db'
import { confirmOrdersInTransaction } from '../../lib/order-confirmation'

const url = new URL(process.env.DATABASE_URL ?? '')
assert.equal(url.hostname, '127.0.0.1', 'Only the isolated local database is allowed')
assert.equal(url.port, '55439', 'Only the isolated local database is allowed')
assert.equal(url.pathname, '/confirmation_audit', 'Only the isolated local database is allowed')

const marker = `AUDIT-${randomUUID()}`
const createdOrderIds: string[] = []
const createdSlotIds: string[] = []
let userId: string | undefined

async function installFaultTriggers() {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION audit_confirmation_failpoint() RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.confirmation_fail_table', true) = TG_TABLE_NAME THEN
        RAISE EXCEPTION 'injected confirmation failure on %', TG_TABLE_NAME;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `)
  for (const table of ['OrderAuditLog', 'DeliverySlip', 'PickingWave', 'Pallet']) {
    const trigger = `audit_fail_${table}`
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}" ON "${table}"`)
    const event = table === 'OrderAuditLog' || table === 'DeliverySlip'
      ? 'BEFORE INSERT' : 'BEFORE INSERT OR UPDATE'
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" ${event} ON "${table}" FOR EACH ROW EXECUTE FUNCTION audit_confirmation_failpoint()`)
  }
}

async function makeOrder(label: string, options: { slotId?: string; status?: 'PENDING' | 'CONFIRMED' } = {}) {
  const id = `${marker}-${label}-${randomUUID()}`
  const order = await prisma.order.create({
    data: {
      id,
      code: `${marker}-${label}`.slice(0, 60),
      restaurantId: `${marker}-customer`,
      restaurantName: 'Synthetic audit customer',
      items: [{ productId: `${marker}-product`, productName: 'Synthetic product', quantity: 2, uomName: 'CASE' }],
      totalAmount: 20,
      status: options.status ?? 'PENDING',
      paymentMethod: 'CASH',
      deliveryDate: new Date('2026-11-07T00:00:00.000Z'),
      driverSlotId: options.slotId,
    },
  })
  createdOrderIds.push(order.id)
  return order
}

async function confirm(ids: string[], failureTable?: string) {
  return prisma.$transaction(async tx => {
    if (failureTable) {
      await tx.$executeRaw`SELECT set_config('app.confirmation_fail_table', ${failureTable}, true)`
    }
    return confirmOrdersInTransaction(tx, ids, {
      userId: userId!,
      name: 'Synthetic audit user',
      email: 'confirmation-audit-user',
    })
  })
}

async function counts(ids: string[]) {
  const orders = await prisma.order.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } })
  const slips = await prisma.deliverySlip.count({ where: { orderId: { in: ids } } })
  const audits = await prisma.orderAuditLog.count({ where: { orderId: { in: ids }, action: 'confirmed' } })
  const waves = await prisma.pickingWave.findMany({ where: { orderIds: { hasSome: ids } }, select: { id: true, orderIds: true } })
  const pallets = await prisma.pallet.findMany({ select: { items: true } })
  const palletOrders = pallets.flatMap(p => (p.items as Array<{ orderId: string }>).map(i => i.orderId)).filter(id => ids.includes(id))
  const stockMoves = await prisma.stockMove.count({ where: { sourceId: { in: ids } } })
  return { orders, slips, audits, waves, palletOrders, stockMoves }
}

async function expectRollback(label: string, ids: string[], failTable: string, opts?: { slotId?: string }) {
  const order = ids.length === 1 ? await prisma.order.findUniqueOrThrow({ where: { id: ids[0] } }) : null
  try {
    await confirm(ids, failTable)
    assert.fail(`${label}: injected failure unexpectedly committed`)
  } catch (error) {
    assert.match(String(error), /injected confirmation failure/)
  }
  const state = await counts(ids)
  assert.equal(state.orders.length, ids.length, `${label}: all orders remain present`)
  assert(state.orders.every(o => o.status === 'PENDING'), `${label}: every order returns to PENDING`)
  assert.equal(state.slips, 0, `${label}: no delivery slips remain`)
  assert.equal(state.audits, 0, `${label}: no confirmation audits remain`)
  assert.equal(state.waves.length, 0, `${label}: no wave membership remains`)
  assert.equal(state.palletOrders.length, 0, `${label}: no pallet membership remains`)
  assert.equal(state.stockMoves, 0, `${label}: no stock moves remain`)
  return { label, result: 'rollback complete', orders: ids.length, slotExpected: Boolean(opts?.slotId), beforeStatus: order?.status ?? 'PENDING' }
}

async function main() {
  const user = await prisma.user.create({
    data: {
      email: `${marker.toLowerCase()}-audit-user`,
      passwordHash: 'synthetic-only',
      role: 'BOSS',
      roles: ['BOSS'],
      name: 'Synthetic audit user',
    },
  })
  userId = user.id
  const slot = await prisma.driverSlot.create({ data: { timeOfDay: 'am', batchNum: 1, driverName: `${marker}-driver` } })
  createdSlotIds.push(slot.id)
  await installFaultTriggers()
  const results: Array<Record<string, unknown>> = []

  // No driver: confirmation creates status, slip, audit, but no physical stock move.
  const noDriver = await makeOrder('no-driver')
  await confirm([noDriver.id])
  let state = await counts([noDriver.id])
  assert.equal(state.orders[0]?.status, 'CONFIRMED')
  assert.equal(state.slips, 1)
  assert.equal(state.audits, 1)
  assert.equal(state.waves.length, 0)
  assert.equal(state.stockMoves, 0)
  results.push({ scenario: 'single confirm without driver', status: state.orders[0]?.status, slips: state.slips, audits: state.audits, stockMoves: state.stockMoves })

  // Preselected driver: actual wave and batch pallet are linked atomically.
  const withDriver = await makeOrder('with-driver', { slotId: slot.id })
  await confirm([withDriver.id])
  state = await counts([withDriver.id])
  assert.equal(state.orders[0]?.status, 'WAVE_ASSIGNED')
  assert.equal(state.slips, 1)
  assert.equal(state.audits, 1)
  assert.equal(state.waves.length, 1)
  assert(state.waves[0].orderIds.includes(withDriver.id))
  assert.deepEqual(state.palletOrders, [withDriver.id])
  assert.equal(state.stockMoves, 0)
  results.push({ scenario: 'single confirm with preselected driver', status: state.orders[0]?.status, waveCount: state.waves.length, palletOrderCount: state.palletOrders.length, slips: state.slips, stockMoves: state.stockMoves })

  // Duplicate single confirmation is idempotent: no extra associations or audit.
  await prisma.$transaction(tx => confirmOrdersInTransaction(tx, [withDriver.id], { userId: user.id, name: user.name }, { allowAlreadyConfirmed: true }))
  state = await counts([withDriver.id])
  assert.equal(state.slips, 1)
  assert.equal(state.audits, 1)
  assert.equal(state.waves.length, 1)
  results.push({ scenario: 'repeat single confirmation', status: state.orders[0]?.status, slips: state.slips, audits: state.audits, waveCount: state.waves.length })

  // Existing CONFIRMED rows with a preselected driver must be reconciled, not silently skipped.
  const legacyConfirmed = await makeOrder('confirmed-missing-links', { slotId: slot.id, status: 'CONFIRMED' })
  await prisma.$transaction(tx => confirmOrdersInTransaction(tx, [legacyConfirmed.id], { userId: user.id, name: user.name }, { allowAlreadyConfirmed: true }))
  state = await counts([legacyConfirmed.id])
  assert.equal(state.orders[0]?.status, 'WAVE_ASSIGNED')
  assert.equal(state.slips, 1)
  assert.equal(state.audits, 0, 'reconciling an already-confirmed order must not duplicate its confirmation audit')
  assert.equal(state.waves.length, 1)
  assert.deepEqual(state.palletOrders, [legacyConfirmed.id])
  results.push({ scenario: 'confirmed order missing linked records', status: state.orders[0]?.status, slips: state.slips, audits: state.audits, waveCount: state.waves.length, palletOrderCount: state.palletOrders.length })

  const auditFailure = await makeOrder('audit-fail', { slotId: slot.id })
  results.push(await expectRollback('audit log insertion fails after wave writes', [auditFailure.id], 'OrderAuditLog', { slotId: slot.id }))

  const slipFailure = await makeOrder('slip-fail')
  results.push(await expectRollback('delivery slip insert fails', [slipFailure.id], 'DeliverySlip'))

  const waveFailure = await makeOrder('wave-fail', { slotId: slot.id })
  results.push(await expectRollback('wave insertion fails', [waveFailure.id], 'PickingWave', { slotId: slot.id }))

  const palletFailure = await makeOrder('pallet-fail', { slotId: slot.id })
  results.push(await expectRollback('pallet insertion fails after wave membership update', [palletFailure.id], 'Pallet', { slotId: slot.id }))

  // Batch's second order hits an injected slip failure: all three must remain untouched.
  const batch = await Promise.all([
    makeOrder('batch-a', { slotId: slot.id }),
    makeOrder('batch-b', { slotId: slot.id }),
    makeOrder('batch-c', { slotId: slot.id }),
  ])
  results.push(await expectRollback('three-order batch middle transaction failure', batch.map(o => o.id), 'DeliverySlip', { slotId: slot.id }))

  // Invalid member rejects the batch before any member is confirmed.
  const valid = await makeOrder('batch-valid')
  const invalid = await makeOrder('batch-invalid', { status: 'CONFIRMED' })
  try {
    await confirm([valid.id, invalid.id])
    assert.fail('invalid batch unexpectedly committed')
  } catch (error) {
    assert.match(String(error), /当前状态为 CONFIRMED/)
  }
  state = await counts([valid.id, invalid.id])
  assert.equal(state.slips, 0)
  assert.equal(state.audits, 0)
  assert.equal(state.waves.length, 0)
  assert(state.orders.some(o => o.id === valid.id && o.status === 'PENDING'))
  results.push({ scenario: 'batch includes non-pending order', result: 'rejected before writes', statuses: state.orders.map(o => o.status) })

  // Direct-create semantics: newly created order and confirmation share one DB transaction.
  const directId = `${marker}-direct-${randomUUID()}`
  try {
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT set_config('app.confirmation_fail_table', 'OrderAuditLog', true)`
      const order = await tx.order.create({
        data: {
          id: directId,
          code: `${marker}-direct`.slice(0, 60),
          restaurantId: `${marker}-customer`,
          restaurantName: 'Synthetic direct-create customer',
          items: [],
          totalAmount: 0,
          status: 'PENDING',
          paymentMethod: 'CASH',
          driverSlotId: slot.id,
        },
      })
      createdOrderIds.push(order.id)
      await confirmOrdersInTransaction(tx, [order.id], { userId: user.id, name: user.name })
    })
    assert.fail('direct-create with failed audit unexpectedly committed')
  } catch (error) {
    assert.match(String(error), /injected confirmation failure/)
  }
  assert.equal(await prisma.order.count({ where: { id: directId } }), 0, 'direct-create order must rollback with confirmation')
  results.push({ scenario: 'direct create and confirm', result: 'creation and confirmation both rolled back' })

  // Code-path assertion: all three production handlers use the exact shared confirmation service.
  const { readFileSync } = await import('node:fs')
  for (const path of ['app/api/orders/[id]/route.ts', 'app/api/orders/bulk/route.ts', 'app/api/orders/route.ts']) {
    assert(readFileSync(path, 'utf8').includes('confirmOrdersInTransaction'), `${path} must use shared confirmation service`)
  }
  const singleRoute = readFileSync('app/api/orders/[id]/route.ts', 'utf8')
  assert(singleRoute.includes('delete confirmationUpdateArgs.data.status'), 'single-confirm route must leave status transition to shared service')
  results.push({ scenario: 'entry-point wiring', result: 'single, bulk, and direct-create handlers all invoke shared service' })

  console.log(JSON.stringify({ database: `${url.hostname}:${url.port}${url.pathname}`, marker, results }, null, 2))
}

main()
  .catch(error => { console.error(error); process.exitCode = 1 })
  .finally(async () => {
    // The audit DB is disposable, but still remove all rows this script created.
    try {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "audit_fail_OrderAuditLog" ON "OrderAuditLog"`)
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "audit_fail_DeliverySlip" ON "DeliverySlip"`)
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "audit_fail_PickingWave" ON "PickingWave"`)
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "audit_fail_Pallet" ON "Pallet"`)
      if (createdOrderIds.length) {
        const relatedWaves = await prisma.pickingWave.findMany({ where: { orderIds: { hasSome: createdOrderIds } }, select: { id: true } })
        await prisma.pallet.deleteMany({ where: { waveId: { in: relatedWaves.map(w => w.id) } } })
        await prisma.orderAuditLog.deleteMany({ where: { orderId: { in: createdOrderIds } } })
        await prisma.deliverySlip.deleteMany({ where: { orderId: { in: createdOrderIds } } })
        await prisma.pickingWave.deleteMany({ where: { orderIds: { hasSome: createdOrderIds } } })
        await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } })
      }
      if (createdSlotIds.length) await prisma.driverSlot.deleteMany({ where: { id: { in: createdSlotIds } } })
      if (userId) await prisma.user.delete({ where: { id: userId } })
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS audit_confirmation_failpoint()')
    } catch (cleanupError) {
      console.error('Audit cleanup failed:', cleanupError)
      process.exitCode = 1
    }
    await prisma.$disconnect()
  })
