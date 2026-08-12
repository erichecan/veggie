import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSalesMatrix,
  matrixToCsvRows,
  weekdayIndex,
  type MatrixSourceLine,
} from '../lib/analytics/sales-matrix'

const DOW = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const CSV_LABELS = {
  product: '产品', uom: '单位', total: '数量合计', amount: '金额合计',
  onHand: '当前库存', atp: '可承诺 ATP', grand: '合计',
}

function line(p: Partial<MatrixSourceLine> & { date: string; qty: number }): MatrixSourceLine {
  return {
    productId: p.productId ?? 'p1',
    productName: p.productName ?? '土豆',
    uomName: p.uomName ?? 'KG',
    amount: p.amount ?? p.qty * 2,
    qtyOnHand: p.qtyOnHand ?? 100,
    sequence: p.sequence ?? 0,
    ...p,
  }
}

// 2026-08-10 是周一，08-16 是周日（用 UTC 中午取星期，避开时区把日期推到隔壁）
describe('星期编号', () => {
  test('周一 = 0，周日 = 6', () => {
    assert.equal(weekdayIndex('2026-08-10'), 0)
    assert.equal(weekdayIndex('2026-08-16'), 6)
  })

  test('⛔ 与进程时区无关（UTC-4 下 00:00 那天不许滑到前一天）', () => {
    const prev = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      assert.equal(weekdayIndex('2026-08-10'), 0)
    } finally {
      if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev
    }
  })
})

describe('按周矩阵（周一至周日七列）', () => {
  const lines = [
    line({ date: '2026-08-10', qty: 3 }),                       // 周一
    line({ date: '2026-08-17', qty: 4 }),                       // 又一个周一
    line({ date: '2026-08-12', qty: 5 }),                       // 周三
    line({ date: '2026-08-12', qty: 1, productId: 'p2', productName: '西红柿', qtyOnHand: 8 }),
  ]

  test('固定 7 列，即使某几天没有单', () => {
    const m = buildSalesMatrix(lines, 'week', DOW)
    assert.equal(m.columns.length, 7)
    assert.deepEqual(m.columns.map(c => c.label), DOW)
  })

  test('同一个星期几跨周相加（这正是「按周看节奏」的用途）', () => {
    const m = buildSalesMatrix(lines, 'week', DOW)
    const potato = m.rows.find(r => r.productId === 'p1')!
    assert.equal(potato.qty[0], 7, '两个周一 3+4 应合成 7')
    assert.equal(potato.qty[2], 5)
    assert.equal(potato.totalQty, 12)
  })

  test('合计行按列汇总，且等于各行之和', () => {
    const m = buildSalesMatrix(lines, 'week', DOW)
    assert.equal(m.grand.qty[2], 6, '周三 5 + 1')
    assert.equal(m.grand.totalQty, 13)
    assert.equal(m.grand.totalQty, m.rows.reduce((s, r) => s + r.totalQty, 0))
  })
})

describe('按日矩阵（区间内每个配送日一列）', () => {
  const lines = [
    line({ date: '2026-08-12', qty: 5 }),
    line({ date: '2026-08-10', qty: 3 }),
    line({ date: '2026-08-10', qty: 2, productId: 'p2', productName: '西红柿' }),
  ]

  test('列 = 实际出现过的日期，升序，不补空日', () => {
    const m = buildSalesMatrix(lines, 'day', DOW)
    assert.deepEqual(m.columns.map(c => c.key), ['2026-08-10', '2026-08-12'])
    assert.deepEqual(m.columns.map(c => c.label), ['08-10', '08-12'])
  })

  test('数量落在对应日期列', () => {
    const m = buildSalesMatrix(lines, 'day', DOW)
    const potato = m.rows.find(r => r.productId === 'p1')!
    assert.deepEqual(potato.qty, [3, 5])
  })

  test('两种粒度的总量必须一致 —— 只是换个切法，不是换个口径', () => {
    const byDay = buildSalesMatrix(lines, 'day', DOW)
    const byWeek = buildSalesMatrix(lines, 'week', DOW)
    assert.equal(byDay.grand.totalQty, byWeek.grand.totalQty)
    assert.equal(byDay.grand.totalAmount, byWeek.grand.totalAmount)
  })
})

