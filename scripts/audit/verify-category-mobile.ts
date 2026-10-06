import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { config } from 'dotenv'
import { SignJWT } from 'jose'
import { encodePermissions } from '../../lib/rbac/bitmap'
import { PERMISSIONS } from '../../lib/rbac/catalog'

config({ path: '.env.local', quiet: true })
async function main() {
const baseUrl = process.env.CATEGORY_MOBILE_PREVIEW_URL ?? 'http://localhost:3000'
const output = 'docs/preview/20261005-category-mobile'
await mkdir(output, { recursive: true })
const session = { userId: 'preview-only', name: 'Preview', email: 'preview@example.invalid', role: 'OPERATOR', roles: ['OPERATOR'], pm: encodePermissions(PERMISSIONS.map(permission => permission.id)), ds: 'ALL' }
const token = await new SignJWT(session).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET))
const date = new Date().toISOString().slice(0, 10)
const orders = [
  { id: 'preview-order', code: 'S000123', restaurantName: 'Asian Corner · 示例餐厅', restaurantId: 'preview-customer', status: 'CONFIRMED', totalAmount: 123.45, deliveryDate: date, createdAt: `${date}T09:00:00Z`, items: [], lines: [] },
  { id: 'preview-second', code: 'S000124', restaurantName: 'A long customer name for mobile layout verification', restaurantId: 'preview-customer', status: 'WAVE_ASSIGNED', totalAmount: 456.78, deliveryDate: date, createdAt: `${date}T10:00:00Z`, items: [], lines: [] },
]
const categories = [
  { id: 'food', name: 'Food', nameZh: '食品', parentId: null },
  { id: 'veg', name: 'Vegetables', nameZh: '蔬菜', parentId: 'food' },
  { id: 'leaf', name: 'Leafy vegetables', nameZh: '叶菜', parentId: 'veg' },
  { id: 'other', name: 'Other', nameZh: '其他', parentId: null },
]
const slots = [{ id: 'preview-slot', driverName: 'Demo Driver', timeOfDay: 'am', batchNum: 1, weekday: new Date().getDay(), isActive: true }]
const waves = [{ id: 'preview-wave', name: null, driverName: 'Demo Driver', timeOfDay: 'am', waveDate: date, status: 'PENDING', orderIds: ['preview-second'], pallets: [{ id: 'preview-pallet', seq: 1, label: null, items: [{ orderId: 'preview-second' }] }], dispatchedAt: null, completedAt: null, assignmentDoneAt: null, pickLockedAt: null, pickLockedBy: null }]
const browser = await chromium.launch({ executablePath: process.env.CATEGORY_MOBILE_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await context.addCookies([{ name: 'veggie_token', value: token, url: baseUrl }])
  await context.addInitScript(({ session, token }) => { localStorage.setItem('veggie_user', JSON.stringify(session)); localStorage.setItem('veggie_token', token); localStorage.setItem('veggie_cookie_consent', JSON.stringify({ necessary: true, analytics: false, marketing: false, decidedAt: new Date().toISOString() })) }, { session, token })
  const mutations: Array<{ path: string; data: unknown }> = []
  await context.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    let body: unknown = []
    if (route.request().method() !== 'GET') {
      mutations.push({ path: url.pathname, data: route.request().postDataJSON() })
      body = { ok: true }
    } else if (url.pathname === '/api/orders') {
      const rows = url.searchParams.has('pageSize') ? orders.map(order => ({ ...order, status: url.searchParams.get('status') === 'PENDING' ? 'PENDING' : order.status })) : orders
      body = url.searchParams.has('pageSize') ? { data: rows, total: rows.length, page: 1, pageSize: 50, totalPages: 1 } : rows
    } else if (url.pathname === '/api/product-categories') body = categories
    else if (url.pathname === '/api/driver-slots') body = slots
    else if (url.pathname === '/api/waves') body = waves
    else if (url.pathname === '/api/waves/driver-summary') body = { rows: [] }
    else if (url.pathname === '/api/notifications') body = { items: [], unreadCount: 0 }
    else if (url.pathname === '/api/customers') body = [{ id: 'preview-customer', name: orders[0].restaurantName, address: '', phone: '', email: '', paymentTerm: 'monthly' }]
    await route.fulfill({ json: body })
  })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  async function noOverflow(label: string) {
    const widths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
    assert.ok(widths.document <= widths.viewport + 1, `${label}: ${JSON.stringify(widths)}`)
  }
  for (const locale of ['en', 'zh']) {
    await context.addCookies([{ name: 'NEXT_LOCALE', value: locale, url: baseUrl }])
    const prefix = locale === 'en' ? '/en' : ''
    for (const width of [360, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 })
      for (const kind of ['quotations', 'orders']) {
        await page.goto(`${baseUrl}${prefix}/classic/operator/${kind}`)
        await page.locator('article').first().waitFor({ state: width < 768 ? 'visible' : 'attached' })
        await noOverflow(`${locale}/${kind}/${width}`)
        if (width < 768) {
          assert.equal(await page.locator('article').count(), 2)
          await page.locator('article input[type=checkbox]').first().check()
          assert.ok(await page.locator('article').first().getAttribute('class')?.then(value => value?.includes('bg-purple-50')))
        } else assert.ok(await page.locator('table').first().isVisible())
        if (width === 390 || width === 1440) await page.screenshot({ path: `${output}/${locale}-${kind}-${width}.png`, fullPage: true })
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${baseUrl}/en/classic/operator/orders`)
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  await page.getByRole('navigation', { name: 'Mobile navigation' }).waitFor()
  await page.screenshot({ path: `${output}/en-navigation-390.png` })
  await page.keyboard.press('Escape')
  await page.getByRole('navigation', { name: 'Mobile navigation' }).waitFor({ state: 'hidden' })
  await page.goto(`${baseUrl}/en/classic/operator/dispatch-console`)
  await page.getByRole('button', { name: 'Assign to batch', exact: true }).first().waitFor()
  await page.getByRole('button', { name: 'Demo Driver 1', exact: true }).click()
  await page.getByRole('button', { name: 'Move / unassign', exact: true }).first().waitFor()
  await noOverflow('dispatch/390')
  await page.screenshot({ path: `${output}/en-dispatch-390.png`, fullPage: true })
  await page.getByRole('button', { name: 'Assign to batch', exact: true }).first().click()
  await page.getByRole('combobox', { name: 'Target batch' }).selectOption('preview-slot')
  await page.screenshot({ path: `${output}/en-dispatch-assign-390.png` })
  await page.getByRole('button', { name: 'Assign to this batch' }).click()
  await page.waitForFunction(() => !document.querySelector('[data-slot="dialog-content"]'))
  assert.ok(mutations.some(mutation => mutation.path === '/api/waves/preview-wave/assign'))
  await page.getByRole('button', { name: 'Move / unassign', exact: true }).first().click()
  await page.getByRole('button', { name: 'Move to unassigned', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('[data-slot="dialog-content"]'))
  assert.ok(mutations.some(mutation => mutation.path === '/api/waves/preview-wave/unassign'))
  await page.goto(`${baseUrl}/en/classic/operator/settings`)
  await page.getByRole('button', { name: 'Product Categories', exact: true }).click()
  await page.getByText('Leafy vegetables', { exact: true }).waitFor()
  await noOverflow('settings/390')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: `${output}/en-category-tree-1440.png`, fullPage: true })
  await page.getByRole('button', { name: 'Collapse Food', exact: true }).click()
  assert.equal(await page.getByText('Leafy vegetables', { exact: true }).count(), 0)
  await page.getByRole('button', { name: 'Expand Food', exact: true }).click()
  const parentOptions = await page.locator('#new-category-parent option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))
  assert.ok(parentOptions.includes('veg'))
  assert.ok(!parentOptions.includes('leaf'))
  assert.deepEqual(errors, [])
  console.log(`PASS: responsive lists (360/390/768/1440, EN/ZH), navigation, dispatch assignment, category tree; screenshots: ${output}`)
} finally {
  await browser.close()
}
}

main().catch(error => { console.error(error); process.exitCode = 1 })
