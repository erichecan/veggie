/**
 * 客户签收单模板。合同第四条把它列进打印中心必须支持的单据，
 * 审计实测这是 6 类单据里唯一缺的一类。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateTripReceiptHtml } from '../lib/print/trip-receipt-template'
import type { TripPrintData, TripCustomer, TripOrder, TripSignoff } from '../lib/print/trip-common'

const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const customer: TripCustomer = {
  id: 'c1', name: '张记餐厅', street: '8 Moyclare road', street2: 'Baldoyle',
  city: 'Dublin', state: '', zip: 'D13', country: 'Ireland',
  phone: '0851234567', vatNumber: 'IE123', paymentTerm: 'weekly', externalNote: null,
}

const order: TripOrder = {
  id: 'o1', code: 'ZJ-260802-001', customerId: 'c1', customerName: '张记餐厅',
  totalAmount: 120, internalNote: null, externalNote: null, deliveryNote: null,
  deliveryDate: '2026-08-02', invoiceNo: null, driverBatchLabel: null,
  lines: [{
    productId: 'p1', productName: '有机西兰花', spec: '5kg/箱', uomId: 'u1', uomName: '箱',
    goodsType: 'BULK', note: null, orderedQty: 3, unitPrice: 40, taxRate: 0, subtotal: 120,
  }],
}

function data(signoffs: TripSignoff[]): TripPrintData {
  return {
    trip: {
      id: 't1', name: '上午 · 王师傅', timeSlot: 'am', driverName: '王师傅',
      departTime: '08:00', createdAt: '2026-08-02T06:00:00.000Z',
    },
    orders: [order],
    customers: new Map([['c1', customer]]),
    signoffs,
  }
}

const signed: TripSignoff = {
  restaurantId: 'c1', restaurantName: '张记餐厅', orderIds: ['o1'], delivered: true,
  payment: 120, signature: SIG, signerName: '陈经理', signedAt: '2026-08-02T10:30:00.000Z',
}

const unsigned: TripSignoff = {
  restaurantId: 'c2', restaurantName: '李家小馆', orderIds: [], delivered: false,
  payment: null, signature: null, signerName: null, signedAt: null,
}

test('已签收：印出签名图、签收人、签收时间', () => {
  const html = generateTripReceiptHtml(data([signed]))
  assert.ok(html.includes(SIG), '签名图必须嵌进去')
  assert.match(html, /陈经理/)
  assert.match(html, /签收时间/)
  assert.match(html, /客户签收单/)
  assert.match(html, /PROOF OF DELIVERY/)
})

test('未签收：留空白签名栏供纸质补签，不是直接漏掉这一站', () => {
  const html = generateTripReceiptHtml(data([unsigned]))
  assert.match(html, /未电子签收，请客户在此手签/)
  assert.ok(!html.includes(SIG))
})

test('一站一页', () => {
  const html = generateTripReceiptHtml(data([signed, unsigned]))
  assert.equal((html.match(/class="page"/g) ?? []).length, 2)
})

test('印出商品明细、金额与实收货款', () => {
  const html = generateTripReceiptHtml(data([signed]))
  assert.match(html, /有机西兰花/)
  assert.match(html, /5kg\/箱/)
  assert.match(html, /€120\.00/)
})

test('客户地址取自 Customer，不是硬编码', () => {
  const html = generateTripReceiptHtml(data([signed]))
  assert.match(html, /Moyclare road/)
  assert.match(html, /Dublin/)
})

test('没有 signoffs（老行程数据）时按订单客户兜底，不至于打不出来', () => {
  const d = data([])
  d.signoffs = undefined
  const html = generateTripReceiptHtml(d)
  assert.match(html, /张记餐厅/)
  assert.match(html, /未电子签收/)
  assert.equal((html.match(/class="page"/g) ?? []).length, 1)
})

test('完全没有站点时给出说明而不是空白页', () => {
  const d = data([])
  d.orders = []
  const html = generateTripReceiptHtml(d)
  assert.match(html, /本行程无可打印的签收记录/)
})

test('客户名里的尖括号被转义，不会破坏 HTML', () => {
  const html = generateTripReceiptHtml(data([{ ...signed, restaurantName: '<script>alert(1)</script>' }]))
  assert.ok(!html.includes('<script>alert(1)</script>'), '必须转义')
  assert.match(html, /&lt;script&gt;/)
})
