'use client'

import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'

/** 与后台导航共用 next-intl 的语言 cookie 和路径约定，保留当前子页及查询参数。 */
export function LocaleSwitcher() {
  const locale = useLocale()
  const isEn = locale === 'en'

  function switchLanguage() {
    const nextLocale = isEn ? 'zh' : 'en'
    const url = new URL(window.location.href)
    let path = url.pathname
    for (const supported of routing.locales) {
      if (path === `/${supported}` || path.startsWith(`/${supported}/`)) {
        path = path.slice(supported.length + 1) || '/'
        break
      }
    }
    url.pathname = nextLocale === routing.defaultLocale ? path : `/${nextLocale}${path}`
    document.cookie = `NEXT_LOCALE=${nextLocale}; path=/; max-age=${365 * 24 * 3600}; SameSite=Lax`
    window.location.assign(url.href)
  }

  return <button type="button" onClick={switchLanguage}
    lang={isEn ? 'zh' : 'en'} aria-label={isEn ? '切换为中文' : 'Switch to English'}
    className="min-h-11 shrink-0 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-[#875A7B] hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#875A7B]">
    {isEn ? '中文' : 'English'}
  </button>
}
