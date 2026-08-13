/**
 * 把司机档位绑定到系统账号（台账 C4 查出的主数据缺口）
 * ============================================================================
 * 为什么必须有这一步：
 *
 * 「确认出发」时 `lib/trip-from-wave.ts` 用 `DriverSlot.userId` 作为行程的
 * `driverId`，司机端则按自己的用户 id 查行程。**档位没绑账号 → 行程 driverId 为空
 * → 司机端一条任务也看不到**。功能是好的，坏的是主数据 —— 但对司机来说结果一样。
 *
 * 实测：全新库里 3 个档位（AFZAAL / BAO / SEAN）的 userId 全为空。
 * 这是第四次撞上「只被人手配过、任何脚本都不填」的表（前三次：RBAC 角色权限、
 * 采购品类分组、SQL 视图），所以这次直接接进 `db:bootstrap`。
 *
 * ## 账号从哪来
 *
 * 按档位上的司机名找同名账号；找不到就建一个 DRIVER 账号：
 *   · 邮箱默认 `<名字小写去空格>@veggie.com`，可用 --mapping 覆盖成客户的真实邮箱
 *   · 初始密码是弱口令，且 **mustChangePassword = true** —— 司机首次登录除了改密
 *     什么都调不了。绝不给司机发一个我们知道密码的长期账号。
 *
 * ## 用在生产上
 *
 * 本脚本默认只允许打本机。要在客户环境跑，必须显式加 `--allow-remote`，
 * 并用 `--mapping` 给出**客户提供的真实邮箱**：
 *
 *   npx tsx --env-file=.env.prod scripts/seed/bind-driver-slots.ts --allow-remote \
 *     --mapping "BAO=bao@johnstonebros.ie,SEAN=sean@johnstonebros.ie" --apply
 *
 * 不加 `--apply` 是**预演**：只打印将要做什么，一个字都不写。
 *
 * 用法（测试库）：
 *   npx tsx --env-file=.env.test scripts/seed/bind-driver-slots.ts --apply
 */
import bcrypt from 'bcryptjs'
import { createPrismaClient } from '../../lib/prisma-factory'

/** 初始密码。配合 mustChangePassword，司机首次登录必须改掉 */
const INITIAL_PASSWORD = process.env.DRIVER_INITIAL_PASSWORD ?? 'Driver2026!'
const EMAIL_DOMAIN = process.env.DRIVER_EMAIL_DOMAIN ?? 'veggie.com'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const APPLY = process.argv.includes('--apply')
const ALLOW_REMOTE = process.argv.includes('--allow-remote')

/** `--mapping "BAO=a@b.com,SEAN=c@d.com"` → Map */
function parseMapping(): Map<string, string> {
  const raw = arg('mapping')
  const m = new Map<string, string>()
  if (!raw) return m
  for (const pair of raw.split(',')) {
    const [name, email] = pair.split('=').map(s => s.trim())
    if (name && email) m.set(name.toUpperCase(), email)
  }
  return m
}

