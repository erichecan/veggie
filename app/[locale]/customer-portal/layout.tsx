'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { getSession, logout } from '@/lib/session'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import Link from 'next/link'
import { LocaleSwitcher } from '@/components/shared/locale-switcher'

const PRIMARY = 'var(--portal-primary)'

export default function CustomerPortalLayout({ children }: { children: React.ReactNode }) {
  const [userName, setUserName] = useState('')
  const router = useRouter()
  const pathname = usePathname()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  useEffect(() => {
    const user = getSession()
    if (!user || user.role !== 'RESTAURANT') {
      router.push(`${prefix}/enter`)
      return
    }
    setUserName(user.name || user.email)
  }, [router, prefix])

  const nav = [
    { href: `${prefix}/customer-portal`, label: isEn ? 'Catalog' : '商品目录', icon: '📦' },
    { href: `${prefix}/customer-portal/orders`, label: isEn ? 'My Orders' : '我的订单', icon: '📋' },
  ]

  function handleLogout() {
    logout()
    router.push(`${prefix}/enter`)
  }

  return (
    <div className="min-h-screen" style={{
      '--portal-primary': '#356b2f',
      '--portal-primary-hover': '#285623',
      '--portal-surface': '#f7faf6',
      '--portal-border': '#dce7d9',
      background: 'var(--portal-surface)',
    } as React.CSSProperties}>
      <header className="sticky top-0 z-30 border-b bg-white shadow-sm" style={{ borderColor: 'var(--portal-border)' }}>
        <div className="w-full px-4 min-h-14 py-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-6">
            <span className="text-lg font-bold" style={{ color: PRIMARY }}>🥬 {isEn ? 'Order Vegetables' : '蔬菜订购'}</span>
            <nav className="flex gap-1">
              {nav.map(n => {
                const active = n.href === `${prefix}/customer-portal`
                  ? pathname === n.href || pathname === `${n.href}/`
                  : pathname.startsWith(n.href)
                return (
                  <Link key={n.href} href={n.href}
                    className="min-h-11 inline-flex items-center px-3 py-2 rounded-md text-sm font-medium transition-colors"
                    style={active ? { background: PRIMARY, color: 'white' } : { color: '#3f513c' }}
                  >
                    {n.icon} {n.label}
                  </Link>
                )
              })}
            </nav>
          </div>
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-sm">
            <LocaleSwitcher />
            <span className="max-w-40 truncate text-gray-600" title={userName}>{userName}</span>
            <button onClick={handleLogout}
              className="min-h-11 px-2 text-gray-500 hover:text-red-500 transition-colors text-xs">
              {isEn ? 'Sign Out' : '退出'}
            </button>
          </div>
        </div>
      </header>
      <main className="w-full px-4 py-6">{children}</main>
    </div>
  )
}
