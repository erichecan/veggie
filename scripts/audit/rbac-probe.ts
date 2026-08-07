/**
 * 权限可达性探针
 * ============================================================================
 * 为每个角色签发 token，遍历全部 API 路由，产出「角色 × 端点 → 状态码」矩阵。
 *
 * 用途：整改权限前后各跑一次，diff 一眼看出哪些格子从 200 变成了 403 ——
 * 既能确认漏洞堵上了，也能发现**误伤**（某岗位本该能用的接口被挡了）。
 *
 * 用法：
 *   BASE=http://167.99.86.19 JWT_SECRET=xxx npx tsx scripts/audit/rbac-probe.ts
 *   BASE=... JWT_SECRET=... npx tsx scripts/audit/rbac-probe.ts --save   # 写入快照
 *
 * ⛔ 安全约束（血的教训）：
 *   - **POST 一律不探**。2026-08-06 审计时探 `POST /api/pricelists`，返回 201 ——
 *     它真的创建了一条价格表，事后得去生产库里删。POST 的可达性改用静态分析
 *     （看路由源码里有没有 allowedRoles），不实际调用。
 *   - PUT/PATCH/DELETE 只打不存在的 id，判「403 = 有角色闸」而不看业务结果。
 *   - 全程只读，不写任何数据。
 */
import { createHmac } from 'node:crypto'
import { readdirSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { scanApiHandlers } from '../../lib/route-gate-scan'

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000'
const SECRET = process.env.JWT_SECRET
const SAVE = process.argv.includes('--save')
const SNAPSHOT = 'scripts/audit/rbac-snapshot.json'

if (!SECRET) {
  console.error('缺少 JWT_SECRET。用法：BASE=... JWT_SECRET=... npx tsx scripts/audit/rbac-probe.ts')
  process.exit(1)
}

/** 被测角色。每个角色一个虚构用户 —— 探针不依赖库里恰好存在某个角色的账号。 */
const ROLES = [
  'RESTAURANT', 'DRIVER', 'PICKER', 'SORTER', 'WAREHOUSE',
  'SALES', 'FINANCE', 'OPERATOR', 'BOSS', 'DISPATCH',
] as const

const b64 = (b: Buffer | string) =>
  Buffer.from(b).toString('base64url')

function signToken(role: string): string {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const payload = b64(JSON.stringify({
    userId: `probe-${role.toLowerCase()}`,
    email: `probe-${role.toLowerCase()}@probe.local`,
    name: `探针-${role}`,
    role,
    roles: [role],
    // RESTAURANT 必须带 customerId，否则客户门户会因为查不到客户而 403，
    // 那样就分不清「被权限挡住」还是「数据不全」
    customerId: role === 'RESTAURANT' ? 'cust_001' : null,
    iat: now,
    exp: now + 3600,
  }))
  const sig = createHmac('sha256', SECRET!).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}

/** 扫出全部 API 路由及其 HTTP 方法 */
function collectRoutes(dir = 'app/api'): { route: string; verbs: string[]; src: string }[] {
  const out: { route: string; verbs: string[]; src: string }[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (name !== 'route.ts') continue
      const src = readFileSync(p, 'utf8')
      const verbs = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\s*\(/g)].map(m => m[1])
      if (verbs.length === 0) continue
      // app/api/orders/[id] → /api/orders/[id]
      out.push({ route: '/' + d.replace(/^app\//, ''), verbs, src })
    }
  }
  walk(dir)
  return out.sort((a, b) => a.route.localeCompare(b.route))
}

/** 动态段填一个必然不存在的值 —— 只为触达路由，不碰真实记录 */
const fillParams = (route: string) => route.replace(/\[\.\.\.[^\]]+\]|\[[^\]]+\]/g, 'rbac-probe-nonexistent')

async function probe(url: string, method: string, token: string): Promise<number> {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === 'PUT' || method === 'PATCH' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'PUT' || method === 'PATCH' ? { body: '{}' } : {}),
      signal: AbortSignal.timeout(60_000),
    })
    return res.status
  } catch {
    return 0   // 超时/网络错误
  }
}

async function main() {
  const routes = collectRoutes()
  const tokens = Object.fromEntries(ROLES.map(r => [r, signToken(r)]))
  const matrix: Record<string, Record<string, number | string>> = {}

  // POST 的静态判定统一走 lib/route-gate-scan —— 这里原本自带一条正则，
  // 只认 `}, ['X'])` 内联数组写法，把 5 处用具名常量的路由误报成 NO-GATE，
  // 还被注释里的 `1)` 骗过括号配平。检测器只留一份，修一次到处对。
  const gates = new Map(scanApiHandlers().map(h => [`${h.verb} ${h.route}`, h.gate]))

  let done = 0
  for (const { route, verbs } of routes) {
    for (const verb of verbs) {
      const key = `${verb} ${route}`
      matrix[key] = {}
      for (const role of ROLES) {
        if (verb === 'POST') {
          // 不实际调用。静态看这个 handler 有没有角色闸，以及闸里有没有这个角色。
          const g = gates.get(key)
          matrix[key][role] =
            g?.kind === 'roles' ? (g.roles.includes(role) ? 'allow' : 'deny')
            : g?.kind === 'cronSecret' ? 'cron'
            : 'NO-GATE'
        } else {
          matrix[key][role] = await probe(BASE + fillParams(route), verb, tokens[role])
        }
      }
      done++
      if (done % 20 === 0) process.stderr.write(`  …${done} 个 handler\n`)
    }
  }

  if (SAVE) {
    writeFileSync(SNAPSHOT, JSON.stringify(matrix, null, 2) + '\n')
    console.log(`快照已写入 ${SNAPSHOT}（${Object.keys(matrix).length} 个 handler）`)
    return
  }

  // 摘要：每个角色能读到多少个「非客户门户」的 GET
  console.log('\n════ 各角色可达的内部 GET 接口数（越少越好，RESTAURANT 应为 0）════')
  for (const role of ROLES) {
    const reachable = Object.entries(matrix).filter(([k, v]) =>
      k.startsWith('GET ') && !k.includes('/customer-portal') && !k.includes('/auth/') &&
      !k.includes('/health') && v[role] === 200,
    )
    console.log(`  ${role.padEnd(12)} ${String(reachable.length).padStart(3)} 个`)
  }

  if (existsSync(SNAPSHOT)) {
    const prev = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
    const diffs: string[] = []
    for (const [k, row] of Object.entries(matrix)) {
      for (const [role, val] of Object.entries(row)) {
        const before = prev[k]?.[role]
        if (before !== undefined && before !== val) diffs.push(`  ${k} [${role}] ${before} → ${val}`)
      }
    }
    console.log(`\n════ 与快照的差异（${diffs.length} 处）════`)
    console.log(diffs.length ? diffs.join('\n') : '  无变化')
    if (diffs.length) process.exitCode = 1
  } else {
    console.log(`\n（无快照。跑 --save 生成基线）`)
  }
}

main()