/** 司机名 → 默认邮箱。只保留字母数字，避免中文名或空格拼出非法地址 */
function defaultEmail(driverName: string): string {
  const slug = driverName.toLowerCase().replace(/[^a-z0-9]/g, '')
  return `${slug || 'driver'}@${EMAIL_DOMAIN}`
}

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL 未设置。用 --env-file 指定环境文件。')
    process.exit(1)
  }
  const isLocal = /localhost|127\.0\.0\.1/.test(url)
  if (!isLocal && !ALLOW_REMOTE) {
    console.error('⛔ 目标库不是本机地址。本脚本会创建账号并改绑定，非本机需显式加 --allow-remote。')
    console.error(`   当前指向：${url.replace(/:\/\/[^@]*@/, '://***@')}`)
    process.exit(1)
  }
  if (!isLocal) {
    console.log('⚠️  正在对**非本机数据库**操作。请确认邮箱来自客户而不是默认拼出来的。\n')
  }

  const mapping = parseMapping()
  const prisma = createPrismaClient()

  try {
    const slots = await prisma.driverSlot.findMany({
      where: { archived: false },
      select: { id: true, timeOfDay: true, batchNum: true, driverName: true, userId: true },
      orderBy: [{ timeOfDay: 'asc' }, { batchNum: 'asc' }],
    })

    const pending = slots.filter(s => !s.userId)
    console.log(`档位共 ${slots.length} 个，其中未绑账号 ${pending.length} 个`)
    if (pending.length === 0) {
      console.log('✅ 全部已绑定，无需处理')
      return
    }

    const driverRole = await prisma.appRole.findUnique({ where: { code: 'driver' }, select: { id: true } })
    if (!driverRole) {
      console.log('⚠️  没找到 code=driver 的角色 —— 账号会建出来但没有 RBAC 绑定，')
      console.log('    先跑 scripts/rbac/apply-data-migrations.ts 再来。')
    }

    let created = 0, bound = 0, reused = 0
    for (const slot of pending) {
      const email = mapping.get(slot.driverName.toUpperCase()) ?? defaultEmail(slot.driverName)

      // 先按邮箱找，再按同名的 DRIVER 账号找 —— 两条都找不到才建新的。
      // 顺序不能反：同名重复在司机里很常见，邮箱才是唯一标识。
      let user = await prisma.user.findUnique({ where: { email }, select: { id: true, name: true, email: true } })
      if (!user) {
        const sameName = await prisma.user.findFirst({
          where: { name: slot.driverName, OR: [{ role: 'DRIVER' }, { roles: { has: 'DRIVER' } }] },
          select: { id: true, name: true, email: true },
        })
        if (sameName) { user = sameName; reused++ }
      } else reused++

      const label = `${slot.timeOfDay.toUpperCase()}-${slot.batchNum} ${slot.driverName}`
      if (!user) {
        if (!APPLY) {
          console.log(`  [预演] ${label} → 新建账号 ${email}（弱口令 + 强制改密）并绑定`)
          created++; bound++
          continue
        }
        user = await prisma.user.create({
          data: {
            email, name: slot.driverName, role: 'DRIVER', roles: ['DRIVER'],
            passwordHash: await bcrypt.hash(INITIAL_PASSWORD, 12),
            isActive: true,
            // ⛔ 不给司机一个我们知道密码的长期账号：首次登录除了改密什么都调不了
            mustChangePassword: true,
            ...(driverRole ? { roleLinks: { create: [{ roleId: driverRole.id }] } } : {}),
          },
          select: { id: true, name: true, email: true },
        })
        created++
        console.log(`  ✅ ${label} → 新建 ${email}`)
      } else if (!APPLY) {
        console.log(`  [预演] ${label} → 绑定到已有账号 ${user.email}`)
        bound++
        continue
      } else {
        console.log(`  ✅ ${label} → 复用已有账号 ${user.email}`)
      }

      await prisma.driverSlot.update({ where: { id: slot.id }, data: { userId: user.id } })
      bound++
    }

    console.log(`\n${APPLY ? '已处理' : '预演结果'}：新建账号 ${created} 个 · 复用 ${reused} 个 · 绑定档位 ${bound} 个`)
    if (!APPLY) {
      console.log('（这是预演，什么都没写。确认无误后加 --apply）')
    } else {
      const left = await prisma.driverSlot.count({ where: { archived: false, userId: null } })
      console.log(left === 0
        ? '✅ 所有在用档位都已绑定 —— 确认出发生成的行程会带上司机身份，司机端能看到任务'
        : `⚠️ 仍有 ${left} 个档位未绑定`)
      if (created > 0) {
        console.log(`\n新账号初始密码：${INITIAL_PASSWORD}（已置强制改密，司机首次登录必须改掉）`)
      }
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
