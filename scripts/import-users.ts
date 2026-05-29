/**
 * scripts/import-users.ts
 *
 * 一次性把"修改意见 1.0"截图里的 18 个销售/运营人员导入数据库。
 * 每个账号同时具备 OPERATOR + SALES 两个角色（roles[]），主角色 (role) 是 OPERATOR。
 * 初始密码：test123（参考项目现有测试账号习惯）。
 *
 * 使用：
 *   # 前置：确保 DB 已经有 User.roles 字段
 *   npx prisma db push        # 添加 roles 列 + Order 新字段
 *   npx prisma generate       # 重新生成 client（覆盖手工补丁）
 *
 *   npx tsx --env-file=.env.local scripts/import-users.ts
 *
 * 行为：
 * - 按 email 幂等 upsert：已存在的账号只补齐 roles[]，不动密码
 * - 不存在则新建，password=test123（bcrypt 12 轮）
 * - 全程打印进度 + 最终统计
 *
 * 安全：bcrypt 12 轮和 /api/auth/login 一致。
 */
import bcrypt from 'bcryptjs'
import { prisma } from '../lib/db'

interface UserInput {
  name: string
  email: string
}

const USERS: UserInput[] = [
  { name: 'Charles Jiang',           email: 'Charlesjiang11@gmail.com' },
  { name: 'Dunrui Liu',              email: 'liudunrui@gmail.com' },
  { name: 'Edwin',                   email: 'edwin@g.com' },
  { name: 'Hanhua Lin',              email: 'qqlive164@gmail.com' },
  { name: 'Hong Xia',                email: 'hongx1985@gmail.com' },
  { name: 'Hongyang Dong',           email: '543405923@qq.com' },
  { name: 'Hosea Hoo',               email: 'Hoseahooyi71@gmail.com' },
  { name: 'Hua Di',                  email: 'ouya08@hotmail.com' },
  { name: 'Hui Zhang',               email: 'huizhang7303@hotmail.com' },
  { name: 'Jialei Yin',              email: 'talktojialei@msn.com' },
  { name: 'Minjia Gao',              email: 'minjiagao@gmail.com' },
  { name: 'Minshou Jiang',           email: 'johnstoneveg@gmail.com' },
  { name: 'Tester Evelyn',           email: '1436104711@qq.com' },
  { name: 'Xiaohui Weng (Evelyn)',   email: 'xiaohui.weng.gao@gmail.com' },
  { name: 'Xiumei Chen',             email: 'chenxiumei0520@gmail.com' },
  { name: 'Yanan Zhou',              email: 'zhouyanan134@gmail.com' },
  { name: 'Yunzhi Yang',             email: 'yang19830830@gmail.com' },
  { name: 'Zhang Min',               email: 'z-m-cat@hotmail.com' },
]

const DEFAULT_PASSWORD = 'test123'
const PRIMARY_ROLE = 'OPERATOR'
const ROLES = ['OPERATOR', 'SALES']

async function main() {
  // email 在 DB 用小写存（login 也是 toLowerCase 后查）
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12)

  let created = 0
  let updated = 0
  let skipped = 0

  for (const u of USERS) {
    const email = u.email.trim().toLowerCase()
    const name = u.name.trim()

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      const currentRoles = (existing as unknown as { roles?: string[] }).roles ?? []
      const merged = Array.from(new Set([...currentRoles, ...ROLES]))
      const sameRoles =
        currentRoles.length === merged.length &&
        currentRoles.every((r) => merged.includes(r))
      if (sameRoles) {
        console.log(`  [skip]   ${email.padEnd(32)} 角色已是 ${merged.join('+')}`)
        skipped++
        continue
      }
      // 已存在：只补齐 roles[]，不重置密码
      await prisma.user.update({
        where: { id: existing.id },
        data: { roles: merged },
      })
      console.log(`  [update] ${email.padEnd(32)} roles -> ${merged.join('+')}`)
      updated++
      continue
    }

    await prisma.user.create({
      data: {
        name: name.slice(0, 100),
        email: email.slice(0, 200),
        passwordHash,
        role: PRIMARY_ROLE as never,
        roles: ROLES,
        isActive: true,
      },
    })
    console.log(`  [new]    ${email.padEnd(32)} ${name}  (pwd=${DEFAULT_PASSWORD})`)
    created++
  }

  console.log()
  console.log(`完成：新建 ${created}，更新 ${updated}，跳过 ${skipped}，共 ${USERS.length} 条`)
  console.log(`密码统一为：${DEFAULT_PASSWORD}`)
  console.log(`角色：${ROLES.join(' + ')}（主角色 ${PRIMARY_ROLE}）`)
}

main()
  .catch((e) => {
    console.error('[import-users] 失败：', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
