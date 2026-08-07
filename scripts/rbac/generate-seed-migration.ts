/**
 * 生成预置角色的**数据迁移** SQL。
 * ============================================================================
 * 为什么做成迁移而不是 seed 脚本：本项目的部署链路是
 * `push main → Actions → migrate deploy`，**不会跑 seed**。写成 seed 的话，
 * 部署完数据库里一个角色都没有，所有人权限为空 —— 平迁当场失败。
 *
 * 迁移做三件事，全部幂等（可重复执行）：
 *   1. 写入 Permission 表（catalog 的镜像）
 *   2. 写入 12 个预置 AppRole
 *   3. 把现有用户按 legacy role 关联到对应 AppRole
 *
 * 第 3 步是平迁的关键：现网 51 个账号的 `roles[]`（空则回退 `role`）要一一
 * 对应到预置角色，否则登录后权限集是空的。
 *
 * 用法：npx tsx scripts/rbac/generate-seed-migration.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { PERMISSIONS } from '../../lib/rbac/catalog'
import { readFileSync } from 'node:fs'

interface SeedRole {
  code: string
  legacyRole: string
  name: string
  isSystem: boolean
  dataScope: string
  permissions: string[]
}

const seed = JSON.parse(readFileSync('prisma/seed-rbac.json', 'utf-8')) as { roles: SeedRole[] }
const q = (s: string) => `'${s.replace(/'/g, "''")}'`
const arr = (xs: string[]) => `ARRAY[${xs.map(q).join(',')}]::TEXT[]`

const lines: string[] = []
lines.push('-- 可配置权限体系：预置数据（20260807）')
lines.push('-- 由 scripts/rbac/generate-seed-migration.ts 生成，不要手改。')
lines.push('-- 幂等：可重复执行。')
lines.push('')

lines.push('-- 1. 权限点目录（lib/rbac/catalog.ts 的镜像）')
for (const p of PERMISSIONS) {
  lines.push(
    `INSERT INTO "Permission" ("id","module","action","labelZh","labelEn","sortKey") VALUES ` +
      `(${q(p.id)},${q(p.module)},${q(p.action)},${q(p.labelZh)},${q(p.labelEn)},${p.sortKey}) ` +
      `ON CONFLICT ("id") DO UPDATE SET "module"=EXCLUDED."module","action"=EXCLUDED."action",` +
      `"labelZh"=EXCLUDED."labelZh","labelEn"=EXCLUDED."labelEn","sortKey"=EXCLUDED."sortKey";`,
  )
}
lines.push('')

lines.push('-- 2. 12 个预置角色。isSystem=true → 配置页里不可删除，但权限可改。')
lines.push('--    这里用 DO NOTHING 而不是 DO UPDATE：管理员在页面上调过的权限不该被下次部署冲掉。')
for (const r of seed.roles) {
  lines.push(
    `INSERT INTO "AppRole" ("id","code","name","description","isSystem","dataScope","permissions","createdAt","updatedAt") VALUES ` +
      `(${q('sysrole_' + r.code)},${q(r.code)},${q(r.name)},` +
      `${q('由 20260807 平迁自动生成，对应旧的 Role.' + r.legacyRole)},true,` +
      `${q(r.dataScope)}::"DataScope",${arr(r.permissions)},NOW(),NOW()) ` +
      `ON CONFLICT ("code") DO NOTHING;`,
  )
}
lines.push('')

lines.push('-- 3. 把现有用户挂到对应的预置角色上。')
lines.push('--    口径与 lib/auth.ts 的 effectiveRoles 一致：roles[] 非空时用它，否则回退单 role。')
lines.push('--    ⛔ 这一步不做的话，平迁后所有人权限集为空，等于全员被锁在门外。')
lines.push(`INSERT INTO "UserRoleLink" ("userId","roleId")`)
lines.push(`SELECT u."id", r."id"`)
lines.push(`FROM "User" u`)
lines.push(`JOIN LATERAL (`)
lines.push(`  SELECT CASE WHEN cardinality(u."roles") > 0 THEN u."roles"`)
lines.push(`              ELSE ARRAY[u."role"::TEXT] END AS effective`)
lines.push(`) e ON TRUE`)
lines.push(`JOIN LATERAL unnest(e.effective) AS role_name ON TRUE`)
lines.push(`JOIN "AppRole" r ON r."code" = lower(role_name)`)
lines.push(`ON CONFLICT ("userId","roleId") DO NOTHING;`)
lines.push('')

const dir = 'prisma/migrations/20260807000001_rbac_seed_system_roles'
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}/migration.sql`, lines.join('\n') + '\n', 'utf-8')
console.log(`✅ ${dir}/migration.sql`)
console.log(`   ${PERMISSIONS.length} 个权限点 · ${seed.roles.length} 个预置角色`)
