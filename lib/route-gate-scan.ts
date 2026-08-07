/**
 * 扫描 app/api 下每个 handler 的「角色闸」状态。
 *
 * 供 tests/api-write-gates.test.ts 与 scripts/audit/rbac-probe.ts 共用 ——
 * 两边各写一份正则的话，一边修了另一边还是错，而这正是 2026-08-06 审计
 * 报「99 个 handler 没有 allowedRoles」时踩的坑：当时的正则只认
 * `}, ['OPERATOR'])` 这一种写法，凡是把角色抽成具名常量
 * （`}, STOCK_TAKE_ROLES)`，仓库/备份/质检等 5 处就是这么写的）一律被误报成"没闸"。
 * **检测器的假阴性会让整改清单虚高，也会让真正的漏网之鱼淹没在噪音里。**
 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Gate =
  | { kind: 'roles'; roles: string[] }      // withAuth(..., [...]) 或 withAuth(..., ROLES)  ← 旧写法
  | { kind: 'permission'; permissions: string[] }  // withAuth(..., { require: '…' })        ← 新写法
  | { kind: 'authOnly' }                    // 有 withAuth/requireAuth，但没有角色限制
  | { kind: 'cronSecret' }                  // 走 CRON_SECRET 共享密钥（定时任务，不走 JWT）
  | { kind: 'none' }                        // 连鉴权包装都没有（只靠 middleware 兜底）

export interface HandlerInfo {
  route: string          // /api/orders/[id]
  verb: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  gate: Gate
  file: string
}

const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

/**
 * 从 i 处跳过一段「不该参与语法计数」的内容（注释、字符串、模板串），
 * 返回跳过后的新下标；不是这类内容则返回 i 本身。
 *
 * ⛔ 注释必须跳。第一版没跳，结果 `// 1) 服务端权威定价` 里的那个右括号
 * 把深度计成了负数，`/api/orders` 与 `/api/waves` 的 POST 双双被误判成"没有角色闸"。
 * 同一个坑还让第一版的批量改写脚本把角色数组插进了注释里 —— 语法合法、
 * tsc 与测试全绿，但那道闸根本不存在。**这类改写必须回扫验证，不能只看编译通过。**
 */
function skipNonCode(src: string, i: number): number {
  const c = src[i]
  if (c === '/' && src[i + 1] === '/') {
    const nl = src.indexOf('\n', i)
    return nl === -1 ? src.length : nl
  }
  if (c === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2)
    return end === -1 ? src.length : end + 2
  }
  if (c === '"' || c === "'" || c === '`') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue }
      if (src[j] === c) return j + 1
    }
    return src.length
  }
  return i
}

/** 跳过字符串与注释后做括号配平 */
function matchParen(src: string, open: number): number {
  let depth = 0
  let i = open
  while (i < src.length) {
    const skipped = skipNonCode(src, i)
    if (skipped !== i) { i = skipped; continue }
    const c = src[i]
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return i }
    i++
  }
  return -1
}

/** 顶层逗号分段（用于取 withAuth 的第三个参数） */
function splitArgs(inner: string): string[] {
  const out: string[] = []
  let depth = 0, start = 0, i = 0
  while (i < inner.length) {
    const skipped = skipNonCode(inner, i)
    if (skipped !== i) { i = skipped; continue }
    const c = inner[i]
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (c === ',' && depth === 0) { out.push(inner.slice(start, i)); start = i + 1 }
    i++
  }
  out.push(inner.slice(start))
  return out
}

/**
 * 从第三个参数解析权限点：`{ require: 'x.y.z' }` 或 `{ require: ['a','b'] }`。
 * 这是 20260807 起的新写法，取代按角色写死的 allowedRoles。
 */
function parsePermissions(arg: string): string[] | null {
  const m = arg.match(/\brequire\s*:\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/)
  if (!m) return null
  return [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] ?? x[2])
}

/** 从第三个参数解析角色：可能是内联数组，也可能是本文件里的具名常量 */
function parseRoles(arg: string, src: string): string[] | null {
  const inline = arg.match(/\[([^\]]*)\]/)
  if (inline) return [...inline[1].matchAll(/'([A-Z_]+)'|"([A-Z_]+)"/g)].map(m => m[1] ?? m[2])
  const ident = arg.trim().match(/^([A-Za-z_$][\w$]*)$/)
  if (!ident) return null
  const decl = src.match(new RegExp(`(?:const|let|var)\\s+${ident[1]}\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]`))
  if (!decl) return null
  return [...decl[1].matchAll(/'([A-Z_]+)'|"([A-Z_]+)"/g)].map(m => m[1] ?? m[2])
}

export function scanApiHandlers(dir = 'app/api'): HandlerInfo[] {
  const out: HandlerInfo[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (name !== 'route.ts') continue
      const src = readFileSync(p, 'utf8')
      const route = '/' + d.replace(/^app\//, '')
      for (const verb of VERBS) {
        const m = src.match(new RegExp(`export async function ${verb}\\s*\\(`))
        if (!m || m.index === undefined) continue
        // handler 体 = 从这里到下一个 export async function
        const after = src.slice(m.index + m[0].length)
        const nextIdx = after.search(/export async function (GET|POST|PUT|PATCH|DELETE)\s*\(/)
        const body = nextIdx === -1 ? after : after.slice(0, nextIdx)
        const wIdx = body.search(/\bwithAuth(?:Cached)?\(|\bwithCachedAuth\(/)
        if (wIdx === -1) {
          const gate: Gate =
            /CRON_SECRET/.test(body) ? { kind: 'cronSecret' }
            : /\brequireAuth\(/.test(body) ? { kind: 'authOnly' }
            : { kind: 'none' }
          out.push({ route, verb, file: p, gate })
          continue
        }
        const abs = m.index + m[0].length + wIdx
        const open = src.indexOf('(', abs)
        const close = matchParen(src, open)
        const args = close === -1 ? [] : splitArgs(src.slice(open + 1, close))
        const third = args.length >= 3 ? args.slice(2).join(',') : null
        const perms = third ? parsePermissions(third) : null
        if (perms && perms.length) {
          out.push({ route, verb, file: p, gate: { kind: 'permission', permissions: perms } })
          continue
        }
        const roles = third ? parseRoles(third, src) : null
        out.push({ route, verb, file: p, gate: roles && roles.length ? { kind: 'roles', roles } : { kind: 'authOnly' } })
      }
    }
  }
  walk(dir)
  return out.sort((a, b) => (a.route + a.verb).localeCompare(b.route + b.verb))
}

export const isWrite = (verb: string) => verb !== 'GET'
