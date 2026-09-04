'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { getSession, logout } from '@/lib/session'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import Link from 'next/link'

const PURPLE = '#875A7B'

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
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-30 border-b bg-white shadow-sm">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <span className="text-lg font-bold" style={{ color: PURPLE }}>🥬 {isEn ? 'Order Vegetables' : '蔬菜订购'}</span>
            <nav className="flex gap-1">
              {nav.map(n => {
                const active = n.href === `${prefix}/customer-portal`
                  ? pathname === n.href || pathname === `${n.href}/`
                  : pathname.startsWith(n.href)
                return (
                  <Link key={n.href} href={n.href}
                    className="px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
                    style={active ? { background: PURPLE, color: 'white' } : { color: '#555' }}
                  >
                    {n.icon} {n.label}
                  </Link>
                )
              })}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-gray-600">{userName}</span>
            <button onClick={handleLogout}
              className="text-gray-400 hover:text-red-500 transition-colors text-xs">
              {isEn ? 'Sign Out' : '退出'}
            </button>
          </div>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-6">{children}</main>
    </div>
  )
}
