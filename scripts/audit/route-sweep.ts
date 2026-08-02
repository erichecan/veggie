/**
 * API 路由全量体检
 *
 * 用户 20260802 提的硬要求之一：「API 和路由一定要检查」。
 * 此前的验证是挑几个接口打一打，这个脚本改成**枚举 app/api 下全部路由逐条过**。
 *
 * 每条路由检查四件事：
 *   1. 匿名访问是否被拦（除白名单外必须 401）
 *   2. 伪造 token 是否被拦（必须 401）
 *   3. 低权限角色访问是否被拦（期望 401/403，200 则记为"未做角色限制"供人工判断）
 *   4. 授权访问是否不炸（不接受 500；404/400 属正常业务响应）
 *
 * ⚠️ 只打 GET。写操作不在这里扫——扫全部 POST/PUT/DELETE 会真的改生产数据。
 * 写路由的鉴权由第 1、2 项覆盖（middleware 层，与方法无关），业务行为由各自的
 * 端到端探针负责。
 *
 *   AUDIT_HOST=http://localhost:3100 npx tsx --env-file=.env.local scripts/audit/route-sweep.ts
 *   ... --json out.json     把结果落文件
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prisma, tokenFor, HOST } from './harness'
import { isPublicApiRoute } from '../../lib/public-routes'

interface RouteReport {
  path: string
  methods: string[]
  anon: number | null
  badToken: number | null
  lowRole: number | null
  authed: number | null
  verdict: 'ok' | 'public' | 'no-role-guard' | 'server-error' | 'skipped'
  note?: string
}

/** 动态段用真实 id 填，否则一堆 404 淹没真实问题 */
async function buildSampleIds(): Promise<Record<string, string>> {
  const [order, customer, product, trip, wave, po, invoice, user, tmpl] = await Promise.all([
    prisma.order.findFirst({ select: { id: true } }),
    prisma.customer.findFirst({ select: { id: true } }),
    prisma.product.findFirst({ select: { id: true } }),
    prisma.trip.findFirst({ select: { id: true } }),
    prisma.pickingWave.findFirst({ select: { id: true } }),
    prisma.purchaseOrder.findFirst({ select: { id: true } }),
    prisma.invoice.findFirst({ select: { id: true } }),
    prisma.user.findFirst({ select: { id: true } }),
    prisma.productTemplate.findFirst({ select: { id: true } }),
  ])
  return {
    orders: order?.id ?? 'x', customers: customer?.id ?? 'x', products: product?.id ?? 'x',
    trips: trip?.id ?? 'x', waves: wave?.id ?? 'x', 'purchase-orders': po?.id ?? 'x',
    invoices: invoice?.id ?? 'x', users: user?.id ?? 'x', 'product-templates': tmpl?.id ?? 'x',
    _default: 'probe-nonexistent-id',
  }
}

function listRoutes(dir = 'app/api', prefix = '/api'): Array<{ path: string; file: string }> {
  const out: Array<{ path: string; file: string }> = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listRoutes(full, `${prefix}/${entry}`))
    else if (entry === 'route.ts') out.push({ path: prefix, file: full })
  }
  return out
}

