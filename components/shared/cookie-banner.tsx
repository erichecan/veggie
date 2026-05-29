'use client'
import { useEffect, useState } from 'react'

const STORAGE_KEY = 'veggie_cookie_consent'

interface Consent {
  necessary: true        // 必要 cookie 总是 true
  analytics: boolean     // 分析（Sentry 等）
  marketing: boolean     // 营销（Pexels 预览）
  decidedAt: string
}

/**
 * GDPR Cookie 同意横幅。默认右下角，首次访问显示。
 * 选择后写 localStorage，下次不再弹。
 *
 * 使用：在 RootLayout 里 `<CookieBanner />` 一次。
 */
export default function CookieBanner() {
  const [show, setShow] = useState(false)
  const [custom, setCustom] = useState<Consent>({
    necessary: true,
    analytics: true,
    marketing: false,
    decidedAt: '',
  })

  useEffect(() => {
    try {
      const raw = typeof window !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
      if (!raw) setShow(true)
    } catch {
      /* localStorage 被禁用的浏览器，不展示 */
    }
  }, [])

  function save(consent: Consent) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...consent, decidedAt: new Date().toISOString() }))
    } catch { /* ignore */ }
    setShow(false)
    // 通知应用其他部分 consent 变化
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('cookie-consent-changed', { detail: consent }))
    }
  }

  function acceptAll() {
    save({ necessary: true, analytics: true, marketing: true, decidedAt: '' })
  }
  function rejectAll() {
    save({ necessary: true, analytics: false, marketing: false, decidedAt: '' })
  }
  function saveCustom() {
    save(custom)
  }

  if (!show) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-md bg-white rounded-lg shadow-xl border border-gray-200 p-4 text-sm">
      <h3 className="font-semibold text-gray-900 mb-2">🍪 我们使用 Cookies</h3>
      <p className="text-gray-600 text-xs mb-3">
        本网站使用必要 Cookie 保证登录和订单流程，以及可选的分析 / 营销 Cookie 帮助我们改进产品。
        你的选择随时可以在账户设置里更改。
        <a href="/privacy" className="text-blue-600 hover:underline ml-1">查看隐私政策</a>
      </p>

      <details className="mb-3 text-xs">
        <summary className="cursor-pointer text-blue-600">自定义选择</summary>
        <div className="mt-2 space-y-1.5 pl-2">
          <label className="flex items-center gap-2 opacity-60">
            <input type="checkbox" checked disabled />
            <span><strong>必要</strong> — 登录、订单（不可关闭）</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={custom.analytics}
              onChange={(e) => setCustom({ ...custom, analytics: e.target.checked })} />
            <span><strong>分析</strong> — 匿名错误监控（Sentry）</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={custom.marketing}
              onChange={(e) => setCustom({ ...custom, marketing: e.target.checked })} />
            <span><strong>营销</strong> — 商品图片预览服务</span>
          </label>
        </div>
      </details>

      <div className="flex justify-end gap-2">
        <button onClick={rejectAll} className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50">
          拒绝全部
        </button>
        <button onClick={saveCustom} className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50">
          保存选择
        </button>
        <button onClick={acceptAll} className="px-3 py-1.5 text-xs bg-[#875A7B] text-white rounded hover:bg-[#6d4963]">
          接受全部
        </button>
      </div>
    </div>
  )
}

/**
 * 读取当前 consent。组件外其他地方用（比如决定要不要初始化 Sentry）。
 */
export function readConsent(): Consent | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as Consent
  } catch {
    return null
  }
}
