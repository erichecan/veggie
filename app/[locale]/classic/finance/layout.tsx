'use client'
import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import OdooNav from '@/components/classic/OdooNav'
import { getSession, toRoleSession } from '@/lib/session'
import { hydrate } from '@/lib/store'
import type { RoleSession } from '@/lib/types'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { canEnterPage } from '@/lib/rbac/page-guard'

export default function ClassicFinanceLayout({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<RoleSession | null>(null)
  const router = useRouter()
  const pathname = usePathname()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const LINKS = [
    { href: `${prefix}/classic/finance`, label: isEn ? 'Finance Overview' : '财务总览' },
    // 20260923：原挂在「销售」模块下的发票、供应商账单一并并入财务模块导航
    { href: `${prefix}/classic/finance/invoices`, label: isEn ? 'Invoices' : '发票' },
    { href: `${prefix}/classic/finance/vendor-bills`, label: isEn ? 'Vendor Bills' : '供应商账单' },
    { href: `${prefix}/classic/finance/statements`, label: isEn ? 'Statements' : '对账单' },
    { href: `${prefix}/classic/finance/settlements`, label: isEn ? 'Driver Settlements' : '司机交账' },
    { href: `${prefix}/classic/finance/driver-reports`, label: isEn ? 'Driver Reconciliation' : '司机对账' },
    { href: `${prefix}/classic/accounting`, label: isEn ? 'Write-off' : '核销管理' },
  ]

  useEffect(() => {
    const user = getSession()
    // ⛔ 必须传实际访问路径，不能写死 '/classic/finance'：发票/供应商账单
    // 20260923 并入本模块后，在 route-map 里对这两个子路径单独放宽了权限
    // （原销售模块的角色也要能进），写死根路径会让这层客户端守卫忽略那条例外规则。
    const barePath = prefix && pathname.startsWith(prefix) ? pathname.slice(prefix.length) || '/' : pathname
    if (!user || !canEnterPage(user, barePath, ['FINANCE', 'OPERATOR', 'BOSS'])) {
      router.push(`${prefix}/enter`)
      return
    }
    setSession(toRoleSession(user))
    hydrate()
  }, [router, prefix, pathname])

  return (
    <div className="min-h-screen bg-white">
      <OdooNav appName={isEn ? 'Finance' : '财务'} menuItems={LINKS} session={session} />
      <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>
    </div>
  )
}
