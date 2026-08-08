import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 发信失败必须抛异常，不能静默成功。
 *
 * 背景（2026-08-08）：Resend SDK 的 `emails.send()` 在 HTTP 非 2xx 时**不 throw**，
 * 而是 `return { data: null, error: {...} }`（见 node_modules/resend/dist/index.mjs
 * 的 fetchRequest：`if (!response.ok) ... return { data: null, error, headers }`）。
 *
 * 所以调用方写了 try/catch 也捕获不到——采购单 RFQ 那段注释声称"不允许界面显示
 * 已发送但实际没发的假成功"，实际上正是这么假成功的：发件域 veggiesupply.ie 从未
 * 在 Resend 验证过，每次发送都 403，而单据照样被推进到 SENT。
 *
 * 这组测试锁住修复：lib/email.ts 的 dispatch() 把 error 翻译成异常。
 * 谁要是改回直接 `await getResend().emails.send(...)`，这里立刻红。
 */

const realFetch = globalThis.fetch
let lastRequest: { url: string; body: Record<string, unknown> } | null = null

function stubFetch(status: number, payload: unknown) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    lastRequest = {
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    }
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

beforeEach(() => {
  process.env.RESEND_API_KEY = 're_test_key_not_real'
  lastRequest = null
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const ORDER_PARAMS = {
  to: 'customer@example.com',
  customerName: '测试餐馆',
  orderId: 'cltest000000000000000000',
  items: [{ name: '西兰花', qty: 2, unit: '箱', price: 10 }],
  total: 20,
}

test('发件域未验证（403）时必须抛异常，而不是静默返回', async () => {
  stubFetch(403, {
    statusCode: 403,
    name: 'validation_error',
    message: 'The johnstonebros.ie domain is not verified.',
  })
  const { sendOrderConfirmation } = await import('../lib/email')

  await assert.rejects(
    () => sendOrderConfirmation(ORDER_PARAMS),
    /domain is not verified/,
    '403 被静默咽掉了 —— 这正是生产上那个假成功',
  )
})

test('限流（429）同样抛异常', async () => {
  stubFetch(429, {
    statusCode: 429,
    name: 'rate_limit_exceeded',
    message: 'Too many requests.',
  })
  const { sendOrderConfirmation } = await import('../lib/email')

  await assert.rejects(() => sendOrderConfirmation(ORDER_PARAMS), /rate_limit_exceeded/)
})

test('返回 200 但没有消息 id 也算失败 —— 无法确认是否送达', async () => {
  stubFetch(200, {})
  const { sendOrderConfirmation } = await import('../lib/email')

  await assert.rejects(() => sendOrderConfirmation(ORDER_PARAMS), /消息 id/)
})

test('成功时正常返回，并用 EMAIL_FROM 指定的发件地址', async () => {
  process.env.EMAIL_FROM = 'Johnstone Bros <noreply@johnstonebros.ie>'
  stubFetch(200, { id: 'msg_abc123' })

  // FROM 在模块加载时求值，需要绕过 ESM 模块缓存重新取一份
  const { sendOrderConfirmation } = await import(`../lib/email?from-test=${Date.now()}`)
  await sendOrderConfirmation(ORDER_PARAMS)

  assert.equal(lastRequest?.url, 'https://api.resend.com/emails')
  assert.equal(lastRequest?.body.from, 'Johnstone Bros <noreply@johnstonebros.ie>')
  assert.equal(lastRequest?.body.to, 'customer@example.com')
})
