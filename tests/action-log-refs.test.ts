import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { REF_FIELDS, REF_FIELDS_WITHOUT_NAME } from '../lib/action-log-ref-fields'
import { FIELD_LABELS } from '../lib/action-log-i18n'
import { RULE_PRICE_FIELDS } from '../lib/pricelist-diff'

/**
 * 20261008 客户反馈：操作记录显示 `pricelistIds：["pl_51","pl_58"] → ["pl_51"]`。
 * 防回归：所有写进 ActionLog.changes 的 xxxId / xxxIds 字段，都必须
 *   1. 在 REF_FIELDS 登记指向哪张表(读日志时换成名字)，或显式列入 REF_FIELDS_WITHOUT_NAME；
 *   2. 在 FIELD_LABELS 有中英文字段名。
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.ts$/.test(f)) out.push(p)
  }
  return out
}

function trackedIdFields(): Map<string, string> {
  const found = new Map<string, string>()
  const idLike = /^[a-z][A-Za-z]*Ids?$/
  for (const file of walk('app/api')) {
    const src = readFileSync(file, 'utf8')
    // const XXX_TRACKED_FIELDS = [ ... ]
    for (const m of src.matchAll(/TRACKED_FIELDS[^=]*=\s*\[([\s\S]*?)\]/g)) {
      for (const k of m[1].matchAll(/'([A-Za-z]+)'/g)) if (idLike.test(k[1])) found.set(k[1], file)
    }
    // 直接写的 changes：{ fooId: { before: …, after: … } } / changes.fooId = { before
    for (const m of src.matchAll(/\b([a-z][A-Za-z]*Ids?)\s*[:=]\s*\{\s*before\b/g)) found.set(m[1], file)
  }
  for (const f of RULE_PRICE_FIELDS) if (idLike.test(f)) found.set(f, 'lib/pricelist-diff.ts')
  return found
}

test('操作记录里的 id 字段都登记了指向哪张表(否则用户看到的是一串 id)', () => {
  const missing = [...trackedIdFields()]
    .filter(([k]) => !(k in REF_FIELDS) && !REF_FIELDS_WITHOUT_NAME.has(k))
    .map(([k, f]) => `${k} (${f})`)
  assert.deepEqual(missing, [], `请在 lib/action-log-ref-fields.ts 的 REF_FIELDS 登记：\n${missing.join('\n')}`)
})

test('操作记录里的 id 字段都有中英文字段名', () => {
  const missing = [...trackedIdFields().keys()].filter(k => !FIELD_LABELS[k])
  assert.deepEqual(missing, [], `请在 lib/action-log-i18n.ts 的 FIELD_LABELS 补上：${missing.join(', ')}`)
})

test('扫描确实覆盖到客户的价格表字段(防止扫描规则失效后测试空转)', () => {
  const f = trackedIdFields()
  assert.ok(f.has('pricelistIds'))
  assert.ok(f.has('salesUserId'))
})
