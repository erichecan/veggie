/**
 * 打开一个需要 JWT 鉴权的服务端 PDF 路由：JWT 存在 localStorage，直接 window.open(url) 不会带
 * Authorization 头会 401，必须先带鉴权 fetch 拿到 PDF 二进制，转成 blob URL 再展示（同
 * openPurchaseOrderPdf() 的 HTML 版本套路）。先同步开一个空白窗口再异步填充，避免被弹窗拦截器
 * 当成非用户触发的弹窗拦掉。
 */
import { authHeaders } from '@/lib/api'

export async function openAuthedPdf(url: string): Promise<void> {
  const win = window.open('', '_blank')
  try {
    const res = await fetch(url, { headers: authHeaders() })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`)
    }
    const blob = await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    if (win) {
      win.location.href = objectUrl
    } else {
      window.open(objectUrl, '_blank')
    }
  } catch (e) {
    win?.close()
    throw e
  }
}

/**
 * 下载一个需要 JWT 鉴权的文件（导出 CSV 等）：同 openAuthedPdf 的鉴权 fetch 套路，
 * 但触发浏览器"另存为下载"而非新开窗口预览。文件名优先取服务端 Content-Disposition，
 * 拿不到时退回调用方传入的 fallbackFilename。
 *
 * 返回 truncatedTotal：服务端因行数上限截断时给出的**实际匹配总数**（X-Export-Truncated），
 * 没截断则为 null。调用方据此提示用户，避免把半份数据当成全部拿走。
 */
export async function downloadAuthedFile(
  url: string,
  fallbackFilename: string,
): Promise<{ truncatedTotal: number | null }> {
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`)
  }
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
  const filename = match ? decodeURIComponent(match[1]) : fallbackFilename

  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(objectUrl)

  const truncated = res.headers.get('X-Export-Truncated')
  return { truncatedTotal: truncated ? Number(truncated) : null }
}
