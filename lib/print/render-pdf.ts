/**
 * HTML → PDF（server-only，无头 Chromium）
 *
 * 生产环境：Dockerfile 在运行时镜像里 apk add chromium，PUPPETEER_EXECUTABLE_PATH
 * 指向系统 chromium 二进制；puppeteer-core 只驱动它，不下载/打包浏览器本体。
 * 本地开发（macOS）：没有这个环境变量时，直接用本机已装的 Google Chrome。
 */
import 'server-only'
import { existsSync } from 'fs'
import puppeteer from 'puppeteer-core'

const MAC_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

function resolveExecutablePath(): string {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH
  if (process.platform === 'darwin') {
    const found = MAC_CHROME_PATHS.find(existsSync)
    if (found) return found
  }
  throw new Error(
    '未找到可用的 Chrome/Chromium：生产环境需设置 PUPPETEER_EXECUTABLE_PATH，本地开发需安装 Google Chrome',
  )
}

export interface RenderPdfOptions {
  /**
   * 每页底部居中显示 "Page X / Y"（目前只有拣货单需要——它是按商品汇总的整趟车
   * 视角，商品多时会自然溢出好几页，司机需要知道有没有漏翻；送货单/销售单/汇总单
   * 客户明确要求不要页脚/页码，不要传 true）。
   */
  pageNumbers?: boolean
}

export async function renderHtmlToPdf(html: string, options: RenderPdfOptions = {}): Promise<Buffer> {
  const browser = await puppeteer.launch({
    executablePath: resolveExecutablePath(),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  })
  try {
    const page = await browser.newPage()
    // setContent() 只支持 load/domcontentloaded，不支持 networkidle0/2（那是 goto() 专属）
    await page.setContent(html, { waitUntil: 'load' })
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: !!options.pageNumbers,
      headerTemplate: '<span></span>',
      footerTemplate: options.pageNumbers
        ? '<div style="width:100%;font-size:9px;text-align:center;color:#333;font-family:Arial,Helvetica,sans-serif;">Page <span class="pageNumber"></span> / <span class="totalPages"></span></div>'
        : '<span></span>',
      margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' },
    })
    return Buffer.from(pdf)
  } finally {
    await browser.close()
  }
}