describe('库存与可承诺量', () => {
  test('ATP = 当前库存 − 区间已订量', () => {
    const m = buildSalesMatrix(
      [line({ date: '2026-08-10', qty: 30, qtyOnHand: 100 }), line({ date: '2026-08-11', qty: 20, qtyOnHand: 100 })],
      'day', DOW,
    )
    assert.equal(m.rows[0].qtyOnHand, 100)
    assert.equal(m.rows[0].totalQty, 50)
    assert.equal(m.rows[0].atp, 50)
  })

  test('订得比库存多 → ATP 为负（负数不等于缺货，只是提示要补货）', () => {
    const m = buildSalesMatrix([line({ date: '2026-08-10', qty: 130, qtyOnHand: 100 })], 'day', DOW)
    assert.equal(m.rows[0].atp, -30)
  })

  test('⚠️ 按 productId 归并：同名不同商品分成两行，库存才解释得通', () => {
    const m = buildSalesMatrix([
      line({ date: '2026-08-10', qty: 1, productId: 'a', productName: '生菜', qtyOnHand: 10 }),
      line({ date: '2026-08-10', qty: 2, productId: 'b', productName: '生菜', qtyOnHand: 90 }),
    ], 'day', DOW)
    assert.equal(m.rows.length, 2)
    assert.equal(m.grand.totalQty, 3, '拆行不影响合计')
  })

  test('没有 productId 的历史行回退用名字当键，不整批丢掉', () => {
    const m = buildSalesMatrix([line({ date: '2026-08-10', qty: 4, productId: '' })], 'day', DOW)
    assert.equal(m.rows.length, 1)
    assert.equal(m.rows[0].totalQty, 4)
  })
})

describe('空数据与浮点', () => {
  test('没有任何行时按周仍出 7 列、合计 0（表头不塌）', () => {
    const m = buildSalesMatrix([], 'week', DOW)
    assert.equal(m.columns.length, 7)
    assert.equal(m.rows.length, 0)
    assert.equal(m.grand.totalQty, 0)
  })

  test('按日无数据时列为空数组，不是 undefined', () => {
    const m = buildSalesMatrix([], 'day', DOW)
    assert.deepEqual(m.columns, [])
  })

  test('小数累加收敛到两位（0.1+0.2 不许透出 0.30000000000000004）', () => {
    const m = buildSalesMatrix([
      line({ date: '2026-08-10', qty: 0.1, amount: 0.1 }),
      line({ date: '2026-08-10', qty: 0.2, amount: 0.2 }),
    ], 'day', DOW)
    assert.equal(m.rows[0].qty[0], 0.3)
    assert.equal(m.rows[0].totalAmount, 0.3)
  })
})

describe('CSV 行', () => {
  const m = buildSalesMatrix([
    line({ date: '2026-08-10', qty: 3, amount: 6, qtyOnHand: 100 }),
    line({ date: '2026-08-12', qty: 5, amount: 10, qtyOnHand: 100 }),
  ], 'day', DOW)

  test('表头 = 产品/单位 + 各列 + 合计/金额/库存/ATP', () => {
    const { headers } = matrixToCsvRows(m, CSV_LABELS)
    assert.deepEqual(headers, ['产品', '单位', '08-10', '08-12', '数量合计', '金额合计', '当前库存', '可承诺 ATP'])
  })

  test('数据行与表头列数一致（错位会让 Excel 里整列串位）', () => {
    const { headers, rows } = matrixToCsvRows(m, CSV_LABELS)
    for (const r of rows) assert.equal(r.length, headers.length)
  })

  test('最后一行是合计，且数字与矩阵一致', () => {
    const { rows } = matrixToCsvRows(m, CSV_LABELS)
    const last = rows[rows.length - 1]
    assert.equal(last[0], '合计')
    assert.equal(last[2], 3)
    assert.equal(last[3], 5)
    assert.equal(last[4], 8)
  })
})
