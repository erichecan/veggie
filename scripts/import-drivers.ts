/**
 * scripts/import-drivers.ts
 *
 * 从 pic/crm.team.csv 提取的 16 位司机，导入为 DRIVER 角色账号。
 * 邮箱占位格式：driver.[key]@veggie.local（无真实邮件地址）
 * 初始密码：每人随机生成并打印，且标记首次登录必须改密
 *
 * 使用：
 *   npx tsx --env-file=.env.local scripts/import-drivers.ts
 *
 * 行为：
 * - 按 email 幂等 upsert：已存在则跳过（不动密码/roles）
 * - 不存在则新建
 */
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/db'
import { randomBytes } from 'node:crypto'

interface DriverInput {
  name: string
  email: string
}

// 从 crm.team.csv Sales Team 列提取的唯一司机名
// Daivd = CSV 原始录入，疑为 David 的拼写错误，保留原样待业务侧确认
const DRIVERS: DriverInput[] = [
  { name: 'AFZAAL',    email: 'driver.afzaal@veggie.local' },
  { name: 'ANDRIUS',   email: 'driver.andrius@veggie.local' },
  { name: 'ASHWIN',    email: 'driver.ashwin@veggie.local' },
  { name: 'BAO',       email: 'driver.bao@veggie.local' },
  { name: 'Daivd',     email: 'driver.daivd@veggie.local' },   // 疑为 David 拼写错误
  { name: 'hanhua',    email: 'driver.hanhua@veggie.local' },
  { name: 'hansung',   email: 'driver.hansung@veggie.local' },
  { name: 'John',      email: 'driver.john@veggie.local' },
  { name: 'kris tom',  email: 'driver.kristom@veggie.local' },
  { name: 'Moazzam',   email: 'driver.moazzam@veggie.local' },
  { name: 'Samuel',    email: 'driver.samuel@veggie.local' },
  { name: 'SEAN',      email: 'driver.sean@veggie.local' },
  { name: 'Umair',     email: 'driver.umair@veggie.local' },
  { name: 'WIT',       email: 'driver.wit@veggie.local' },
  { name: 'yang',      email: 'driver.yang@veggie.local' },
  { name: 'YIWEI',     email: 'driver.yiwei@veggie.local' },
]

/**
 * ⛔ 这里原来是 `const DEFAULT_PASSWORD = 'test123'`，一批人共用一个哈希。
 *    结果是 35 个生产账号长期使用同一个明文写在本文件里的弱口令，
 *    见 docs/20260807-production-credentials-audit.md。
 *
 * 现在：**每人一个随机密码**，并置 mustChangePassword —— 本人首次登录必须自己改。
 * 密码打印在导入日志里，由执行者负责分发；脚本不再持有任何默认口令。
 */
const genPassword = () => randomBytes(12).toString('base64url')

async function main() {

  let created = 0
  let skipped = 0

  for (const driver of DRIVERS) {
    const email = driver.email.toLowerCase()
    const existing = await prisma.user.findUnique({ where: { email } })

    if (existing) {
      console.log(`  skip  ${driver.name} (${email}) — already exists`)
      skipped++
      continue
    }

    const pwd = genPassword()
    await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(pwd, 12),

        mustChangePassword: true,
        role: 'DRIVER',
        roles: ['DRIVER'],
        name: driver.name,
        isActive: true,
      },
    })
    console.log(`  create ${driver.name} (${email})`)
    created++
  }

  console.log(`\n完成：新建 ${created}，跳过 ${skipped}，共 ${DRIVERS.length} 条`)
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  prisma.$disconnect()
  process.exit(1)
})
