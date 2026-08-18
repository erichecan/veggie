/**
 * 量单据模板「一页能印几行」—— 改打印排版前后都跑一次，别凭感觉调 CSS。
 *
 * 用法：npx tsx scripts/print/measure-lines-per-page.ts
 *
 * 为什么不用 lib/print/render-pdf.ts：那个文件标了 'server-only'，脚本环境
 * 解析不了。这里直接驱动本机 Chrome，渲染口径与它一致（都是 Chromium 打印）。
 *
 * 商品名刻意用生产库里的真实长度 —— 短名测出来的行数是虚的，
 * 中文描述会把一行撑成两行，那才是客户实际打印的样子。
 *
 * 基线（2026-08-18 改造后）：10→1页 20→1页 25→2页(25/0) 30→2页(26/4)
 *                            40→2页(28/12) 60→3页(32/27/1)
 * 客户要求是「一页至少 20 行」，首页实测 26-32 行。
 */
import { renderOrderHtml } from '@/lib/order-pdf'
import puppeteer from 'puppeteer-core'
import { writeFileSync } from 'node:fs'

const NAMES = [
  'HT Superior Taste Oyster Sauce GLASS 12*680g CASE [海天蚝油10.220.072]',
  'Chili Red KG',
  'Maling Luncheon Meat Pork 12*340g CASE [梅林]午餐肉 "CN White Box"',
  'Beansprout BAG',
  'LL Japanese Style Mochi-Peanut 24x210g CASE [花之恋语] 日式麻薯 花生味',
  'Courgette CASE',
]

function makeOrder(n: number) {
  return {
    id: 'measure', code: 'D999999', quotationDate: '2026-08-18', deliveryDate: '2026-08-19',
    salesUser: { name: 'Hua Di' }, internalNote: '',
    lines: Array.from({ length: n }, (_, i) => ({
      productName: NAMES[i % NAMES.length],
      orderedQty: 1, unitPrice: 14, subtotal: 14, taxRate: 0,
      uomName: 'CASE', spec: null, note: null,
    })),
  }
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

async function main() {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] })
  const renderHtmlToPdf = async (html: string) => {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'load' })
    const buf = await page.pdf({ format: 'A4', printBackground: true })
    await page.close()
    return Buffer.from(buf)
  }
  const out: string[] = []
  for (const n of [10, 20, 25, 30, 40, 60]) {
    const html = renderOrderHtml(makeOrder(n) as never, { name: 'Musashi Liffey Valley' } as never, '2 am YANG')
    const pdf = await renderHtmlToPdf(html)
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
    // 精确数每页行数：量每个 tr 的实际位置，按 A4 内容区高度切页
    const page = await browser.newPage()
    await page.setContent(html)
    await page.emulateMediaType('print')
    const perPage = await page.evaluate(() => {
      const MM = 96 / 25.4
      const contentH = (297 - 10 - 16) * MM   // @page margin: 10mm 10mm 16mm
      const counts: number[] = []
      document.querySelectorAll('.lines-table tbody tr').forEach(tr => {
        const top = (tr as HTMLElement).getBoundingClientRect().top + window.scrollY
        const idx = Math.floor(top / contentH)
        counts[idx] = (counts[idx] ?? 0) + 1
      })
      return [...counts].map(c => c ?? 0)
    })
    await page.close()
    out.push(`${String(n).padStart(3)} 行 → ${pages} 页   每页行数: ${perPage.join(' / ')}`)
    writeFileSync(`${process.env.SCRATCH}/sample-${n}.pdf`, pdf)
  }
  console.log(out.join('\n'))
  await browser.close()
}
main().then(() => process.exit(0))
