#!/usr/bin/env node
/**
 * 一次性给所有 API route 套上 serializeApi()。
 *
 * 规则：
 *   1. 如果还没 import serializeApi，加一行 import
 *   2. 把 `NextResponse.json(variableName)` 中的 variableName（不是 { error }）包起来
 *      - 具体来说，匹配 `NextResponse.json(xxx` 后面紧跟的是标识符（非 '{'、非 '(...)' 表达式）
 *      - 错误对象 { error: ... } 不动
 *      - 已经包过 serializeApi() 的不重复包
 *
 * 不处理的文件（已手动处理或不需要）：
 *   - 已包含 serializeApi 的文件
 *   - health/login/gdpr/delete/mfa 等不返回 Prisma 数据的
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(process.cwd(), 'app/api')

const FILES_TO_SKIP = new Set([
  'app/api/health/route.ts',                   // 只返 { status: 'ok' }
  'app/api/upload-image/route.ts',             // 只返 { url }
  'app/api/auth/login/route.ts',               // 已手动处理（MFA 逻辑）
  'app/api/auth/change-password/route.ts',
  'app/api/mfa/enroll/route.ts',               // 返回 secret/qr，结构明确
  'app/api/gdpr/export/route.ts',              // 已用自定义 normalize
  'app/api/gdpr/delete/route.ts',              // 只返 {status, message}
  'app/api/orders/last-price/route.ts',        // 只返 {price, orderId}
  'app/api/orders/bulk/route.ts',              // 只返 {ok, affected}
  'app/api/demo/reset/route.ts',
  'app/api/action-logs/route.ts',
])

function walk(dir, fileList = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, fileList)
    else if (entry.name === 'route.ts') fileList.push(full)
  }
  return fileList
}

const files = walk(ROOT)

let changed = 0
for (const file of files) {
  const rel = path.relative(path.resolve(process.cwd()), file)
  if (FILES_TO_SKIP.has(rel)) continue

  let src = fs.readFileSync(file, 'utf8')
  const before = src

  // 已经有 serializeApi 则跳过
  const hasSerializer = /from ['"]@\/lib\/api-serializer['"]/.test(src)

  // 1) 加 import（如果需要 + 还没有）
  let needImport = false

  // 2) 匹配 NextResponse.json( ) 包装：
  //    - 跳过明显的 { error/status/ok } 对象字面量
  //    - 跳过已经是 serializeApi(...) 的
  // 写法：用 regex 找 `NextResponse.json(X` 格式，X 是
  //    - 标识符（如 customer, invoice, order, pricelist, product, trip）
  //    - 或已序列化的对象 `{ data, total, ... }` 大对象字面量
  //    - 不是 `{ error: ... }` 单行小错误字面量
  //    - 不是 `{ status: 'ok', ... }` 状态字面量

  // 简单粗暴的办法：只处理调用时紧跟标识符的。例如：
  //   NextResponse.json(customer)            → wrap
  //   NextResponse.json(customers, { ... })  → wrap
  //   NextResponse.json({ error: '...' }, ...) → skip（因为是 {）
  //   NextResponse.json({ ok: true })         → skip
  //   NextResponse.json(serializeApi(x))      → skip（已包过）
  //   NextResponse.json(result.map(...))      → wrap（标识符表达式）

  // 匹配：NextResponse.json( followed by
  //   (?!serializeApi)   # 不是已经有 serializeApi
  //   (?!\s*\{)          # 不是紧跟对象字面量
  //   ([^,)]+)           # 捕获第一个参数（一直到 , 或 )）
  //
  // 这样会误匹配一些复杂表达式，但我们只看简单场景，足够。
  const pattern = /NextResponse\.json\(\s*(?!serializeApi)(?!\{)([A-Za-z_$][\w.$[\]]*(?:\(\))?)\s*(,|\))/g

  src = src.replace(pattern, (match, variable, tail) => {
    needImport = true
    return `NextResponse.json(serializeApi(${variable})${tail}`
  })

  if (needImport && !hasSerializer) {
    // 加到 withAuth 那行之后
    src = src.replace(
      /(import \{ withAuth \} from ['"]@\/lib\/auth['"]\n)/,
      `$1import { serializeApi } from '@/lib/api-serializer'\n`,
    )
    // 如果没有 withAuth import 就加在 db 后
    if (!/serializeApi/.test(src)) {
      src = src.replace(
        /(import \{ prisma \} from ['"]@\/lib\/db['"]\n)/,
        `$1import { serializeApi } from '@/lib/api-serializer'\n`,
      )
    }
  }

  if (src !== before) {
    fs.writeFileSync(file, src)
    changed++
    console.log('✓', rel)
  }
}

console.log(`\n共修改 ${changed} 个文件`)
