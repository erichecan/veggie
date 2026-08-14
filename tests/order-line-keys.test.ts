/**
 * 订单行录入键盘流（台账 X7）
 *
 * 最容易写错的是**中文输入法**那条：备注/描述是文本框，用拼音打字时 Enter 是
 * 「确认候选词」。不判 isComposing 就拦截的话，用户每敲完一个词就被弹去下一行 ——
 * 中文根本没法输入，而这个 bug 用英文测永远测不出来。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { lineFieldKeyHandler } from '../lib/order-line-keys'

interface FakeEvent {
  key: string
  shiftKey?: boolean
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
  prevented?: boolean
  preventDefault(): void
}

const ev = (key: string, over: Partial<FakeEvent> = {}): FakeEvent => {
  const e: FakeEvent = {
    key,
    shiftKey: false,
    nativeEvent: { isComposing: false },
    prevented: false,
    preventDefault() { e.prevented = true },
    ...over,
  }
  return e
}

/** 跑一次 handler，返回「是否进了下一行」与「是否拦了默认行为」 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function run(e: FakeEvent, opts: { isLastFieldOfLastRow?: boolean } = {}) {
  let next = 0
  lineFieldKeyHandler({ onNextRow: () => { next++ }, ...opts })(e as any)
  return { next, prevented: e.prevented }
}

describe('X7 Enter = 下一行', () => {
  test('普通字段按 Enter 进下一行，并拦掉默认行为（否则会提交表单）', () => {
    const r = run(ev('Enter'))
    assert.equal(r.next, 1)
    assert.equal(r.prevented, true)
  })

  test('最后一个字段按 Enter 同样进下一行', () => {
    assert.equal(run(ev('Enter'), { isLastFieldOfLastRow: true }).next, 1)
  })
})

describe('X7 中文输入法：确认候选词的 Enter 不是「下一行」', () => {
  test('isComposing 时放行，不跳行也不拦默认', () => {
    const r = run(ev('Enter', { nativeEvent: { isComposing: true } }))
    assert.equal(r.next, 0, '拦了的话，拼音每选一个词就被弹去下一行')
    assert.equal(r.prevented, false)
  })

  test('老浏览器用 keyCode 229 表示输入法处理中，同样放行', () => {
    const r = run(ev('Enter', { nativeEvent: { keyCode: 229 } }))
    assert.equal(r.next, 0)
    assert.equal(r.prevented, false)
  })

  test('输入法结束后（isComposing=false）的 Enter 正常跳行', () => {
    assert.equal(run(ev('Enter', { nativeEvent: { isComposing: false } })).next, 1)
  })
})

describe('X7 Tab = 下一个字段，只有最后一格才跳行', () => {
  test('中间字段的 Tab 不拦 —— 拦了就走不到本行下一格', () => {
    const r = run(ev('Tab'))
    assert.equal(r.next, 0)
    assert.equal(r.prevented, false)
  })

  test('最后一行最后一格的 Tab 进下一行', () => {
    const r = run(ev('Tab'), { isLastFieldOfLastRow: true })
    assert.equal(r.next, 1)
    assert.equal(r.prevented, true)
  })

  test('Shift+Tab 一律不接管 —— 反向走位改了就找不回上一格', () => {
    const r = run(ev('Tab', { shiftKey: true }), { isLastFieldOfLastRow: true })
    assert.equal(r.next, 0)
    assert.equal(r.prevented, false)
  })
})

describe('X7 其余按键不受影响', () => {
  test('普通输入与方向键不被接管', () => {
    for (const k of ['a', '1', 'ArrowDown', 'ArrowUp', 'Escape', 'Backspace']) {
      const r = run(ev(k), { isLastFieldOfLastRow: true })
      assert.equal(r.next, 0, `${k} 不该跳行`)
      assert.equal(r.prevented, false, `${k} 不该被拦`)
    }
  })
})
