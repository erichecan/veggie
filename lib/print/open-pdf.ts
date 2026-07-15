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
