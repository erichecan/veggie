/**
 * 拣货单「按客户展开」规则（20260916）
 * ============================================================================
 * 两条不变量，都是从生产实测事故反推出来的：
 *
 * 1. 展开与否只看 `Uom.expandByCustomer`，**不再看 goodsType**。
 *    此前是 `goodsType === 'LOOSE'` 恒全展开，用分表字段兼任展开判断；生产实测
 *    散货表里 86% 的行是 PACK/PKT/PACKET/TRAY 这类定量包装，留在散货表是对的
 *    （分表＝哪个组在哪个区域拣），但整包拿、不该逐客户列。
 *
 * 2. 只要展开了，**纸面上的账必须平**：主行总量 = 各客户明细行之和。
 *    实测截图：FX Udon Noodle 总量 41，只列出 7 + 2 = 9，剩下 32 箱没有任何一行
 *    交代 —— 拣货员没法判断是漏印了还是自己看错了。这就是「其余 N 家」汇总行存在的理由。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateTripPickingHtml } from '../lib/print/trip-picking-template'
import type { TripPrintData, TripCustomer, TripOrder, TripLine, GoodsType } from '../lib/print/trip-common'

interface LineSpec {
  customer: string
  qty: number
  note?: string | null
}

function buildData(opts: {
  goodsType: GoodsType
  expandByCustomer: boolean
  lines: LineSpec[]
}): TripPrintData {
  const customers = new Map<string, TripCustomer>()
  const orders: TripOrder[] = opts.lines.map((l, i) => {
    const cid = `c${i}`
    customers.set(cid, {
      id: cid, name: l.customer, street: '', street2: '', city: 'Dublin',
      state: '', zip: '', country: 'Ireland', phone: '', vatNumber: '',
      paymentTerm: 'weekly', externalNote: null,
    })
    const line: TripLine = {
      productId: 'p1', productName: 'FX Udon Noodle 30\'s*200g CASE', spec: null,
      uomId: 'u1', uomName: 'CASE',
      goodsType: opts.goodsType,
      expandByCustomer: opts.expandByCustomer,
      note: l.note ?? null,
      orderedQty: l.qty, unitPrice: 10, taxRate: 0, subtotal: l.qty * 10,
    }
    return {
      id: `o${i}`, code: `OP-2609-00${i}`, customerId: cid, customerName: l.customer,
      totalAmount: l.qty * 10, internalNote: null, externalNote: null, deliveryNote: null,
      deliveryDate: '2026-09-16', invoiceNo: null, driverBatchLabel: null,
      lines: [line],
    }
  })
  return {
    trip: {
      id: 't1', name: '1 am BAO', timeSlot: 'am', driverName: 'BAO',
      departTime: '01:00', createdAt: '2026-09-16T01:00:00.000Z',
    },
    orders,
    customers,
    signoffs: [],
  }
}

/** 数出明细子行（↳ 开头的客户行），用来判断展开了几行 */
function countBreakdownRows(html: string): number {
  return (html.match(/class="row-bd/g) ?? []).length
}

/**
 * 有没有「其余 N 家」汇总行。必须匹配**行标记本身**（class 属性的完整前缀），
 * 不能只找片段 —— 页面里同一串字出现在两个和数据无关的地方：
 *   · 样式表注释写着「其余 N 家」→ html.includes('其余') 恒为真
 *   · CSS 选择器 tr.row-bd-rest{...} → html.includes('row-bd-rest') 也恒为真
 * 这两版断言都自我通过过，是测试本身在骗人，不是被测代码有问题。
 */
function hasRestRow(html: string): boolean {
  return html.includes('class="row-bd row-bd-rest')
}

// ── 1. 配了展开的单位：全部客户逐行列出 ────────────────────────────────────────
test('expandByCustomer=true 时按客户全展开', () => {
  const html = generateTripPickingHtml(buildData({
    goodsType: 'LOOSE',
    expandByCustomer: true,
    lines: [
      { customer: '818 Cake Studio D13', qty: 2.5 },
      { customer: 'ABC Restaurant Ltd', qty: 6.2 },
    ],
  }))
  assert.equal(countBreakdownRows(html), 2)
  assert.ok(html.includes('818 Cake Studio D13'))
  assert.ok(html.includes('ABC Restaurant Ltd'))
  // 现切现称的货，每家的数量必须印出来
  assert.ok(html.includes('2.5'))
  assert.ok(html.includes('6.2'))
})

// ── 2. 核心回归：散货表里没配展开的单位不再强制展开 ──────────────────────────────
test('goodsType=LOOSE 但 expandByCustomer=false 时不展开（旧耦合已解除）', () => {
  const html = generateTripPickingHtml(buildData({
    goodsType: 'LOOSE',
    expandByCustomer: false,
    lines: [
      { customer: '818 Cake Studio D13', qty: 5 },
      { customer: 'ABC Restaurant Ltd', qty: 15 },
    ],
  }))
  assert.equal(countBreakdownRows(html), 0, '定量包装不该逐客户展开')
  assert.ok(!html.includes('818 Cake Studio D13'))
  // 总量仍然要在
  assert.ok(html.includes('20'))
})

// ── 3. 有备注：只列带备注的客户 + 其余汇总行，且账要平 ──────────────────────────
test('部分客户有备注时补「其余 N 家」汇总行，主行总量 = 各明细行之和', () => {
  const html = generateTripPickingHtml(buildData({
    goodsType: 'BULK',
    expandByCustomer: false,
    lines: [
      { customer: '818 Cake Studio D13', qty: 7, note: 'DS' },
      { customer: 'AE D5', qty: 2, note: 'ds' },
      { customer: 'Customer C', qty: 12 },
      { customer: 'Customer D', qty: 10 },
      { customer: 'Customer E', qty: 10 },
    ],
  }))
  // 两条带备注的客户行 + 一条汇总行
  assert.equal(countBreakdownRows(html), 3)
  assert.ok(html.includes('DS'))
  assert.ok(hasRestRow(html))
  assert.ok(html.includes('其余 3 家'))
  // 没备注的客户不单独列名
  assert.ok(!html.includes('Customer C'))
  // 账要平：41 = 7 + 2 + 32
  assert.ok(html.includes('41'), '主行总量')
  assert.ok(html.includes('>32<') || html.includes('32\n'), '其余 3 家合计 32')
})

test('只有一家没备注时汇总行用单数措辞（英文）', () => {
  const html = generateTripPickingHtml(buildData({
    goodsType: 'BULK',
    expandByCustomer: false,
    lines: [
      { customer: 'Alpha', qty: 3, note: 'urgent' },
      { customer: 'Beta', qty: 4 },
    ],
  }), 'all', 'en')
  assert.ok(html.includes('1 other customer'))
  assert.ok(!html.includes('1 other customers'))
})

// ── 4. 全部客户都有备注时不应该多出一条空汇总行 ────────────────────────────────
test('所有客户都有备注时不加汇总行', () => {
  const html = generateTripPickingHtml(buildData({
    goodsType: 'BULK',
    expandByCustomer: false,
    lines: [
      { customer: 'Alpha', qty: 3, note: 'a' },
      { customer: 'Beta', qty: 4, note: 'b' },
    ],
  }))
  assert.equal(countBreakdownRows(html), 2)
  assert.ok(!hasRestRow(html))
})

// ── 5. expandMode='all'（print multi line 按钮）不受单位配置影响 ────────────────
test("expandMode='all' 时无视单位配置全展开", () => {
  const html = generateTripPickingHtml(buildData({
    goodsType: 'BULK',
    expandByCustomer: false,
    lines: [
      { customer: 'Alpha', qty: 3 },
      { customer: 'Beta', qty: 4 },
    ],
  }), 'all', 'zh', 'all')
  assert.equal(countBreakdownRows(html), 2)
  assert.ok(!hasRestRow(html), '全展开模式下没有被隐藏的客户，不该有汇总行')
})

// ── 6. 分表仍然只看 goodsType，不受展开配置影响 ────────────────────────────────
test('分表依据仍是 goodsType，与 expandByCustomer 无关', () => {
  const loose = generateTripPickingHtml(buildData({
    goodsType: 'LOOSE', expandByCustomer: false,
    lines: [{ customer: 'Alpha', qty: 1 }],
  }), 'consumable')
  assert.ok(loose.includes('零散货'), 'LOOSE 进零散货表，哪怕不展开')

  const bulk = generateTripPickingHtml(buildData({
    goodsType: 'BULK', expandByCustomer: true,
    lines: [{ customer: 'Alpha', qty: 1 }],
  }), 'storable')
  assert.ok(bulk.includes('整箱整袋'), 'BULK 进整箱表，哪怕要展开')
})
