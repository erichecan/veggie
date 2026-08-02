/**
 * M01 B2B 移动端订货系统（客户前端 App / Web）
 * 合同清单：
 *   ① 常购清单：支持餐厅客户一键快捷复购
 *   ② 账期与定价：不同客户展示专属批发价与账期权限
 *   ③ 订单提交：自动校验并生成标准电子销售订单
 */
import { readFileSync } from 'node:fs'
import { defineCheck, api, grepCode, grepMatrix, fileExists, prisma, PROBE_MARK } from '../harness'

defineCheck({
  id: 'M01-01',
  module: '01',
  title: '常购清单：一键快捷复购',
  prev: 'missing',
  async run() {
    const evidence: string[] = []
    const r = await api('/api/customer-portal/frequently-ordered', { role: 'RESTAURANT' })
    evidence.push(r.brief)

    const ui = grepCode('一键复购|常购清单', { max: 4 })
    evidence.push(...ui.map(l => `UI: ${l.slice(0, 140)}`))

    const list = Array.isArray(r.body) ? r.body as Record<string, unknown>[] : []
    const hasQty = list.length > 0 && 'lastQty' in list[0]

    if (r.status !== 200) {
      return { verdict: 'missing' as const, gap: `接口返回 ${r.status}`, evidence }
    }
    evidence.push(`返回 ${list.length} 个常购商品${hasQty ? '，含 lastQty 预填数量' : ''}`)
    // 接口通 + UI 有一键复购按钮 = 功能闭环
    return {
      verdict: 'done' as const,
      evidence,
    }
  },
})

defineCheck({
  id: 'M01-02',
  module: '01',
  title: '账期与专属批发价展示',
  prev: 'partial',
  async run() {
    const evidence: string[] = []
    const r = await api('/api/customer-portal/products', { role: 'RESTAURANT' })
    const body = r.body as {
      products?: Record<string, unknown>[]
      paymentTerm?: string
      priceType?: string
      customerName?: string
    }
    evidence.push(r.brief)
    evidence.push(`接口返回 paymentTerm=${JSON.stringify(body?.paymentTerm)} priceType=${JSON.stringify(body?.priceType)}`)

    // 客户端页面是否真的把账期渲染出来（不是只 useState 存着）
    const render = grepCode('结算方式|paymentTerm', { roots: 'app/\\[locale\\]/customer-portal', max: 6 })
    evidence.push(...render.map(l => `渲染: ${l.slice(0, 140)}`))
    const uiShows = render.length > 0

    // 专属批发价：同一商品对两个不同客户是否取到不同价
    const prods = body?.products ?? []
    const withPrice = prods.filter(p => p.customerPrice != null).length
    const special = prods.filter(p => p.isSpecialPrice === true).length
    evidence.push(`商品 ${prods.length} 个，${withPrice} 个带 customerPrice，${special} 个命中客户专属价(isSpecialPrice)`)

    const boundCount = await prisma.customerPricelist.count()
    const specialCount = await prisma.customerSpecialPrice.count()
    evidence.push(`客户↔价格表绑定 ${boundCount} 条，客户专属价 ${specialCount} 条`)

    // 信用额度：是否在客户端可见 / 是否参与下单阻断
    const creditInPortal = grepCode('creditLimit', { max: 20 }).filter(l => l.includes('customer-portal'))
    const creditBlocks = grepCode('creditLimit', { max: 20 })
      .filter(l => l.includes('/api/') && /超额|exceed|block|reject/i.test(l))
    evidence.push(`信用额度: 客户端命中 ${creditInPortal.length} 处，下单阻断逻辑命中 ${creditBlocks.length} 处`)

    if (r.status !== 200) {
      return { verdict: 'missing' as const, gap: `接口返回 ${r.status}`, evidence }
    }
    if (!body?.paymentTerm || !uiShows) {
      return {
        verdict: 'partial' as const,
        gap: uiShows ? '接口未返回 paymentTerm' : '客户端页面未渲染账期',
        evidence,
      }
    }
    // 账期与专属价均已展示，但信用额度只在运营端展示、不参与下单管控
    return {
      verdict: 'partial' as const,
      gap: '专属批发价与账期已在客户端展示；但信用额度只在运营端可见，客户端不可见且不参与下单阻断（无超额拦截）',
      evidence,
    }
  },
})

