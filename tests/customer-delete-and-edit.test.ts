import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { translateLogDetail } from '../lib/action-log-i18n'

const schema = readFileSync('prisma/schema.prisma', 'utf-8')
const deleteSrc = readFileSync('lib/customer-delete.ts', 'utf-8')
const bulkDeleteSrc = readFileSync('app/api/customers/bulk-delete/route.ts', 'utf-8')
const putSrc = readFileSync('app/api/customers/[id]/route.ts', 'utf-8')

test('客户 PUT 只在请求带了 specialPrices 时才清空专属价', () => {
  // 20261007：以前无条件 deleteMany，列表行内改一个字段/批量归档都会清空客户专属价
  assert.match(putSrc, /if \(specialPrices !== undefined\) \{\s*await prisma\.customerSpecialPrice\.deleteMany/)
  assert.doesNotMatch(putSrc, /\n\s{6}await prisma\.customerSpecialPrice\.deleteMany/)
})

test('删除检查覆盖了所有软引用客户/供应商的表', () => {
  // 没有外键(@relation)的 customerId/supplierId/partnerId 列：删客户不会级联也不会报错，
  // 必须在 lib/customer-delete.ts 里拦住(或在删除时显式处理)。新加这类列的表要同步登记。
  const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
  const softRefs: string[] = []
  for (const [, model, body] of models) {
    for (const col of ['customerId', 'supplierId', 'partnerId']) {
      if (!new RegExp(`^\\s+${col}\\s+String`, 'm').test(body)) continue
      const hasRelation = new RegExp(`fields: \\[${col}\\]`).test(body)
      if (!hasRelation) softRefs.push(`${model}.${col}`)
    }
  }
  assert.ok(softRefs.length > 5, `软引用列识别不对: ${softRefs.join(', ')}`)
  const handled = (model: string) => {
    const accessor = model[0].toLowerCase() + model.slice(1)
    return deleteSrc.includes(`prisma.${accessor}.groupBy`) || bulkDeleteSrc.includes(`tx.${accessor}.`)
  }
  const missing = softRefs.filter(ref => !handled(ref.split('.')[0]))
  assert.deepEqual(missing, [], `这些表引用了客户/供应商却没在删除检查里处理: ${missing.join(', ')}`)
})

test('删除接口挂在 master.customer.delete 上', () => {
  assert.match(bulkDeleteSrc, /require: 'master\.customer\.delete'/)
  const routeMap = readFileSync('lib/rbac/route-map.ts', 'utf-8')
  assert.match(routeMap, /'\/api\/customers\/bulk-delete', methods: \['POST'\], permission: 'master\.customer\.delete'/)
})

test('操作记录英文显示', () => {
  assert.equal(translateLogDetail('更新客户: 洋葱客户餐厅', true), 'Updated customer: 洋葱客户餐厅')
  assert.equal(translateLogDetail('删除联系人 Bob（ext 12）', true), 'Deleted contact Bob (ext 12)')
  assert.equal(translateLogDetail('批量导入客户：新建 3，更新 1，重名跳过 0，失败 0', true),
    'Bulk import customers: created 3, updated 1, skipped (name collisions) 0, failed 0')
  assert.equal(translateLogDetail('更新客户: X', false), '更新客户: X')
  assert.equal(translateLogDetail('Updated in English', true), 'Updated in English')
})

test('导入的状态列与账期文字都认得出导出时写的值', async () => {
  const { parseActiveStatus } = await import('../lib/import/contact-fields')
  const { parsePaymentTermInput } = await import('../lib/payment-terms')
  assert.equal(parseActiveStatus('Inactive').value, false)
  assert.equal(parseActiveStatus('停用').value, false)
  assert.equal(parseActiveStatus('Active').value, true)
  assert.equal(parseActiveStatus('活跃').value, true)
  assert.deepEqual(parseActiveStatus(''), { value: undefined, invalid: false })
  assert.equal(parseActiveStatus('maybe').invalid, true)
  assert.equal(parsePaymentTermInput('月结'), 'monthly')
  assert.equal(parsePaymentTermInput('Monthly'), 'monthly')
  assert.equal(parsePaymentTermInput('Biweekly (2 Weeks)'), 'biweekly')
  assert.equal(parsePaymentTermInput('现付'), 'cash')
  assert.equal(parsePaymentTermInput('COD'), undefined)
})
