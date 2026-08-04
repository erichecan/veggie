/**
 * 订正脚本：存量中文订单码 → ASCII（运营-YYMMDD-NNN → OP-YYMMDD-NNN）
 *
 * 规则：非 ASCII code 的订单，按【创建者】重算 ASCII 前缀
 *   newInitials = getInitials(createdByName, 创建者 email)（与下单同一逻辑，DRY）
 *   newCode = newInitials + code 中第一个 '-' 起的剩余部分（保留日期+序号，不动）
 * 唯一性：newCode 若与任何现有 code 冲突（或多单撞同名）→ 跳过并列出，需人工处理。
 * 无法得到 ASCII 前缀（getInitials 兜底 'NA'）→ 跳过并列出。
 * 幂等：已是 ASCII 的 code 不动；跑第二遍无命中。
 *
 * 用法：
 *   node --import tsx -r dotenv/config scripts/fix-order-code-ascii.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/fix-order-code-ascii.ts dotenv_config_path=.env.local --apply    # 写库
 */
import { createPrismaClient } from '@/lib/prisma-factory'
import { getInitials } from '../lib/order-code'

const prisma = createPrismaClient()
const APPLY = process.argv.includes('--apply')
const isAscii = (s: string) => /^[\x00-\x7F]*$/.test(s)

async function main() {
  console.log(`\n=== 订单码 ASCII 化 (${APPLY ? 'APPLY 写库' : 'DRY-RUN 只读'}) ===\n`)

  const all = await prisma.order.findMany({ select: { id: true, code: true } })
  const existingCodes = new Set(all.map(o => o.code).filter(Boolean) as string[])
  const targets = all.filter(o => o.code && !isAscii(o.code)) as { id: string; code: string }[]
  console.log(`订单 ${all.length} 单，含中文 code ${targets.length} 单\n`)
  if (targets.length === 0) { console.log('无需订正。'); return }

  // 创建者 email
  const orders = await prisma.order.findMany({
    where: { id: { in: targets.map(t => t.id) } },
    select: { id: true, code: true, createdById: true, createdByName: true },
  })
  const creatorIds = [...new Set(orders.map(o => o.createdById).filter(Boolean) as string[])]
  const users = await prisma.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, email: true } })
  const emailById = new Map(users.map(u => [u.id, u.email]))

  const plan: { id: string; old: string; next: string }[] = []
  const skipped: { code: string; reason: string }[] = []
  const claimed = new Set<string>()

  for (const o of orders) {
    const code = o.code!
    const email = o.createdById ? emailById.get(o.createdById) ?? '' : ''
    const initials = getInitials(o.createdByName, email)
    if (initials === 'NA' || !isAscii(initials)) { skipped.push({ code, reason: `无法得到ASCII前缀(name=${o.createdByName}, email=${email || '无'})` }); continue }
    const dash = code.indexOf('-')
    const next = initials + (dash >= 0 ? code.slice(dash) : '')
    if (existingCodes.has(next) || claimed.has(next)) { skipped.push({ code, reason: `新码 ${next} 与现有冲突` }); continue }
    claimed.add(next)
    plan.push({ id: o.id, old: code, next })
  }

  console.log(`将订正 ${plan.length} 单：`)
  for (const p of plan) console.log(`  ${p.old}  →  ${p.next}`)
  if (skipped.length) {
    console.log(`\n跳过 ${skipped.length} 单（需人工）：`)
    for (const s of skipped) console.log(`  ${s.code}  — ${s.reason}`)
  }

  if (!APPLY) { console.log('\n=== DRY-RUN 结束，未写库。确认后加 --apply。===\n'); return }

  console.log('\n=== APPLY：写库 ===')
  let n = 0
  await prisma.$transaction(async (tx) => {
    for (const p of plan) { await tx.order.update({ where: { id: p.id }, data: { code: p.next } }); n++ }
  }, { timeout: 120_000 })
  console.log(`✅ 已订正 ${n} 单订单码。\n`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
