/**
 * 检测「装饰性权限点」—— 配置页上勾得动、但没有任何判定会读的假开关
 * ============================================================================
 * 为什么这类东西比缺权限点更糟：管理员在界面上把某个开关关掉，以为限制住了，
 * 实际那个动作照做不误。**它给的是虚假的安全感。**
 *
 * 判定：一个权限点若既不出现在 route-map 的路由规则里，也不在任何源码里被
 * 字符串引用（`require:'x'` / `hasPerm('x')` 等），即判为假开关。
 *
 * ⚠️ 这个数字随代码演进而变，**不要引用历史结论**：台账里曾记「8 个」，
 * 20260811 实测为 13 个。要用就当场跑一次。
 *
 * 用法：npx tsx scripts/rbac/detect-inert-permissions.ts
 */
import { PERMISSIONS } from '../../lib/rbac/catalog'
import { API_ROUTE_RULES, PAGE_ROUTE_RULES } from '../../lib/rbac/route-map'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 递归收集源码文本，用于查权限点是否被任何判定引用 */
function collect(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (['node_modules', '.next', '.git', 'generated'].includes(e)) continue
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) collect(p, acc)
    else if (/\.tsx?$/.test(e)) acc.push(readFileSync(p, 'utf-8'))
  }
  return acc
}

const srcs = [...collect('app'), ...collect('lib'), ...collect('components')].join('\n')
const routeIds = new Set<string>()
for (const r of [...API_ROUTE_RULES, ...PAGE_ROUTE_RULES]) {
  const perm = (r as { permission?: string | string[] }).permission
  if (typeof perm === 'string') routeIds.add(perm)
  else if (Array.isArray(perm)) perm.forEach(x => routeIds.add(x))
}

const inert: string[] = []
for (const p of PERMISSIONS) {
  if (routeIds.has(p.id)) continue
  // 在源码里被字符串引用（require:'x' / hasPerm('x') 等）也算有效
  if (srcs.includes(`'${p.id}'`) || srcs.includes(`"${p.id}"`)) continue
  inert.push(p.id)
}
console.log(`权限点总数: ${PERMISSIONS.length}`)
console.log(`被路由/代码引用: ${PERMISSIONS.length - inert.length}`)
console.log(`⚠️ 无任何判定引用（假开关）: ${inert.length}`)
if (inert.length) console.log(inert.map(x => '   · ' + x).join('\n'))
