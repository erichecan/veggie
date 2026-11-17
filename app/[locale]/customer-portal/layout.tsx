'use client'
import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { getSession, logout } from '@/lib/session'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import Link from 'next/link'
import { LocaleSwitcher } from '@/components/shared/locale-switcher'
import { ChevronDown, ShoppingCart, UserRound } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { CART_UPDATED_EVENT, loadCart, OPEN_CART_EVENT } from '@/components/customer-portal/cart-utils'

const PRIMARY = 'var(--portal-primary)'

export default function CustomerPortalLayout({ children }: { children: React.ReactNode }) {
  const [userName, setUserName] = useState('')
  const [cartCount, setCartCount] = useState(0)
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
    const updateCartCount = () => setCartCount(loadCart().reduce((sum, item) => sum + item.quantity, 0))
    updateCartCount()
    window.addEventListener(CART_UPDATED_EVENT, updateCartCount)
    return () => window.removeEventListener(CART_UPDATED_EVENT, updateCartCount)
  }, [router, prefix])

  const catalogHref = `${prefix}/customer-portal`
  const ordersHref = `${prefix}/customer-portal/orders`

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
        <div className="mx-auto flex min-h-14 w-full max-w-screen-2xl items-center gap-2 px-3 py-1.5 sm:px-4">
          <Link href={catalogHref} aria-label={isEn ? 'JohnstoneBros home' : 'JohnstoneBros 首页'} className="inline-flex min-h-10 shrink-0 items-center gap-2">
            <svg aria-hidden="true" viewBox="0 0 40 40" className="size-9">
              <rect x="5" y="19" width="30" height="16" rx="4" fill="#356b2f" />
              <path d="M10 23h20M13 27h14" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
              <path d="M19 18c-7-2-8-8-7-12 6 0 11 3 11 9M21 17c0-7 5-11 12-11 0 6-3 12-10 13" fill="#4d8a3f" stroke="#285623" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <span className="whitespace-nowrap text-base font-bold tracking-tight text-[#356b2f] sm:text-lg">JohnstoneBros</span>
          </Link>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={() => {
              if (pathname === catalogHref || pathname === `${catalogHref}/`) {
                window.dispatchEvent(new Event(OPEN_CART_EVENT))
              } else {
                router.push(`${catalogHref}?openCart=1`)
              }
            }} aria-label={`${isEn ? 'Shopping cart' : '购物车'}${cartCount ? ` (${cartCount})` : ''}`}
              className="relative inline-flex min-h-10 min-w-10 items-center justify-center rounded-lg border transition-colors hover:bg-green-50"
              style={{ borderColor: 'var(--portal-border)', color: PRIMARY }}>
              <ShoppingCart className="size-5" aria-hidden="true" />
              {cartCount > 0 && <span className="absolute -right-1 -top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[11px] leading-5 text-white">{cartCount > 99 ? '99+' : cartCount}</span>}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex min-h-10 min-w-10 max-w-40 items-center justify-center gap-1.5 rounded-lg px-2 text-sm transition-colors hover:bg-green-50 sm:min-w-0 sm:px-3" style={{ color: '#3f513c' }} aria-label={isEn ? 'Account management' : '账号管理'}>
                <UserRound className="size-5 shrink-0" aria-hidden="true" />
                <span className="hidden max-w-28 truncate sm:inline">{userName || (isEn ? 'Account' : '账号')}</span>
                <ChevronDown className="hidden size-4 shrink-0 sm:block" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="max-w-full truncate" title={userName}>{userName || (isEn ? 'Account' : '账号管理')}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => router.push(ordersHref)}>
                  <span aria-hidden="true">📋</span>{isEn ? 'My Orders' : '我的订单'}
                </DropdownMenuItem>
                <div className="px-1.5 py-1.5"><LocaleSwitcher /></div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} className="text-red-600 focus:text-red-700">
                  {isEn ? 'Sign Out' : '退出登录'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>
      <main className="w-full px-4 py-6">{children}</main>
    </div>
  )
}
