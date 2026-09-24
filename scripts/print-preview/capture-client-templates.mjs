/**
 * 打印模板预览页 · 客户端模板抓取
 * ============================================================================
 * 有一批模板不是纯函数，而是 React 页面现拼 HTML（灌 iframe srcDoc）或抓 DOM。
 * 这些只能在真实浏览器里跑出来，所以这里用 Playwright 登录本地 dev server
 * （连的是生产数据快照库），逐个打开打印页，把 iframe 的 srcdoc 原样存成 HTML。
 *
 * ⛔ 只走 preview=1 这类无副作用入口，不点会写库的按钮
 *   （拣货单打印会 pick-lock 锁波次、订单打印会 mark-printed 写打印痕迹）。
 *
 * 用法：node scripts/print-preview/capture-client-templates.mjs <输出目录>
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2]
if (!OUT) throw new Error('用法：capture-client-templates.mjs <输出目录>')
mkdirSync(OUT, { recursive: true })

const BASE = process.env.PREVIEW_BASE || 'http://localhost:3200'
// ⛔ 不给默认值：默认值只能是真实账号，而这是要进版本库的文件（见 docs/20260819-veggie-PII处置方案.md）
const EMAIL = process.env.PREVIEW_EMAIL
const PASSWORD = process.env.PREVIEW_PASSWORD
if (!EMAIL || !PASSWORD) {
  throw new Error('需要 PREVIEW_EMAIL 与 PREVIEW_PASSWORD 环境变量（快照库里的账号，不要用生产账号）')
}

/** 订单 id 从命令行之后的参数传入，形如 key=value */
const ARGS = Object.fromEntries(process.argv.slice(3).map(a => a.split('=')))

const TARGETS = [
  { file: '06-invoice-zh.html',   label: '发票（单订单）',        url: `/zh/classic/print/${ARGS.orderId}?preview=1` },
  { file: '06-invoice-en.html',   label: '发票（单订单）EN',      url: `/en/classic/print/${ARGS.orderId}?preview=1` },
  { file: '06-delivery-zh.html',  label: '送货单（单订单）',      url: `/zh/classic/print/${ARGS.orderId}?doc=delivery&preview=1` },
  { file: '06-salesorder-zh.html',label: '销售订单（单订单）',    url: `/zh/classic/print/${ARGS.orderId}?doc=sales&preview=1` },
  { file: '07-batch-delivery.html', label: '批量订单打印',        url: `/zh/classic/print/batch?ids=${ARGS.batchIds}&doc=delivery&preview=1` },
]

/** 这些页面自己就是纸（React + @media print），没有 iframe，整页存下来 */
/** 价格表把 HTML 写进 iframe 的 contentDocument（不是 srcdoc，也不在父页面 DOM 里） */
const IFRAME_DOC_TARGETS = [
  { file: '10-pricelist.html',    label: '价格表',    url: `/zh/classic/print/pricelist?ids=${ARGS.pricelistIds}` },
  { file: '10-pricelist-en.html', label: '价格表 EN', url: `/en/classic/print/pricelist?ids=${ARGS.pricelistIds}` },
]

const FULL_PAGE_TARGETS = [
  { file: '08-invoice-entity-zh.html', label: '发票 INVOICE（Invoice 实体）', url: `/zh/classic/finance/invoices/${ARGS.invoiceId}/print` },
  { file: '08-invoice-entity-en.html', label: '发票 INVOICE（Invoice 实体）EN', url: `/en/classic/finance/invoices/${ARGS.invoiceId}/print` },
]

const written = []

