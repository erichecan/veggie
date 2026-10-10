import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateTripSalesHtml } from '../lib/print/trip-sales-template'
import { generateTripDeliveryHtml } from '../lib/print/trip-delivery-template'
import { renderOrderHtml } from '../lib/order-pdf'
import { paymentDetails } from '../lib/print/document-header'
import type { TripPrintData } from '../lib/print/trip-common'

const data: TripPrintData = {
  trip: { id: 'trip', name: 'Morning', timeSlot: 'am', driverName: 'Driver Test', departTime: '08:00', createdAt: '2026-10-10' },
  orders: [{ id: 'order', code: 'D-261010-001', customerId: 'customer', customerName: 'Test Restaurant', totalAmount: 10, internalNote: null, externalNote: 'Gate code: 1234', deliveryNote: null, deliveryDate: '2026-10-10', invoiceNo: 'V12345', driverBatchLabel: 'Driver Test', lines: [{ productId: 'product', productName: 'Carrots', spec: null, uomId: 'unit', uomName: 'BAG', goodsType: 'BULK', note: null, orderedQty: 1, unitPrice: 10, taxRate: 0, subtotal: 10 }] }],
  customers: new Map([['customer', { id: 'customer', name: 'Test Restaurant', street: '1 Main St', street2: '', city: 'Dublin', state: '', zip: '', country: 'Ireland', phone: '01234567', vatNumber: '', paymentTerm: 'monthly', externalNote: 'Chef: <Alice> & 0891234567' }]]),
  signoffs: [],
}

for (const [name, render] of [['sales', generateTripSalesHtml], ['delivery', generateTripDeliveryHtml]] as const) {
  test(`${name}: driver is in delivery column; payment includes terms and escaped external notes`, () => {
    const html = render(data, 'en')
    const cells = html.match(/<table class="info-table">([\s\S]*?)<\/table>/)?.[1].match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []
    assert.equal(cells.length, 4)
    assert.doesNotMatch(cells[0]!, /Driver Test/)
    assert.match(cells[2]!, /Driver Test/)
    assert.match(cells[3]!, /Monthly/)
    assert.match(cells[3]!, /Chef: &lt;Alice&gt; &amp; 0891234567/)
    assert.match(cells[3]!, /Gate code: 1234/)
    assert.match(cells[1], /D-261010-001/)
    assert.doesNotMatch(cells[1], /V12345/)
    assert.doesNotMatch(html, /PAYMENT:/)
  })
}

test('email/PDF order template uses same driver and payment layout', () => {
  const html = renderOrderHtml({ id: 'o', code: 'D-261010-001', restaurantName: 'Test', externalNote: 'Gate 1234', lines: [] }, { paymentTerm: 'monthly', externalNote: 'Chef 089123' }, 'Driver Test')
  const cells = html.match(/<table class="info-table">([\s\S]*?)<\/table>/)?.[1].match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []
  assert.doesNotMatch(cells[0]!, /Driver Test/)
  assert.match(cells[2]!, /Driver Test/)
  assert.match(cells[3]!, /Monthly[\s\S]*Chef 089123[\s\S]*Gate 1234/)
})

test('payment notes retain newlines, deduplicate and escape HTML', () => {
  const html = paymentDetails('monthly', ['Chef\nGate <1234>', 'Chef\nGate <1234>'], 'en')
  assert.equal((html.match(/Gate/g) ?? []).length, 1)
  assert.match(html, /Chef\nGate &lt;1234&gt;/)
})