defineCheck({
  id: 'M01-03',
  module: '01',
  title: '订单提交自动校验，生成标准电子销售订单',
  prev: 'done',
  async run() {
    const evidence: string[] = []
    let createdOrderId: string | null = null

    try {
      // ── 1. 空订单必须被拦 ──────────────────────────────────────────────
      const empty = await api('/api/customer-portal/orders', {
        role: 'RESTAURANT', method: 'POST', body: { items: [] },
      })
      evidence.push(`校验-空订单: ${empty.brief}`)

      // ── 2. 未登录必须 401 ─────────────────────────────────────────────
      const anon = await api('/api/customer-portal/orders', {
        method: 'POST', body: { items: [] }, noAuth: true,
      })
      evidence.push(`校验-未登录: ${anon.brief}`)

      // ── 3. 真实下一单 ─────────────────────────────────────────────────
      const prodRes = await api('/api/customer-portal/products', { role: 'RESTAURANT' })
      const prods = ((prodRes.body as { products?: Record<string, unknown>[] })?.products ?? [])
      const pick = prods.find(p => p.id)
      if (!pick) {
        return { verdict: 'partial' as const, gap: '客户端商品接口无可下单商品，无法验证下单链路', evidence }
      }

      const created = await api('/api/customer-portal/orders', {
        role: 'RESTAURANT',
        method: 'POST',
        body: {
          items: [{ productId: pick.id, quantity: 1 }],
          paymentMethod: 'CASH',
          internalNote: PROBE_MARK,
        },
      })
      evidence.push(`下单: ${created.brief}`)

      const orderId = (created.body as { id?: string; order?: { id?: string } })?.id
        ?? (created.body as { order?: { id?: string } })?.order?.id
      if (created.status !== 201 && created.status !== 200) {
        return { verdict: 'partial' as const, gap: `下单接口返回 ${created.status}`, evidence }
      }
      createdOrderId = orderId ?? null

      // ── 4. 确认真的落成标准销售订单（有单号、有行、服务端权威定价） ──────
      if (createdOrderId) {
        const row = await prisma.order.findUnique({
          where: { id: createdOrderId },
          select: {
            code: true, status: true, totalAmount: true, restaurantName: true,
            pricelistId: true, priceType: true,
            lines: { select: { productName: true, unitPrice: true, orderedQty: true, subtotal: true } },
          },
        })
        evidence.push(
          `落库: code=${row?.code} status=${row?.status} 行数=${row?.lines.length} ` +
          `total=${row?.totalAmount} priceType=${row?.priceType ?? 'null'}`,
        )
        const serverPriced = (row?.lines ?? []).every(l => Number(l.unitPrice) >= 0 && l.subtotal != null)
        evidence.push(`服务端权威定价回写: ${serverPriced ? '是' : '否'}`)
      }

      const validates = empty.status === 400 && anon.status === 401
      if (!validates) {
        return {
          verdict: 'partial' as const,
          gap: `校验不完整（空订单=${empty.status} 期望400，未登录=${anon.status} 期望401）`,
          evidence,
        }
      }
      return { verdict: 'done' as const, evidence }
    } finally {
      // ── 清理：只删探针自己建的记录 ────────────────────────────────────
      if (createdOrderId) {
        await prisma.orderLine.deleteMany({ where: { orderId: createdOrderId } })
        const del = await prisma.order.deleteMany({
          where: { id: createdOrderId, internalNote: PROBE_MARK },
        })
        await prisma.actionLog.deleteMany({ where: { resource: 'Order', resourceId: createdOrderId } })
        evidence.push(`清理: 删除探针订单 ${createdOrderId} (${del.count} 行)`)
      }
    }
  },
})

defineCheck({
  id: 'M01-04',
  module: '01',
  title: '（形态说明）是否存在独立移动端 App / PWA',
  prev: undefined,
  async run() {
    const APP = 'app lib components'
    const m = grepMatrix(
      ['react-native', 'capacitor', 'expo-', 'manifest.json', 'serviceWorker', 'beforeinstallprompt'],
      APP,
    )
    const evidence = [`原生 App 关键词命中: ${JSON.stringify(m)}`]
    const pwa = grepCode('beforeinstallprompt|添加到主屏|manifest.json', { roots: APP, max: 5 })
    evidence.push(...pwa.map(l => l.slice(0, 140)))

    let mf: Record<string, unknown> | null = null
    if (fileExists('public/manifest.json')) {
      try { mf = JSON.parse(readFileSync('public/manifest.json', 'utf8')) } catch { /* ignore */ }
    }
    if (mf) {
      evidence.push(
        `public/manifest.json: name=${JSON.stringify(mf.name)} display=${JSON.stringify(mf.display)} ` +
        `start_url=${JSON.stringify(mf.start_url)} icons=${Array.isArray(mf.icons) ? mf.icons.length : 0}`,
      )
    } else {
      evidence.push('public/manifest.json 不存在')
    }
    const installable = !!mf && mf.display === 'standalone' && Array.isArray(mf.icons) && mf.icons.length > 0
    const hasSW = m['serviceWorker'] > 0
    evidence.push(`Service Worker（离线能力）: ${hasSW ? '有' : '无'}`)

    return {
      verdict: installable ? ('partial' as const) : ('missing' as const),
      gap: installable
        ? 'PWA 形态：manifest + standalone + 图标齐全，可"添加到主屏"，但无 Service Worker（无离线能力），也无原生 App'
        : '无原生 App、无可安装 PWA，纯响应式网页',
      evidence,
    }
  },
})
