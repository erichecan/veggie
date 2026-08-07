/**
 * 生成「把系统角色的权限重置成 seed 当前内容」的迁移。
 * ============================================================================
 * 用途：修正已经写进生产库的错误权限。
 *
 * 20260807 的实际场景：T1 的推导算法最初写成 `Allowed = 全集 − Forbidden`，
 * 没有任何 handler 引用的权限点因此落到了**所有角色**头上 —— 生产库里 12 个角色
 * 全都带着 system.rbac.manage（司机能改老板的权限）。算法修好后，库里的数据
 * 还是旧的，必须显式重置。
 *
 * ⚠️ 这个迁移会**覆盖**管理员在配置页上做过的调整。只有在配置页尚未上线、
 * 确定无人调整过的时候才能用。之后再要改预置角色的权限，应当走配置页。
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'

const seed = JSON.parse(readFileSync('prisma/seed-rbac.json', 'utf-8')) as {
  roles: Array<{ code: string; permissions: string[]; dataScope: string }>
}
const q = (s: string) => `'${s.replace(/'/g, "''")}'`
const arr = (xs: string[]) => `ARRAY[${xs.map(q).join(',')}]::TEXT[]`

const lines: string[] = []
lines.push('-- 重置系统角色的权限点（20260807 修正 T1 推导算法的 bug）')
lines.push('--')
lines.push('-- 背景：最初的推导写成 Allowed = 全集 − Forbidden，于是「没有任何接口引用的')
lines.push('-- 权限点」不会进任何人的禁止集，被发给了所有角色 —— 生产库里 12 个角色全都')
lines.push('-- 带着 system.rbac.manage，司机能改老板的权限。算法改成从 Needed 出发之后，')
lines.push('-- 库里的数据仍是旧的，必须显式重置。')
lines.push('--')
lines.push('-- ⚠️ 本迁移会覆盖预置角色的权限。执行时配置页尚未上线，确无人工调整。')
lines.push('')
for (const r of seed.roles) {
  lines.push(
    `UPDATE "AppRole" SET "permissions" = ${arr(r.permissions)}, ` +
      `"dataScope" = ${q(r.dataScope)}::"DataScope", "updatedAt" = NOW() ` +
      `WHERE "code" = ${q(r.code)} AND "isSystem" = true;`,
  )
}
lines.push('')
lines.push('-- 权限变了，作废所有人手里的 token（下次请求 401 → 重新登录）')
lines.push('UPDATE "User" SET "permVersion" = "permVersion" + 1;')
lines.push('')

const dir = 'prisma/migrations/20260807000002_rbac_reset_role_permissions'
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/migration.sql`, lines.join('\n'), 'utf-8')
console.log(`✅ ${dir}/migration.sql`)
for (const r of seed.roles) console.log(`   ${r.code.padEnd(16)} ${r.permissions.length} 个权限点  ${r.dataScope}`)
