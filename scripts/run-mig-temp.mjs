// 一次性应用 20260425_add_order_code_creator 迁移的临时脚本。
// 使用场景：本地或 CI 环境因网络原因无法跑 `prisma migrate deploy` 时备用。
// 用法：node scripts/run-mig-temp.mjs
// 正常情况下请使用：npm run db:migrate

import { neon } from '@neondatabase/serverless'
import fs from 'node:fs'

const env = fs.readFileSync('.env.local', 'utf8')
const url = env.match(/DATABASE_URL="([^"]+)"/)[1]
const sql = neon(url)

const stmts = [
  `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "code" TEXT`,
  `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "createdById" TEXT`,
  `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "createdByName" TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Order_code_key" ON "Order"("code")`,
  `CREATE INDEX IF NOT EXISTS "Order_createdById_idx" ON "Order"("createdById")`,
]
for (const s of stmts) {
  await sql.query(s)
  console.log('OK:', s.slice(0, 80))
}

const fkRes = await sql.query(`SELECT 1 FROM pg_constraint WHERE conname = 'Order_createdById_fkey'`)
if (fkRes.length === 0) {
  await sql.query(
    `ALTER TABLE "Order" ADD CONSTRAINT "Order_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
  )
  console.log('OK: added FK Order_createdById_fkey')
} else {
  console.log('SKIP: FK Order_createdById_fkey already exists')
}

await sql.query(
  `INSERT INTO _prisma_migrations(id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
   VALUES (gen_random_uuid()::text, 'manual-cli', NOW(), '20260425_add_order_code_creator', NULL, NULL, NOW(), 1)
   ON CONFLICT (id) DO NOTHING`,
)
console.log('Migration recorded in _prisma_migrations')
