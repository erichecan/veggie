/**
 * scripts/import-drivers.ts
 *
 * 从 pic/crm.team.csv 提取的 16 位司机，导入为 DRIVER 角色账号。
 * 邮箱占位格式：driver.[key]@veggie.local（无真实邮件地址）
 * 初始密码：test123
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

const DEFAULT_PASSWORD = 'test123'

async function main() {
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12)

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

    await prisma.user.create({
      data: {
        email,
        passwordHash,
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
