/**
 * 采购质检纯函数（台账 F4）
 * ============================================================================
 * 这一层是四个使用点（收货接口 / 收货界面 / 采购单详情 / 批次追溯）共用的口径，
 * 所以「结论怎么算」「什么必须填」只在这里钉一次。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseQc, parseStoredQc, qcVerdict, lineVerdict, hasQcMeasurements,
  validateQcLines, formatQcSummary, QcInputError,
} from '../lib/purchase/qc'

test('parseQc: 全部留空返回 null，而不是空对象', () => {
  assert.equal(parseQc(undefined), null)
  assert.equal(parseQc({}), null)
  assert.equal(parseQc({ weightKg: '', freshness: '', pesticide: '', note: '  ' }), null)
})

test('parseQc: 三项可单独填，留空的保持 null（不被当成 0）', () => {
  const qc = parseQc({ weightKg: '12.5' })
  assert.equal(qc?.weightKg, 12.5)
  assert.equal(qc?.freshness, null)
  assert.equal(qc?.pesticide, null)
})

test('parseQc: 非法枚举值抛错，不静默丢弃', () => {
  assert.throws(() => parseQc({ freshness: 'S' }), QcInputError)
  assert.throws(() => parseQc({ pesticide: 'MAYBE' }), QcInputError)
  assert.throws(() => parseQc({ weightKg: -1 }), QcInputError)
  assert.throws(() => parseQc({ weightKg: 'abc' }), QcInputError)
})

test('qcVerdict: 未填三项 → null（「未质检」不等于「合格」）', () => {
  assert.equal(qcVerdict(null), null)
  assert.equal(qcVerdict(parseQc({ note: '外包装完好' })), null)
  assert.equal(hasQcMeasurements(parseQc({ note: '外包装完好' })), false)
})

test('qcVerdict: 农残超标或新鲜度 D 判为不合格', () => {
  assert.equal(qcVerdict(parseQc({ pesticide: 'FAIL' })), 'FAIL')
  assert.equal(qcVerdict(parseQc({ freshness: 'D' })), 'FAIL')
  assert.equal(qcVerdict(parseQc({ freshness: 'A', pesticide: 'PASS' })), 'PASS')
  assert.equal(qcVerdict(parseQc({ pesticide: 'NOT_TESTED' })), 'PASS')
})

test('lineVerdict: 拒收本身即不合格，哪怕一格体检值都没填', () => {
  assert.equal(lineVerdict(null, 10), 'FAIL')
  assert.equal(lineVerdict(parseQc({ freshness: 'A' }), 5), 'FAIL')
  assert.equal(lineVerdict(parseQc({ freshness: 'A' }), 0), 'PASS')
})

test('validateQcLines: 拒收必须给原因', () => {
  const err = validateQcLines([
    { productId: 'p1', productName: '生菜', qty: 10, condition: 'rejected', qc: null },
  ])
  assert.match(err ?? '', /拒收必须选择原因/)

  assert.equal(validateQcLines([
    { productId: 'p1', productName: '生菜', qty: 10, condition: 'rejected', qc: null, rejectReason: 'FRESHNESS' },
  ]), null)
})

test('validateQcLines: 非法拒收原因不被接受（等同没填）', () => {
  const err = validateQcLines([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { productId: 'p1', qty: 10, condition: 'rejected', qc: null, rejectReason: 'BECAUSE' as any },
  ])
  assert.match(err ?? '', /拒收必须选择原因/)
})

test('validateQcLines: 农残超标却一件都没拒收，必须写明让步接收理由', () => {
  const lines = [
    { productId: 'p1', productName: '菠菜', qty: 20, condition: 'ok', qc: parseQc({ pesticide: 'FAIL' }) },
  ]
  assert.match(validateQcLines(lines) ?? '', /让步接收/)

  // 写了理由 → 放行（现实中确实会先收下再复检，这条不是拦截，是逼它留下说法）
  assert.equal(validateQcLines([
    { productId: 'p1', productName: '菠菜', qty: 20, condition: 'ok', qc: parseQc({ pesticide: 'FAIL', note: '供应商承诺复检报告明日补' }) },
  ]), null)

  // 同一商品已有拒收行 → 不再追问（货已经退回去了）
  assert.equal(validateQcLines([
    { productId: 'p1', productName: '菠菜', qty: 20, condition: 'ok', qc: parseQc({ pesticide: 'FAIL' }) },
    { productId: 'p1', productName: '菠菜', qty: 5, condition: 'rejected', qc: null, rejectReason: 'PESTICIDE' },
  ]), null)
})

test('validateQcLines: 质检全空的普通收货照旧放行（可留空是硬要求）', () => {
  assert.equal(validateQcLines([
    { productId: 'p1', qty: 10, condition: 'ok', qc: null },
    { productId: 'p1', qty: 2, condition: 'damaged', qc: null },
  ]), null)
})

test('parseStoredQc: 读端宽松 —— 脏值忽略而不是抛错，且保留服务端盖的章', () => {
  const stored = parseStoredQc({
    weightKg: 8, freshness: 'X', pesticide: 'PASS', note: '  ',
    checkedBy: '张三', checkedAt: '2026-08-12T00:00:00.000Z',
  })
  assert.equal(stored?.freshness, null)
  assert.equal(stored?.pesticide, 'PASS')
  assert.equal(stored?.note, null)
  assert.equal(stored?.checkedBy, '张三')
  assert.equal(parseStoredQc({ weightKg: null }), null)
})

test('formatQcSummary: 只拼填了的项，不产出「重量 null」这种噪音', () => {
  assert.equal(formatQcSummary(parseQc({ weightKg: 9.5, pesticide: 'FAIL' })), '实测 9.5kg · 农残 超标')
  assert.equal(formatQcSummary(null), '')
})
