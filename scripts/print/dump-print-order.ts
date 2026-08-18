/**
 * 打印页排序的肉眼验收：把渲染结果里的商品名按出现顺序打出来。
 * 用法：npx tsx scripts/print/dump-print-order.ts <打印页URL> <JWT>
 */
import puppeteer from 'puppeteer-core'

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

async function main() {
  const [url, token] = process.argv.slice(2)
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.evaluateOnNewDocument(() => { window.print = () => {} })
  const origin = new URL(url).origin
  await page.goto(`${origin}/enter`, { waitUntil: 'load' })
  await page.evaluate((t) => {
    localStorage.setItem('veggie_token', t)
    localStorage.setItem('veggie_user', JSON.stringify({ role: 'OPERATOR', roles: ['OPERATOR'], name: 'verify' }))
    document.cookie = `veggie_token=${t}; path=/`
  }, token)
  await page.goto(url, { waitUntil: 'load' })
  await new Promise(r => setTimeout(r, 2500))

  const names = await page.evaluate(() => {
    const doc = (document.querySelector('iframe') as HTMLIFrameElement | null)?.contentDocument ?? document
    const cells = [...doc.querySelectorAll('.col-desc .prod-name, .prod-name, td.col-product, .pick-table td:nth-child(2)')]
    return cells.map(c => (c.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 44)).filter(Boolean)
  })
  const seen = new Set<string>()
  for (const [i, n] of names.entries()) {
    console.log(`${String(i + 1).padStart(3)}. ${n}${seen.has(n) ? '  (重复)' : ''}`)
    seen.add(n)
    if (i > 40) { console.log('   …'); break }
  }
  await browser.close()
}
main().then(() => process.exit(0))
