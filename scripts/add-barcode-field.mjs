/**
 * 一次性迁移脚本：给 ProductTemplate 表添加 barcode 字段
 * 运行方式：node scripts/add-barcode-field.mjs
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'

// 读取 .env 里的 DATABASE_URL
const envFile = resolve(process.cwd(), '.env')
const lines = readFileSync(envFile, 'utf-8').split('\n')
for (const line of lines) {
  const [key, ...rest] = line.split('=')
  if (key?.trim() === 'DATABASE_URL') {
    process.env.DATABASE_URL = rest.join('=').trim().replace(/^"/, '').replace(/"$/, '')
  }
}

const { neon } = await import('@neondatabase/serverless')
const sql = neon(process.env.DATABASE_URL)

try {
  await sql`ALTER TABLE "ProductTemplate" ADD COLUMN IF NOT EXISTS barcode TEXT`
  console.log('✅ barcode 字段已添加到 ProductTemplate 表')
} catch (e) {
  if (e.message?.includes('already exists')) {
    console.log('✅ barcode 字段已存在，无需操作')
  } else {
    console.error('❌ 迁移失败:', e.message)
    process.exit(1)
  }
}
