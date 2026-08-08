/**
 * 把还在用弱口令的账号标记为「必须先改密码」。
 * ============================================================================
 * 默认 **dry-run**，只打印不写库。确认无误后加 `--apply` 才真正执行。
 *
 * 为什么不写成 SQL 迁移：判定必须 bcrypt 逐个比对，SQL 做不了。
 * 试过按「重复的 passwordHash」推断（导入脚本算一次哈希复制给一批人），实测会出错 ——
 * 漏掉一个密码是 `123456` 的独立哈希账号，同时误判两个真的改过密码的账号。
 *
 * 用法：
 *   npx tsx scripts/security/flag-weak-passwords.ts            # 只看，不改
 *   npx tsx scripts/security/flag-weak-passwords.ts --apply    # 真的写库
 *   npx tsx scripts/security/flag-weak-passwords.ts --include-seed --apply
 *
 * 邮箱在输出里做了打码 —— 这份输出会被贴进对话和文档，没必要连带泄露完整名单。
 */
import bcrypt from 'bcryptjs'
import { prisma } from '../../lib/db'

/**
 * 已知泄露 / 弱口令字典。
 * 前两个是本项目自己造出来的（见文件头引用的两个脚本与 prisma/seed.ts），
 * 其余是最常见的几个 —— 导入时人手工填过的账号可能用了它们。
 */
const WEAK_PASSWORDS = [
  'test123',
  'Demo1234!',
  '123456',
  '12345678',
  'password',
  'admin',
  'admin123',
  '111111',
  'abc123',
  'veggie123',
]

/** 种子账号（*@veggie.com）默认不动 —— 它们走「换强密码」那条路，见台账 S3 */
const SEED_DOMAIN = '@veggie.com'

const apply = process.argv.includes('--apply')
const includeSeed = process.argv.includes('--include-seed')

const mask = (email: string) => email.replace(/^(.{2}).*(@.*)$/, '$1***$2')

async function main() {
  const users = await prisma.user.findMany({
    select: {
      id: true, email: true, name: true, isActive: true,
      passwordHash: true, mustChangePassword: true,
    },
    orderBy: { email: 'asc' },
  })

  const hits: Array<{ id: string; email: string; weak: string; already: boolean }> = []
  let skippedSeed = 0
  let clean = 0

  for (const u of users) {
    const isSeed = u.email.toLowerCase().endsWith(SEED_DOMAIN)
    if (isSeed && !includeSeed) { skippedSeed++; continue }

    const weak = WEAK_PASSWORDS.find((p) => bcrypt.compareSync(p, u.passwordHash))
    if (!weak) { clean++; continue }
    hits.push({ id: u.id, email: u.email, weak, already: u.mustChangePassword })
  }

  console.log(`\n共 ${users.length} 个账号`)
  console.log(`  弱口令：${hits.length}   已是自定义密码：${clean}` +
    (skippedSeed > 0 ? `   跳过的种子账号：${skippedSeed}（走 S3 换强密码）` : ''))

  if (hits.length > 0) {
    const byWeak = new Map<string, number>()
    for (const h of hits) byWeak.set(h.weak, (byWeak.get(h.weak) ?? 0) + 1)
    console.log('\n  按口令分布：')
    for (const [p, n] of [...byWeak].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${p.padEnd(12)} ${n} 个`)
    }
    console.log('\n  明细（邮箱已打码）：')
    for (const h of hits) {
      console.log(`    ${mask(h.email).padEnd(30)} ${h.weak.padEnd(12)}${h.already ? '（已标记）' : ''}`)
    }
  }

  const todo = hits.filter((h) => !h.already)
  if (todo.length === 0) {
    console.log('\n没有需要新增标记的账号。')
    return
  }

  if (!apply) {
    console.log(`\n[dry-run] 将给 ${todo.length} 个账号置 mustChangePassword=true。`)
    console.log('确认无误后加 --apply 执行。')
    return
  }

  const r = await prisma.user.updateMany({
    where: { id: { in: todo.map((h) => h.id) } },
    data: { mustChangePassword: true },
  })
  console.log(`\n✅ 已标记 ${r.count} 个账号，它们下次登录后必须先改密码才能使用系统。`)
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
