/**
 * 量一下现在的订单/发票 PDF 一页能放几行：用假数据直接调 renderOrderHtml，
 * 不碰数据库。行数从 10 递增到 60，看总页数怎么变。
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
    await page.setContent(html, { waitUntil: 'networkidle0' })
    const buf = await page.pdf({ format: 'A4', printBackground: true })
    await page.close()
    return Buffer.from(buf)
  }
  const out: string[] = []
  for (const n of [10, 20, 25, 30, 40, 60]) {
    const html = renderOrderHtml(makeOrder(n) as never, { name: 'Musashi Liffey Valley' } as never, '2 am YANG')
    const pdf = await renderHtmlToPdf(html)
    // 数页数：PDF 里 /Type /Page 的出现次数
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
    out.push(`${String(n).padStart(3)} 行 → ${pages} 页  (平均 ${(n / pages).toFixed(1)} 行/页)`)
    if (n === 30) writeFileSync(`${process.env.SCRATCH}/sample-30.pdf`, pdf)
  }
  console.log(out.join('\n'))
  await browser.close()
}
main().then(() => process.exit(0))
