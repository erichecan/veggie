/**
 * 超收冲抵历史欠款（台账 C9）—— 分配算法单测
 *
 * 需求原文：「若金额超出当日订单额，需能标记出超出部分是回收的历史欠款并冲抵」。
 *
 * 这层最怕的两件事：
 *   1. 把「多收的钱」和「收回的旧账」混成一笔 —— 财务事后分不清该退还是该记账
 *   2. 冲抵时把同一张发票扣两次 —— 一个客户在一趟车里可能有多个站
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { allocateCollections, type InvoiceForAllocation, type StopCollection } from '../lib/trip-settlement-payment'

const inv = (
  id: string, customerId: string, amountDue: number,
  dueDate: string | null = null, status = 'POSTED',
): InvoiceForAllocation => ({ id, name: `INV-${id}`, customerId, amountDue, status, dueDate })

const stop = (restaurantId: string, amount: number, orderIds: string[]): StopCollection =>
  ({ restaurantId, restaurantName: `店-${restaurantId}`, amount, orderIds })

describe('超收冲抵历史欠款', () => {
  test('不传历史发票时维持老行为：超收进 unallocated', () => {
    const r = allocateCollections(
      [stop('c1', 300, ['o1'])],
      [inv('i1', 'c1', 100)],
      new Map([['o1', ['i1']]]),
    )
    assert.equal(r.totalAllocated, 100)
    assert.equal(r.historicalDebtRecovered, 0)
    assert.equal(r.unallocated.length, 1)
    assert.equal(r.unallocated[0]!.amount, 200)
  })

  test('超出当日订单额的部分冲抵历史欠款，并**标记出来**', () => {
    const r = allocateCollections(
      [stop('c1', 300, ['o1'])],
      [inv('i1', 'c1', 100)],
      new Map([['o1', ['i1']]]),
      new Map([['c1', [inv('old1', 'c1', 500, '2026-01-01')]]]),
    )
    assert.equal(r.totalAllocated, 300)
    assert.equal(r.historicalDebtRecovered, 200, '超出的 200 应冲抵历史欠款')
    assert.equal(r.unallocated.length, 0)

    const today = r.payments.filter(p => !p.isHistoricalDebt)
    const history = r.payments.filter(p => p.isHistoricalDebt)
    assert.equal(today.length, 1)
    assert.equal(today[0]!.amount, 100)
    assert.equal(history.length, 1)
    assert.equal(history[0]!.amount, 200)
    assert.equal(history[0]!.invoiceName, 'INV-old1')
  })

  test('历史欠款按到期日从早到晚还（标准 AR 顺序）', () => {
    const r = allocateCollections(
      [stop('c1', 250, ['o1'])],
      [inv('i1', 'c1', 50)],
      new Map([['o1', ['i1']]]),
      new Map([['c1', [
        inv('late', 'c1', 100, '2026-06-01'),
        inv('early', 'c1', 100, '2026-01-01'),
      ]]]),
    )
    const history = r.payments.filter(p => p.isHistoricalDebt)
    assert.equal(history[0]!.invoiceName, 'INV-early', '到期早的先还')
    assert.equal(history[1]!.invoiceName, 'INV-late')
    assert.equal(r.historicalDebtRecovered, 200)
  })

  test('历史欠款也不够冲时，剩下的才算真超收', () => {
    const r = allocateCollections(
      [stop('c1', 1000, ['o1'])],
      [inv('i1', 'c1', 100)],
      new Map([['o1', ['i1']]]),
      new Map([['c1', [inv('old1', 'c1', 200)]]]),
    )
    assert.equal(r.totalAllocated, 300)
    assert.equal(r.historicalDebtRecovered, 200)
    assert.equal(r.unallocated.length, 1)
    assert.equal(r.unallocated[0]!.amount, 700)
    assert.ok(/含历史欠款/.test(r.unallocated[0]!.reason), '理由要说清已经冲过历史欠款了')
  })

  test('⛔ 同一客户出现两次，历史发票不能被扣两次', () => {
    // `stop.restaurantId` 在本系统里**就是** Customer.id（下单时 restaurantId 存的是客户 id）。
    // 正常聚合后一个客户只会有一个 stop，但手工建的 Trip 可能重复 —— 那时两个 stop
    // 各收 200、历史欠款只有 300，合起来最多冲 300，绝不能冲出 400。
    const history = new Map([['c1', [inv('old1', 'c1', 300)]]])
    const r = allocateCollections(
      [stop('c1', 200, ['o1']), stop('c1', 200, ['o2'])],
      [inv('i1', 'c1', 0, null, 'PAID')],   // 当日发票已结清，全部要走历史
      new Map([['o1', ['i1']], ['o2', ['i1']]]),
      history,
    )
    assert.equal(r.historicalDebtRecovered, 300, `实得 ${r.historicalDebtRecovered}`)
    const total = r.payments.reduce((s, p) => s + p.amount, 0)
    assert.equal(total, 300, '总核销不能超过历史欠款余额')
    assert.equal(r.unallocated.reduce((s, u) => s + u.amount, 0), 100, '多出的 100 要如实报出来')
  })

  test('当日发票已结清时，收到的钱**全部**走历史欠款（最典型的场景）', () => {
    // 客户是月结、今天的货不当场付，司机收的纯粹是上周的旧账。
    // 第一版把冲抵写在「当日无可核销发票就 continue」之后，这个场景一分钱都冲不掉。
    const r = allocateCollections(
      [stop('c1', 250, ['o1'])],
      [inv('i1', 'c1', 0, null, 'PAID')],
      new Map([['o1', ['i1']]]),
      new Map([['c1', [inv('old1', 'c1', 400, '2026-01-01')]]]),
    )
    assert.equal(r.historicalDebtRecovered, 250)
    assert.equal(r.unallocated.length, 0)
    assert.ok(r.payments.every(p => p.isHistoricalDebt))
  })

  test('该站压根没有当日发票时，也能冲历史欠款', () => {
    const r = allocateCollections(
      [stop('c1', 120, ['o-none'])],
      [],
      new Map(),
      new Map([['c1', [inv('old1', 'c1', 500)]]]),
    )
    assert.equal(r.historicalDebtRecovered, 120)
    assert.equal(r.unallocated.length, 0)
  })

  test('已在当日发票列表里的，不会被当成历史欠款重复冲一次', () => {
    const shared = inv('i1', 'c1', 500)
    const r = allocateCollections(
      [stop('c1', 300, ['o1'])],
      [shared],
      new Map([['o1', ['i1']]]),
      new Map([['c1', [inv('i1', 'c1', 500)]]]),   // 同一张也放进历史里（调用方可能没排除）
    )
    assert.equal(r.totalAllocated, 300)
    assert.equal(r.historicalDebtRecovered, 0, '当日那张不该被再算一次历史')
    assert.equal(r.payments.length, 1)
  })

  test('未过账（DRAFT）的历史发票不参与冲抵 —— 过账是财务动作', () => {
    const r = allocateCollections(
      [stop('c1', 300, ['o1'])],
      [inv('i1', 'c1', 100)],
      new Map([['o1', ['i1']]]),
      new Map([['c1', [inv('draft1', 'c1', 500, null, 'DRAFT')]]]),
    )
    assert.equal(r.historicalDebtRecovered, 0)
    assert.equal(r.unallocated[0]!.amount, 200)
  })

  test('刚好付清当日订单时不去碰历史欠款', () => {
    const r = allocateCollections(
      [stop('c1', 100, ['o1'])],
      [inv('i1', 'c1', 100)],
      new Map([['o1', ['i1']]]),
      new Map([['c1', [inv('old1', 'c1', 500)]]]),
    )
    assert.equal(r.historicalDebtRecovered, 0)
    assert.equal(r.payments.length, 1)
    assert.equal(r.unallocated.length, 0)
  })
})
