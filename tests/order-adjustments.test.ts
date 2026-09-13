/**
 * 订单调整行的纯计算/校验逻辑。DB 读写部分（listAdjustments/createAdjustment/
 * deleteAdjustment/getOrderPayableTotal 的 DB 查询）不在此覆盖——项目里没有
 * DB 集成测试的先例，走 lib/order-adjustments.ts 里已抽出的纯函数验证。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePayableTotal, validateAdjustmentInput } from '../lib/order-adjustments'

test('computePayableTotal: 无调整时等于商品小计本身', () => {
  assert.equal(computePayableTotal(100, []), 100)
})

test('computePayableTotal: 多条调整全部叠加', () => {
  assert.equal(computePayableTotal(100, [10, 20, 5]), 135)
})

test('computePayableTotal: 正负混合（折扣为负，配送费为正）', () => {
  assert.equal(computePayableTotal(200, [-20, 5, -1.5]), 183.5)
})

test('computePayableTotal: 四舍五入到 2 位小数', () => {
  assert.equal(computePayableTotal(10, [0.005, 0.005]), 10.01)
})

test('validateAdjustmentInput: 说明为空/纯空白拒绝', () => {
  assert.throws(() => validateAdjustmentInput({ label: '', amount: 10 }), /调整说明不能为空/)
  assert.throws(() => validateAdjustmentInput({ label: '   ', amount: 10 }), /调整说明不能为空/)
})

test('validateAdjustmentInput: 金额为 0/NaN/Infinity 拒绝', () => {
  assert.throws(() => validateAdjustmentInput({ label: '折扣', amount: 0 }), /非零数字/)
  assert.throws(() => validateAdjustmentInput({ label: '折扣', amount: NaN }), /非零数字/)
  assert.throws(() => validateAdjustmentInput({ label: '折扣', amount: Infinity }), /非零数字/)
})

test('validateAdjustmentInput: 合法输入返回去空白+四舍五入后的值', () => {
  const result = validateAdjustmentInput({ label: '  9月促销折扣  ', amount: -12.3456 })
  assert.deepEqual(result, { label: '9月促销折扣', amount: -12.35 })
})

test('validateAdjustmentInput: 负数/正数金额都允许（折扣为负、配送费为正）', () => {
  assert.doesNotThrow(() => validateAdjustmentInput({ label: '折扣', amount: -5 }))
  assert.doesNotThrow(() => validateAdjustmentInput({ label: '配送费', amount: 5 }))
})
