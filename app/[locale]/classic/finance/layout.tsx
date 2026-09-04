'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
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
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const LINKS = [
    { href: `${prefix}/classic/finance`, label: isEn ? 'Finance Overview' : '财务总览' },
    { href: `${prefix}/classic/finance/statements`, label: isEn ? 'Statements' : '对账单' },
    { href: `${prefix}/classic/finance/settlements`, label: isEn ? 'Driver Settlements' : '司机交账' },
    { href: `${prefix}/classic/finance/driver-reports`, label: isEn ? 'Driver Reconciliation' : '司机对账' },
    { href: `${prefix}/classic/accounting`, label: isEn ? 'Write-off' : '核销管理' },
  ]

  useEffect(() => {
    const user = getSession()
    if (!user || !canEnterPage(user, '/classic/finance', ['FINANCE', 'OPERATOR', 'BOSS'])) {
      router.push(`${prefix}/enter`)
      return
    }
    setSession(toRoleSession(user))
    hydrate()
  }, [router, prefix])

  return (
    <div className="min-h-screen bg-white">
      <OdooNav appName={isEn ? 'Finance' : '财务'} menuItems={LINKS} session={session} />
      <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>
    </div>
  )
}
