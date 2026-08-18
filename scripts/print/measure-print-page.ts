/**
 * 量「手工分页」类打印页（print/[id]、print/batch、print/trip/*、print/dispatch/*）
 * 的实际排版：每个 .page 的真实高度是否超出物理页、每页放了几行。
 *
 * 这类页面不像 lib/order-pdf.ts 靠浏览器自动分页，而是自己按行高预估切块
 * （lib/print/trip-common.ts 的 PRINT_ROW_BASE_MM 等常量）。预估小于实际就会
 * 真的溢出 —— 溢出不会自动换页，只会被切掉或压住页脚。所以改完行高必须跑这个。
 *
 * 用法：npx tsx scripts/print/measure-print-page.ts <打印页URL> <JWT>
 */
import puppeteer from 'puppeteer-core'

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** .page 本身就设了 min-height:297mm，所以等于 297 是正常的；只有明显超出才是真溢出 */
const A4_H_MM = 297
const OVERFLOW_TOLERANCE_MM = 1

async function main() {
  const [url, token] = process.argv.slice(2)
  if (!url || !token) throw new Error('用法: measure-print-page.ts <URL> <JWT>')

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  // 这些页面加载完会自己调 window.print()，无头浏览器里那是个同步阻塞调用，
  // 会把后续所有操作卡死（实测卡满 120s）。渲染前先把它换成空函数。
  await page.evaluateOnNewDocument(() => { window.print = () => {} })

  const origin = new URL(url).origin
  await page.goto(`${origin}/enter`, { waitUntil: 'load' })
  await page.evaluate((t) => {
    localStorage.setItem('veggie_token', t)
    localStorage.setItem('veggie_user', JSON.stringify({ role: 'OPERATOR', roles: ['OPERATOR'], name: 'verify' }))
    document.cookie = `veggie_token=${t}; path=/`
  }, token)

  await page.goto(url, { waitUntil: 'load' })
  await page.emulateMediaType('print')
  await new Promise(r => setTimeout(r, 2500))

  const result = await page.evaluate(() => {
    const MM = 96 / 25.4
    const doc = (document.querySelector('iframe') as HTMLIFrameElement | null)?.contentDocument ?? document
    const pages = [...doc.querySelectorAll('.page')]
    if (pages.length > 0) {
      // 手工分页型模板：每个 .page 就是一张物理纸，逐个量
      return {
        mode: 'manual' as const,
        pages: pages.map(p => ({
          heightMm: +((p as HTMLElement).scrollHeight / MM).toFixed(1),
          rows: p.querySelectorAll('.lines-table tbody tr').length,
        })),
      }
    }
    // 流式模板（拣货单/汇总单）：靠浏览器自动分页，只能量总高度与总行数
    const rows = doc.querySelectorAll('table tbody tr, table.pick-table tr:not(:first-child)').length
    const totalMm = doc.body.scrollHeight / MM
    return { mode: 'flow' as const, totalMm: +totalMm.toFixed(1), rows }
  })

  if (result.mode === 'manual') {
    console.log(`共 ${result.pages.length} 个渲染页（手工分页）`)
    for (const [i, p] of result.pages.entries()) {
      const over = p.heightMm > A4_H_MM + OVERFLOW_TOLERANCE_MM
      console.log(`  第 ${i + 1} 页: 高度 ${p.heightMm}mm ${over ? '⛔ 超出 A4(297mm)' : '✅'}  行数 ${p.rows}`)
    }
  } else {
    const pages = Math.max(1, Math.ceil(result.totalMm / A4_H_MM))
    console.log(`流式分页：总高 ${result.totalMm}mm ≈ ${pages} 页，共 ${result.rows} 行`
      + `（约 ${(result.rows / pages).toFixed(1)} 行/页）`)
  }
  await browser.close()
}
main().then(() => process.exit(0))