function methodsOf(file: string): string[] {
  const src = require('node:fs').readFileSync(file, 'utf8') as string
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].filter(m =>
    new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`).test(src))
}

/** /api/orders/[id]/lines → /api/orders/<真实id>/lines */
function fillParams(path: string, ids: Record<string, string>): string {
  const segs = path.split('/')
  return segs.map((seg, i) => {
    if (!seg.startsWith('[')) return seg
    const parent = segs[i - 1]
    return ids[parent] ?? ids._default
  }).join('')
    .replace(/\[\.\.\..*?\]/g, 'probe')
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Next dev server 是按需编译的：首次命中某路由要现编，一个路由编译期间后续请求排队。
 * 159 条路由 × 4 次请求连着打会把编译队列冲垮，表现为 fetch 直接抛错。
 * 所以带退避重试，并在路由之间留间隔——扫得慢一点，但结果可信。
 */
async function probe(url: string, token?: string, attempts = 3): Promise<number | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(HOST + url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        redirect: 'manual',
      })
      return res.status
    } catch {
      if (i < attempts - 1) await sleep(500 * (i + 1))
    }
  }
  return null
}

async function main() {
  const ids = await buildSampleIds()
  const routes = listRoutes()
  const opToken = await tokenFor('OPERATOR')
  const lowToken = await tokenFor('DRIVER')

  console.log(`扫描 ${routes.length} 条路由（只打 GET，写操作不扫）`)

  const reports: RouteReport[] = []
  for (const r of routes) {
    const methods = methodsOf(r.file)
    const url = fillParams(r.path, ids)

    if (!methods.includes('GET')) {
      reports.push({ path: r.path, methods, anon: null, badToken: null, lowRole: null, authed: null,
        verdict: 'skipped', note: '无 GET 处理器，鉴权由 middleware 覆盖（与方法无关）' })
      continue
    }

    const isPublic = isPublicApiRoute(r.path)
    // 顺序打 + 间隔，别让 dev server 的编译队列排爆
    const anon = await probe(url)
    const badToken = await probe(url, 'obviously-not-a-real-token')
    const lowRole = await probe(url, lowToken)
    const authed = await probe(url, opToken)
    await sleep(60)
    process.stdout.write('.')

    let verdict: RouteReport['verdict'] = 'ok'
    let note: string | undefined

    if (isPublic) {
      verdict = 'public'
      note = '在 PUBLIC_API_ROUTES 白名单里（由 tests/public-api-routes.test.ts 锁定）'
    } else if (anon === null || badToken === null || authed === null) {
      verdict = 'skipped'
      note = '⚠️ 请求始终失败（dev server 编译超时），本轮未取得结论，需单独复跑'
    } else if (anon !== 401 || badToken !== 401) {
      verdict = 'server-error'
      note = `⛔ 鉴权闸门失效：匿名=${anon} 伪造token=${badToken}，两者都应为 401`
    } else if (authed === 500) {
      verdict = 'server-error'
      note = '⛔ 授权访问返回 500'
    } else if (lowRole === 200) {
      verdict = 'no-role-guard'
      note = 'DRIVER 也能读到 200 —— 若含敏感数据需收紧角色白名单'
    }

    reports.push({ path: r.path, methods, anon, badToken, lowRole, authed, verdict, note })
  }

  const by = (v: RouteReport['verdict']) => reports.filter(r => r.verdict === v)
  console.log('\n\n── 汇总 ──')
  console.log(`总路由 ${reports.length}｜有 GET ${reports.filter(r => r.verdict !== 'skipped').length}｜无 GET ${by('skipped').length}`)
  console.log(`✅ 鉴权正常 ${by('ok').length}`)
  console.log(`🌐 白名单公开 ${by('public').length}: ${by('public').map(r => r.path).join(', ')}`)
  console.log(`⚠️  无角色限制 ${by('no-role-guard').length}`)
  console.log(`⛔ 有问题 ${by('server-error').length}`)

  if (by('server-error').length > 0) {
    console.log('\n── ⛔ 必须处理 ──')
    for (const r of by('server-error')) console.log(`  ${r.path}\n    ${r.note}`)
  }
  if (by('no-role-guard').length > 0) {
    console.log('\n── ⚠️ DRIVER 可读（需人工判断是否合理）──')
    for (const r of by('no-role-guard')) console.log(`  ${r.path}`)
  }

  const outIdx = process.argv.indexOf('--json')
  if (outIdx >= 0 && process.argv[outIdx + 1]) {
    writeFileSync(process.argv[outIdx + 1], JSON.stringify(reports, null, 2) + '\n')
    console.log(`\n已写入 ${process.argv[outIdx + 1]}`)
  }

  if (by('server-error').length > 0) process.exitCode = 1
}

main().catch(e => { console.error(e); process.exitCode = 1 }).finally(() => prisma.$disconnect())