async function main() {
  // 项目没装 Playwright 自带的浏览器，用本机 Chrome —— 和 render-pdf.ts 生成 PDF 时同一个内核
  const browser = await chromium.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1600 } })
  const page = await ctx.newPage()

  // 登录：token 进 localStorage（前端 apiGet 用），cookie 由响应自动带上（middleware 用）
  await page.goto(`${BASE}/enter`, { waitUntil: 'domcontentloaded' })
  const login = await page.evaluate(async ({ email, password }) => {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const d = await r.json()
    if (d.token) {
      localStorage.setItem('veggie_token', d.token)
      localStorage.setItem('veggie_user', JSON.stringify(d.user || {}))
      // 预先种下 Cookie 同意，否则每张单据右下角都会挂着同意横幅
      localStorage.setItem('veggie_cookie_consent', JSON.stringify({
        necessary: true, analytics: false, marketing: false, decidedAt: new Date().toISOString(),
      }))
    }
    return { status: r.status, ok: !!d.token }
  }, { email: EMAIL, password: PASSWORD })
  if (!login.ok) throw new Error(`登录失败：${JSON.stringify(login)}`)
  console.log('登录成功')

  for (const t of TARGETS) {
    if (t.url.includes('undefined')) { console.log(`  ⊘ 跳过 ${t.file}（缺参数）`); continue }
    try {
      await page.goto(BASE + t.url, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(
        () => {
          const f = document.querySelector('iframe')
          return !!f && !!f.getAttribute('srcdoc') && f.getAttribute('srcdoc').length > 500
        },
        { timeout: 20000 },
      )
      const html = await page.evaluate(() => document.querySelector('iframe').getAttribute('srcdoc'))
      // 预览页是拿来看的，去掉内嵌的自动打印调用
      const clean = html.replace(/^\s*window\.print\(\);?\s*$/gm, '')
      writeFileSync(join(OUT, t.file), clean, 'utf8')
      written.push({ file: t.file, label: t.label, bytes: Buffer.byteLength(clean) })
      console.log(`  ✓ ${t.file}  (${(Buffer.byteLength(clean) / 1024).toFixed(1)} KB)  ${t.label}`)
    } catch (e) {
      console.log(`  ✗ ${t.file}  ${t.label} —— ${String(e).split('\n')[0]}`)
    }
  }

  for (const t of IFRAME_DOC_TARGETS) {
    if (t.url.includes('undefined')) { console.log(`  ⊘ 跳过 ${t.file}（缺参数）`); continue }
    try {
      await page.goto(BASE + t.url, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => {
        const f = document.getElementById('print-frame')
        const doc = f && f.contentDocument
        return !!doc && doc.querySelectorAll('tr').length > 3
      }, { timeout: 30000 })
      const html = await page.evaluate(() => {
        const doc = document.getElementById('print-frame').contentDocument
        return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
      })
      const clean = html.replace(/^\s*window\.print\(\);?\s*$/gm, '')
      writeFileSync(join(OUT, t.file), clean, 'utf8')
      written.push({ file: t.file, label: t.label, bytes: Buffer.byteLength(clean) })
      console.log(`  ✓ ${t.file}  (${(Buffer.byteLength(clean) / 1024).toFixed(1)} KB)  ${t.label}`)
    } catch (e) {
      console.log(`  ✗ ${t.file}  ${t.label} —— ${String(e).split('\n')[0]}`)
    }
  }

  for (const t of FULL_PAGE_TARGETS) {
    if (t.url.includes('undefined')) { console.log(`  ⊘ 跳过 ${t.file}（缺参数）`); continue }
    try {
      await page.goto(BASE + t.url, { waitUntil: 'networkidle' })
      // 这些页面是 React 客户端取数后才渲染表格的，networkidle 之后骨架就在了但表格还是空的。
      // 不等表格真正出现就抓，存下来的是一张只有标题的空壳（53KB HTML / 147 字正文）。
      await page.waitForFunction(() => document.querySelectorAll('table tr').length > 3, { timeout: 25000 })
        .catch(() => console.log('    （表格行数没等到，按现状抓取）'))
      await page.waitForTimeout(1500)
      // 整页存档要自包含：这类页面的样式在 /_next/static/ 下，静态站里没有那些文件，
      // 直接存 outerHTML 的话外链 CSS 全部 404 —— 客户看到的是一张没有样式的裸表格。
      // 所以把同源样式表的规则全部内联进来，并去掉屏幕专用的外壳（导航、Cookie 横幅、
      // Next 开发工具），只留下这张纸本身。
      const html = await page.evaluate(() => {
        const css = [...document.styleSheets]
          .map(ss => { try { return [...ss.cssRules].map(r => r.cssText).join('\n') } catch { return '' } })
          .join('\n')

        document.querySelectorAll('link[rel="stylesheet"], script, nextjs-portal').forEach(el => el.remove())
        document.querySelectorAll('.no-print, [data-cookie-banner], #cookie-consent, header, nav').forEach(el => el.remove())
        document.querySelectorAll('div').forEach(el => {
          const pos = getComputedStyle(el).position
          if ((pos === 'fixed' || pos === 'sticky') && /我们使用 Cookies|We use cookies/.test(el.textContent || '')) {
            el.remove()
          }
        })

        const style = document.createElement('style')
        style.textContent = css
        document.head.appendChild(style)
        return '<!DOCTYPE html>\n' + document.documentElement.outerHTML
      })
      writeFileSync(join(OUT, t.file), html, 'utf8')
      written.push({ file: t.file, label: t.label, bytes: Buffer.byteLength(html) })
      console.log(`  ✓ ${t.file}  (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)  ${t.label}`)
    } catch (e) {
      console.log(`  ✗ ${t.file}  ${t.label} —— ${String(e).split('\n')[0]}`)
    }
  }

  writeFileSync(join(OUT, '_client-manifest.json'), JSON.stringify(written, null, 2))
  console.log(`\n抓取完成：${written.length} 个`)
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
