/**
 * 合同功能核实探针 harness
 *
 * 用途：把「这个功能到底做没做」变成可重复执行的证据，而不是人工看代码下结论。
 *
 * 运行：npx tsx --env-file=.env.local scripts/audit/run.ts [--module 03] [--id M03-05] [--json]
 *
 * ⚠️ .env.local 直连生产库。写探针必须：
 *    1. 所有创建的记录带 PROBE_MARK 标记
 *    2. 在 finally 里删除自己创建的记录
 *    3. 绝不修改任何既有记录
 */
import { execSync } from 'node:child_process'
import { prisma } from '../../lib/db'
import { signToken } from '../../lib/auth'

export const PROBE_MARK = 'AUDIT-PROBE-20260802'
export const HOST = process.env.AUDIT_HOST || 'http://localhost:3000'

export type Verdict = 'done' | 'partial' | 'missing' | 'deferred'

export interface CheckResult {
  id: string
  module: string
  title: string
  verdict: Verdict
  /** 缺口说明——partial/missing 必填，写清「缺的是哪一块」 */
  gap?: string
  /** 可复现证据：命令、路由、行号、探针返回值 */
  evidence: string[]
  /** 与 2026-07-29 人工核实版的对比 */
  prev?: Verdict
}

export interface Check {
  id: string
  module: string
  title: string
  prev?: Verdict
  run: () => Promise<Omit<CheckResult, 'id' | 'module' | 'title' | 'prev'>>
}

const registry: Check[] = []

export function defineCheck(c: Check) {
  registry.push(c)
}

export function allChecks(): Check[] {
  return registry
}

// ─── token ──────────────────────────────────────────────────────────────────
const tokenCache = new Map<string, string>()

/** 为指定角色签一个真实可用的 token（复用生产库里已存在的用户，不新建账号） */
export async function tokenFor(role: string): Promise<string> {
  const cached = tokenCache.get(role)
  if (cached) return cached
  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true, roles: true, customerId: true, isActive: true },
  })
  const hit = users.find(u => {
    if (u.isActive === false) return false
    const rs = (Array.isArray(u.roles) && u.roles.length ? u.roles : [u.role]) as string[]
    return rs.includes(role)
  })
  if (!hit) throw new Error(`库里没有角色为 ${role} 的可用用户`)
  const token = await signToken({
    userId: hit.id,
    email: hit.email,
    role: String(hit.role),
    roles: (Array.isArray(hit.roles) && hit.roles.length ? hit.roles : [hit.role]) as string[],
    name: hit.name ?? '',
    customerId: hit.customerId ?? null,
  })
  tokenCache.set(role, token)
  return token
}

// ─── HTTP ───────────────────────────────────────────────────────────────────
export interface ApiResult {
  status: number
  ok: boolean
  body: unknown
  /** 便于写进 evidence 的一行摘要 */
  brief: string
}

export async function api(
  path: string,
  opts: { role?: string; method?: string; body?: unknown; noAuth?: boolean; rawToken?: string } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.rawToken) headers.Authorization = `Bearer ${opts.rawToken}`
  else if (!opts.noAuth) headers.Authorization = `Bearer ${await tokenFor(opts.role || 'OPERATOR')}`

  const res = await fetch(`${HOST}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: 'manual',
  })
  const text = await res.text()
  let body: unknown = text
  try { body = JSON.parse(text) } catch { /* 非 JSON 原样保留 */ }
  const brief = `${opts.method || 'GET'} ${path} → ${res.status} ${summarize(body)}`
  return { status: res.status, ok: res.ok, body, brief }
}

function summarize(body: unknown): string {
  if (body === null || body === undefined) return ''
  if (typeof body === 'string') return body.slice(0, 160).replace(/\s+/g, ' ')
  if (Array.isArray(body)) return `[array ${body.length}]`
  const o = body as Record<string, unknown>
  const keys = Object.keys(o)
  const counts = keys
    .filter(k => Array.isArray(o[k]))
    .map(k => `${k}[${(o[k] as unknown[]).length}]`)
  const head = counts.length ? counts.join(' ') : JSON.stringify(o).slice(0, 160)
  return `keys{${keys.slice(0, 8).join(',')}} ${head}`
}

// ─── 代码检索 ────────────────────────────────────────────────────────────────
/**
 * 在源码里检索关键词，返回命中文件与行。
 * 用于 missing 判定——必须给出「检索了哪些词、命中为零」的证据。
 */
/** 搜索范围：排除 node_modules 与 Prisma 生成物（后者内联了整份 schema，会污染所有检索） */
const DEFAULT_ROOTS = 'app lib components scripts prisma/schema.prisma'
const EXCLUDE = "grep -vE 'node_modules|lib/generated/'"

/**
 * --include 只在搜索目录时加。roots 若点名了具体文件（如 prisma/schema.prisma），
 * 加上 --include=*.ts 会把它整个过滤掉，导致「schema 里明明有这个字段却报 0 命中」。
 */
function includeFlags(roots: string): string {
  return /\.\w+(\s|$)/.test(roots) ? '' : '--include=*.ts --include=*.tsx'
}

export function grepCode(
  pattern: string,
  opts: { roots?: string; max?: number } = {},
): string[] {
  const roots = opts.roots || DEFAULT_ROOTS
  const cmd = `grep -rniE ${JSON.stringify(pattern)} ${roots} ${includeFlags(roots)} 2>/dev/null | ${EXCLUDE} | head -${opts.max || 12}`
  try {
    const out = execSync(cmd, { encoding: 'utf8', cwd: process.cwd(), shell: '/bin/bash' })
    return out.trim() ? out.trim().split('\n') : []
  } catch {
    return []
  }
}

/** 只要命中数，用于「检索为零」的批量取证 */
export function grepCount(pattern: string, roots = DEFAULT_ROOTS): number {
  const cmd = `grep -rniE ${JSON.stringify(pattern)} ${roots} ${includeFlags(roots)} 2>/dev/null | ${EXCLUDE} | wc -l`
  try {
    return parseInt(execSync(cmd, { encoding: 'utf8', shell: '/bin/bash' }).trim(), 10) || 0
  } catch {
    return 0
  }
}

/** 批量检索一组关键词，返回 {词: 命中数}，全零即 missing 的硬证据 */
export function grepMatrix(patterns: string[], roots?: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of patterns) out[p] = grepCount(p, roots)
  return out
}

export function fileExists(p: string): boolean {
  try {
    execSync(`test -e ${JSON.stringify(p)}`, { shell: '/bin/bash' })
    return true
  } catch {
    return false
  }
}

/** 列出匹配的文件路径（用于「有没有这个页面」这类判定） */
export function findFiles(glob: string): string[] {
  try {
    const out = execSync(`ls -1 ${glob} 2>/dev/null`, { encoding: 'utf8', shell: '/bin/bash' })
    return out.trim() ? out.trim().split('\n') : []
  } catch {
    return []
  }
}

/** schema.prisma 里有没有这个模型 */
export function hasModel(name: string): boolean {
  return grepCount(`^model ${name} `) > 0
}

/** 某模型有没有这个字段 */
export function modelField(model: string, field: string): string[] {
  const cmd = `awk '/^model ${model} /,/^}/' prisma/schema.prisma | grep -iE "${field}" | head -6`
  try {
    const out = execSync(cmd, { encoding: 'utf8', shell: '/bin/bash' })
    return out.trim() ? out.trim().split('\n').map(s => s.trim()) : []
  } catch {
    return []
  }
}

export { prisma }
