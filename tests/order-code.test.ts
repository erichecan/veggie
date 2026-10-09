/**
 * 回归测试：订单业务编号统一改为 D 前缀（20261008，客户要求 quotation/sale order 编号规则统一）。
 * 不再按创建者缩写区分前缀，全局固定 "D-YYMMDD-NNN"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatYYMMDD, nextOrderCode } from '../lib/order-code'

function fakeClient(existingCodes: string[]) {
  return {
    order: {
      findMany: async ({ where }: { where: { code: { startsWith: string } } }) =>
        existingCodes
          .filter((c) => c.startsWith(where.code.startsWith))
          .map((code) => ({ code })),
    },
  } as unknown as Parameters<typeof nextOrderCode>[0]
}

test('formatYYMMDD：本地时区 YYMMDD', () => {
  assert.equal(formatYYMMDD(new Date(2026, 3, 24)), '260424')
})

test('nextOrderCode：当天无记录 → D-YYMMDD-001', async () => {
  const date = new Date(2026, 3, 24)
  const code = await nextOrderCode(fakeClient([]), date)
  assert.equal(code, 'D-260424-001')
})

test('nextOrderCode：已有记录 → 序号递增，不区分创建者', async () => {
  const date = new Date(2026, 3, 24)
  const code = await nextOrderCode(fakeClient(['D-260424-001', 'D-260424-002']), date)
  assert.equal(code, 'D-260424-003')
})

test('nextOrderCode：不同日期前缀互不干扰', async () => {
  const date = new Date(2026, 3, 25)
  const code = await nextOrderCode(fakeClient(['D-260424-005']), date)
  assert.equal(code, 'D-260425-001')
})
