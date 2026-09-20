/**
 * 打印模板预览页 · window.open 类模板抓取
 * ============================================================================
 * 还有一批模板既不是纯函数、也不灌 iframe，而是前端现拼 HTML 后
 * `window.open()` + `document.write()` 打新窗口（老板报表、分类总量、
 * 旧版波次拣货单）。这类只能靠劫持 window.open 把写进去的 HTML 收下来。
 *
 * ⛔ 只点纯渲染的打印按钮，不点任何会写库的操作。
 *
 * 用法：node scripts/print-preview/capture-windowopen-templates.mjs <输出目录> [key=value...]
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2]
if (!OUT) throw new Error('用法：capture-windowopen-templates.mjs <输出目录>')
mkdirSync(OUT, { recursive: true })

const BASE = process.env.PREVIEW_BASE || 'http://localhost:3200'
// ⛔ 不给默认值：默认值只能是真实账号，而这是要进版本库的文件（见 docs/20260819-veggie-PII处置方案.md）
const EMAIL = process.env.PREVIEW_EMAIL
const PASSWORD = process.env.PREVIEW_PASSWORD
if (!EMAIL || !PASSWORD) {
  throw new Error('需要 PREVIEW_EMAIL 与 PREVIEW_PASSWORD 环境变量（快照库里的账号，不要用生产账号）')
}
const ARGS = Object.fromEntries(process.argv.slice(3).map(a => a.split('=')))

const TARGETS = [
  {
    file: '13-wave-picking-legacy.html',
    label: '波次拣货单（旧版）',
    url: `/zh/classic/operator/waves/${ARGS.waveId}`,
    button: /打印拣货单|Print Picking List/,
  },
  {
    file: '15a-sales-summary.html',
    label: '老板报表 · Sales Summary',
    url: '/zh/classic/boss/sales-report',
    button: /Print Sale Summary/,
  },
  {
    file: '15b-multi-line.html',
    label: '老板报表 · Multi Line',
    url: '/zh/classic/boss/sales-report',
    button: /Print Multi Line/,
  },
  {
    file: '15c-sales-report.html',
    label: '老板报表 · Sales Report',
    url: '/zh/classic/boss/sales-report',
    button: /^Print$/,
  },
  {
    file: '12-category-totals.html',
    label: '分类总量单',
    url: '/zh/classic/operator/daily-sales',
    button: /打印分类总量|Print Category Totals/,
    prep: async page => {
      // 分类总量读的是屏幕上的 state：先进「销售统计」Tab，再切到「按分类」视图，
      // 打印按钮才会出现（它只在分类视图下渲染）
      await page.evaluate(() => {
        [...document.querySelectorAll('button')]
          .find(b => /销售统计|Sales Stats/.test(b.textContent || ''))?.click()
      })
      await page.waitForTimeout(3000)
      await page.evaluate(() => {
        [...document.querySelectorAll('button')]
          .find(b => /^按分类$|^By Category$/.test((b.textContent || '').trim()))?.click()
      })
      await page.waitForTimeout(2000)
      // 打印按钮是 disabled={reportLines.length===0}：日期落在没订单的那天就点不动，
      // 所以显式把日期拨到快照里有数据的 2026-09-13
      await page.evaluate(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        document.querySelectorAll('input[type=date]').forEach(inp => {
          setter.call(inp, '2026-09-13')
          inp.dispatchEvent(new Event('input', { bubbles: true }))
          inp.dispatchEvent(new Event('change', { bubbles: true }))
        })
      })
      await page.waitForTimeout(4000)
    },
  },
]

const written = []
const failed = []

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
      || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  })
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } })
  const page = await ctx.newPage()

  await page.goto(`${BASE}/enter`, { waitUntil: 'domcontentloaded' })
  const ok = await page.evaluate(async ({ email, password }) => {
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
    return !!d.token
  }, { email: EMAIL, password: PASSWORD })
  if (!ok) throw new Error('登录失败')
  console.log('登录成功')

  for (const t of TARGETS) {
    if (t.url.includes('undefined')) { console.log(`  ⊘ 跳过 ${t.file}（缺参数）`); continue }
    try {
      await page.goto(BASE + t.url, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2500)
      if (t.prep) await t.prep(page)

      // 劫持 window.open：把 document.write 写进去的内容收进 __captured
      await page.evaluate(() => {
        window.__captured = ''
        window.open = () => ({
          document: {
            write: h => { window.__captured += h },
            close: () => {},
          },
          focus: () => {},
          print: () => {},
          close: () => {},
          onload: null,
        })
      })

      const clicked = await page.evaluate(pattern => {
        const re = new RegExp(pattern)
        const btn = [...document.querySelectorAll('button')]
          .find(b => re.test((b.textContent || '').trim()))
        if (btn && btn.disabled) {
          return { ok: false, buttons: ['<该按钮处于 disabled 状态：页面当前筛选下没有数据>'] }
        }
        if (!btn) {
          return { ok: false, buttons: [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim()).filter(Boolean).slice(0, 40) }
        }
        btn.click()
        return { ok: true }
      }, t.button.source)

      if (!clicked.ok) {
        failed.push({ file: t.file, label: t.label, reason: `按钮没找到，页面上的按钮：${(clicked.buttons || []).join(' | ').slice(0, 300)}` })
        console.log(`  ✗ ${t.file}  ${t.label} —— 按钮没找到`)
        continue
      }

      await page.waitForTimeout(1500)
      const html = await page.evaluate(() => window.__captured || '')
      if (html.length < 300) {
        failed.push({ file: t.file, label: t.label, reason: `捕获到的 HTML 太短（${html.length} 字节），可能这个按钮走的不是 window.open` })
        console.log(`  ✗ ${t.file}  ${t.label} —— 捕获内容过短（${html.length} 字节）`)
        continue
      }
      const clean = html.replace(/^\s*window\.print\(\);?\s*$/gm, '')
      writeFileSync(join(OUT, t.file), clean, 'utf8')
      written.push({ file: t.file, label: t.label, bytes: Buffer.byteLength(clean) })
      console.log(`  ✓ ${t.file}  (${(Buffer.byteLength(clean) / 1024).toFixed(1)} KB)  ${t.label}`)
    } catch (e) {
      failed.push({ file: t.file, label: t.label, reason: String(e).split('\n')[0] })
      console.log(`  ✗ ${t.file}  ${t.label} —— ${String(e).split('\n')[0]}`)
    }
  }

  writeFileSync(join(OUT, '_windowopen-manifest.json'), JSON.stringify({ written, failed }, null, 2))
  console.log(`\n抓取完成：${written.length} 个成功，${failed.length} 个失败`)
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
