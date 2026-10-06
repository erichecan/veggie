import test from 'node:test'
import assert from 'node:assert/strict'
import { CUSTOMER_EXPORT_COLUMNS_EN } from '../lib/export/columns/customers'

test('customer exports preserve customer number and separate contact/address fields', () => {
  const row = {
    customerNo: 123, individualOrCompany: 'individual', mobile: '0851234567',
    street: '12 Main Street', street2: 'Unit 2', city: 'Dublin', state: 'Dublin', zip: 'D01', country: 'Ireland',
  }
  assert.equal(CUSTOMER_EXPORT_COLUMNS_EN[0].key, 'customerNo')
  for (const [key, value] of Object.entries(row)) {
    const column = CUSTOMER_EXPORT_COLUMNS_EN.find(column => column.key === key)
    assert.ok(column, `missing export field ${key}`)
    assert.equal(column.get(row), value)
  }
})
