import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SHORTAGE_REASON_CODES,
  SHORTAGE_REASON_LABELS,
  formatShortageReason,
  isShortageReasonCode,
  parseShortageReason,
} from '../lib/shortage-reason'

test('每个原因代码都有中英文标签（漏一个就会在界面上显示 undefined）', () => {
  for (const c of SHORTAGE_REASON_CODES) {
    assert.ok(SHORTAGE_REASON_LABELS[c]?.zh, `${c} 缺中文标签`)
    assert.ok(SHORTAGE_REASON_LABELS[c]?.en, `${c} 缺英文标签`)
  }
})

test('只认白名单里的代码，伪造的一律判为无原因', () => {
  assert.equal(isShortageReasonCode('SUPPLIER_SHORT'), true)
  assert.equal(isShortageReasonCode('supplier_short'), false)
  assert.equal(isShortageReasonCode('DROP TABLE'), false)
  assert.equal(isShortageReasonCode(undefined), false)
  assert.equal(parseShortageReason({ reasonCode: 'NOPE' }).code, null)
})

test('备注截断到 200 字，且去掉首尾空白', () => {
  const { note } = parseShortageReason({ reasonCode: 'OTHER', reasonNote: '  ' + 'x'.repeat(300) + '  ' })
  assert.equal(note.length, 200)
})

test('没有原因时返回空串 —— 不能写「原因：无」', () => {
  assert.equal(formatShortageReason(undefined), '')
  assert.equal(formatShortageReason({}), '')
  assert.equal(formatShortageReason({ reasonCode: 'BOGUS' }), '')
})

test('有代码有备注时两者都出现在日志句子里', () => {
  const s = formatShortageReason({ reasonCode: 'QUALITY', reasonNote: '整箱发霉' })
  assert.match(s, /原因：质量不合格/)
  assert.match(s, /整箱发霉/)
})

test('只填备注不选代码时仍留痕（归到「其他」），不静默丢掉', () => {
  const s = formatShortageReason({ reasonNote: '司机说少装了' })
  assert.match(s, /原因：其他/)
  assert.match(s, /司机说少装了/)
})
