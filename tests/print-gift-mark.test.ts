/**
 * 赠品行在打印单据上的标识（20260918）
 * ============================================================================
 * 客户实测截图：勾了 Gift 的 `Fresh Green Jujube 500g PKT` 在发票上印成
 * 「€0.00 / 0% / €0.00」，跟一个刚好免费的普通商品完全分不出来 —— `OrderLine.isGift`
 * 从 20260913 上线起就没有任何打印模板读过它。
 *
 * 客户拍板的形式是价格/金额列印 GIFT 代替 €0.00；没有价格列的单据（送货单、拣货单）
 * 退化成商品名后的徽标。这里把每张单据的呈现锁住，避免日后某张单据被改回 €0.00。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { generateTripPickingHtml } from '../lib/print/trip-picking-template'
import { generateTripDeliveryHtml } from '../lib/print/trip-delivery-template'
import { generateTripSalesHtml } from '../lib/print/trip-sales-template'
import { renderOrderHtml } from '../lib/order-pdf'
import type { TripPrintData, TripCustomer, TripOrder, TripLine } from '../lib/print/trip-common'
import { buildOrderDetailRows, orderDetailHeaders } from '../lib/export/order-export-rows'

function customer(id: string, name: string): TripCustomer {
  return {
    id, name, street: '8 Moyclare road', street2: 'Baldoyle', city: 'Dublin',
    state: '', zip: 'D13', country: 'Ireland', phone: '0851234567',
    vatNumber: 'IE123', paymentTerm: 'weekly', externalNote: null,
  }
}

function line(opts: { qty: number; isGift: boolean }): TripLine {
  return {
    productId: 'p1', productName: 'Fresh Green Jujube 500g PKT', spec: null,
    uomId: 'u1', uomName: 'PKT', goodsType: 'BULK', expandByCustomer: false,
    note: null,
    orderedQty: opts.qty,
    unitPrice: opts.isGift ? 0 : 5,
    taxRate: 0,
    subtotal: opts.isGift ? 0 : opts.qty * 5,
    isGift: opts.isGift,
  }
}

function data(specs: Array<{ customer: string; qty: number; isGift: boolean }>): TripPrintData {
  const customers = new Map<string, TripCustomer>()
  const orders: TripOrder[] = specs.map((s, i) => {
    const cid = `c${i}`
    customers.set(cid, customer(cid, s.customer))
    const l = line({ qty: s.qty, isGift: s.isGift })
    return {
      id: `o${i}`, code: `OP-260918-00${i}`, customerId: cid, customerName: s.customer,
      totalAmount: l.subtotal, internalNote: null, externalNote: null, deliveryNote: null,
      deliveryDate: '2026-09-18', invoiceNo: null, driverBatchLabel: null,
      lines: [l],
    }
  })
  return {
    trip: {
      id: 't1', name: '1 am BAO', timeSlot: 'am', driverName: 'BAO',
      departTime: '01:00', createdAt: '2026-09-18T01:00:00.000Z',
    },
    orders,
    customers,
    signoffs: specs.map((s, i) => ({
      restaurantId: `c${i}`, restaurantName: s.customer, orderIds: [`o${i}`],
      delivered: true, payment: null, signature: null, signerName: null, signedAt: null,
    })),
  }
}

describe('有价格列的单据：金额列印 GIFT，不印 €0.00', () => {
  test('销售单：PRICE 与 INCL VAT 两列都是 GIFT', () => {
    const html = generateTripSalesHtml(data([{ customer: 'Old Garden', qty: 5, isGift: true }]))
    const priceCells = html.match(/<td class="col-(price|incl)">([\s\S]*?)<\/td>/g) ?? []
    assert.equal(priceCells.length, 2, '一行商品应当只有单价与含税两个金额单元格')
    for (const cell of priceCells) assert.match(cell, /GIFT/)
  })

  
  test('发票 / 销售单 PDF（邮件附件同一份模板）：单价与含税列印 GIFT', () => {
    const html = renderOrderHtml(
      {
        id: 'o1', code: 'XW-260918-001', restaurantName: '818 Cake Studio D13',
        quotationDate: '2026-09-18', deliveryDate: '2026-09-18',
        lines: [
          { productName: 'Dragon Fruit Red CASE', orderedQty: 1, unitPrice: 36.5, subtotal: 36.5, taxRate: 0, uomName: 'CASE' },
          { productName: 'Fresh Green Jujube 500g PKT', orderedQty: 5, unitPrice: 0, subtotal: 0, taxRate: 0, uomName: 'PKT', isGift: true },
        ],
      },
      null,
      '1 am BAO',
    )
    assert.equal((html.match(/GIFT/g) ?? []).length, 2, '赠品行的单价与含税两格各印一次')
    assert.match(html, /€36\.50/, '非赠品行照常印金额')
  })

  test('非赠品行不受影响：照常印金额，不出现 GIFT', () => {
    const html = generateTripSalesHtml(data([{ customer: 'Old Garden', qty: 5, isGift: false }]))
    assert.ok(!html.includes('GIFT'))
    assert.match(html, /25\.00/)
  })
})

describe('没有价格列的单据：商品名后挂 GIFT 徽标', () => {
  test('送货单', () => {
    const html = generateTripDeliveryHtml(data([{ customer: 'Old Garden', qty: 5, isGift: true }]))
    assert.match(html, /Fresh Green Jujube 500g PKT<span[^>]*>GIFT<\/span>/)
  })

  test('拣货单：整车这个商品全是赠品时只印 GIFT，不带数量', () => {
    const html = generateTripPickingHtml(data([{ customer: 'Old Garden', qty: 5, isGift: true }]))
    assert.match(html, />GIFT</)
    assert.ok(!html.includes('GIFT ×'), '全量赠品不该画蛇添足印出数量')
  })

  test('⛔ 拣货单：同商品一部分是赠品时必须带数量 —— 只印 GIFT 会被读成整堆都免费', () => {
    const html = generateTripPickingHtml(data([
      { customer: 'Old Garden', qty: 8, isGift: false },
      { customer: 'Golden Kitchen', qty: 2, isGift: true },
    ]))
    assert.match(html, /GIFT ×2/)
  })

  test('拣货单：整车都不是赠品时一个 GIFT 字样都不印', () => {
    const html = generateTripPickingHtml(data([{ customer: 'Old Garden', qty: 5, isGift: false }]))
    assert.ok(!html.includes('GIFT'))
  })
})

describe('CSV 导出：赠品是独立一列，金额列保持数值', () => {
  const order = {
    id: 'o1', code: 'OP-260918-001', restaurantId: 'c1', restaurantName: 'Golden Kitchen',
    deliveryDate: '2026-09-18', status: 'CONFIRMED', items: [], totalAmount: 36.5,
    lines: [
      { id: 'l1', orderId: 'o1', productId: 'p1', productName: 'Dragon Fruit Red CASE', unitPrice: 36.5, orderedQty: 1, deliveredQty: 0, invoicedQty: 0, subtotal: 36.5, taxRate: 0, sequence: 0, createdAt: '', updatedAt: '' },
      { id: 'l2', orderId: 'o1', productId: 'p2', productName: 'Fresh Green Jujube 500g PKT', unitPrice: 0, orderedQty: 5, deliveredQty: 0, invoicedQty: 0, subtotal: 0, taxRate: 0, sequence: 1, createdAt: '', updatedAt: '', isGift: true },
    ],
  }

  test('中文表头多出「赠品」列，赠品行标「是」，普通行留空', () => {
    const headers = orderDetailHeaders('zh')
    const rows = buildOrderDetailRows([order as never])
    const giftIdx = headers.indexOf('赠品')
    assert.notEqual(giftIdx, -1, '必须有赠品列')
    assert.equal(rows[0][giftIdx], '')
    assert.equal(rows[1][giftIdx], '是')
    assert.equal(rows.every(r => r.length === headers.length), true, '每行列数必须与表头一致')
  })

  test('英文导出用 Y', () => {
    const headers = orderDetailHeaders('en')
    const rows = buildOrderDetailRows([order as never], 'en')
    assert.equal(rows[1][headers.indexOf('Gift')], 'Y')
  })

  test('⛔ 金额列仍是数值字符串，不能写成 GIFT —— 会计的 Excel 求和要靠它', () => {
    const headers = orderDetailHeaders('zh')
    const rows = buildOrderDetailRows([order as never])
    assert.equal(rows[1][headers.indexOf('金额')], '0.00')
    assert.equal(rows[1][headers.indexOf('单价')], '0.00')
  })
})
