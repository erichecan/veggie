/**
 * 给无邮箱的餐馆客户批量建登录账号（20261021）
 * ============================================================================
 * 背景：618 个 isCustomer=true / isVendor=false 的真实餐馆客户从来没有邮箱，
 * 也就没有 User 账号，上不了自助下单客户门户。已有真实邮箱的客户不碰。
 *
 * 登录邮箱 = 客户名去空格/标点后全小写，拼上公司自己的邮件域名（纯登录用途，
 * 不是真实收件箱，不改 Customer.email —— 那个字段还有订单邮件发送兜底的用途，
 * 塞一个收不到信的假地址进去会污染那条路径，域名见下面 DOMAIN 常量）。
 * 同名客户（4 组）按名字出现顺序第二个开始加数字后缀：slug / slug2。
 *
 * 初始密码统一 888888（客户 20261021 拍板），配合 mustChangePassword=true——
 * 登录后除了改密码什么都调不了，改完自动解除，所以密码能统一这么简单。
 *
 * 排除：cmvf7d9p2021y01lho5ab48b1（"TEST CUSTOMER ONLY！！！"）——像测试/占位
 * 记录不是真餐馆，默认跳过不建账号，写进这条注释当假设，没有再跟用户确认。
 *
 * 用法：
 *   DRY_RUN=1 npx tsx scripts/backfill-restaurant-portal-logins-20261021.ts
 *   npx tsx scripts/backfill-restaurant-portal-logins-20261021.ts
 */
import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'

const DOMAIN = '@johnstonebros.ie'
const INITIAL_PASSWORD = '888888'
const EXCLUDE_CUSTOMER_IDS = new Set(['cmvf7d9p2021y01lho5ab48b1'])

const DRY = process.env.DRY_RUN === '1'

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

async function main() {
  // schema 里 Customer.email 是 String @default("")，Prisma 类型不让按 email:null 过滤；
  // 但之前核实 618 条时用的是 `email IS NULL OR email = ''`（生产库可能有历史脏 null），
  // 用原始 SQL 保持跟那次核实完全一致的判定口径
  const customers = await prisma.$queryRaw<{ id: string; name: string }[]>`
    SELECT id, name FROM "Customer"
    WHERE "isCustomer" = true AND "isVendor" = false AND (email IS NULL OR email = '')
    ORDER BY name ASC, id ASC
  `
  const targets = customers.filter(c => !EXCLUDE_CUSTOMER_IDS.has(c.id))
  console.log(`${DRY ? '[DRY RUN] ' : ''}目标客户 ${targets.length} 个（原始 ${customers.length} 个，排除 ${customers.length - targets.length} 个测试记录）`)

  const existingUserEmails = new Set(
    (await prisma.user.findMany({ select: { email: true } })).map(u => u.email.toLowerCase())
  )

  const passwordHash = await bcrypt.hash(INITIAL_PASSWORD, 12)
  const restaurantAppRole = await prisma.appRole.findUnique({ where: { code: 'restaurant' } })
  if (!restaurantAppRole) throw new Error('AppRole code=restaurant 不存在，权限位图会是空的，先停下检查')

  const usedSlugs = new Set<string>()
  const plan: { customerId: string; name: string; email: string }[] = []

  for (const c of targets) {
    const base = slugify(c.name)
    let slug = base
    let suffix = 2
    while (usedSlugs.has(slug) || existingUserEmails.has(`${slug}${DOMAIN}`)) {
      slug = `${base}${suffix}`
      suffix += 1
    }
    usedSlugs.add(slug)
    plan.push({ customerId: c.id, name: c.name, email: `${slug}${DOMAIN}` })
  }

  let created = 0
  for (const p of plan) {
    console.log(`  ${p.name} → ${p.email}`)
    if (DRY) continue

    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: p.name.slice(0, 100),
          email: p.email,
          passwordHash,
          role: 'RESTAURANT',
          roles: ['RESTAURANT'],
          customerId: p.customerId,
          isActive: true,
          pendingApproval: false,
          mustChangePassword: true,
        },
        select: { id: true },
      })
      await tx.userRoleLink.create({ data: { userId: user.id, roleId: restaurantAppRole.id } })
    })
    created += 1

    await writeLog({
      userId: 'system-backfill', userEmail: 'system-backfill', userName: '批量建号脚本',
      action: 'CREATE', resource: 'user-portal-login-backfill', resourceId: p.customerId,
      detail: `给无邮箱餐馆客户补建登录账号：${p.name} → ${p.email}（初始密码统一，mustChangePassword=true）`,
    })
  }

  console.log(`\n${DRY ? '[DRY RUN] 计划建号' : '已建号'} ${DRY ? plan.length : created} 个`)

  if (!DRY) {
    const leftRows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) FROM "Customer"
      WHERE "isCustomer" = true AND "isVendor" = false AND (email IS NULL OR email = '')
    `
    const left = Number(leftRows[0]?.count ?? 0)
    console.log(`验证：剩余无邮箱餐馆客户 ${left} 个（预期 = 被排除的测试记录数 ${EXCLUDE_CUSTOMER_IDS.size}）`)
  }
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
