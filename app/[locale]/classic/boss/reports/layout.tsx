'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'

/**
 * 报表分析的三张表共用一条 tab（台账 H2）。
 *
 * ⚠️ 这三个页面此前**没有任何导航入口** —— 代码、接口、SQL 视图全都在，
 * 权限也配好了，但整个系统里没有一个链接指向它们。功能到不了 = 等于不存在，
 * 这才是 H2 真正的缺口（清单里写的「采购侧完全没有可组合分析」不准确）。
 */
const TABS = [
  { seg: 'sales', zh: '销售分析', en: 'Sales' },
  { seg: 'purchasing', zh: '采购分析', en: 'Purchasing' },
  { seg: 'logistics', zh: '物流分析', en: 'Logistics' },
]

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const pathname = usePathname()

  return (
    <div>
      <div className="flex items-center gap-1 border-b bg-white px-4 pt-3">
        {TABS.map(t => {
          const href = `${prefix}/classic/boss/reports/${t.seg}`
          const active = pathname?.startsWith(href)
          return (
            <Link key={t.seg} href={href}
              className={`px-4 py-2 text-sm rounded-t-md border-b-2 transition-colors ${
                active ? 'border-[#875A7B] text-[#875A7B] font-medium' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}>
              {isEn ? t.en : t.zh}
            </Link>
          )
        })}
      </div>
      {children}
    </div>
  )
}
