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

export default function AccountingLayout({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<RoleSession | null>(null)
  const router = useRouter()
  const locale = useLocale()

  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const en = locale !== routing.defaultLocale

  const MENU_ITEMS = [
    { href: `${prefix}/classic/accounting`, label: en ? 'Write-off' : '核销管理' },
    { href: `${prefix}/classic/finance`, label: en ? 'Finance Overview' : '财务总览' },
    { href: `${prefix}/classic/finance/statements`, label: en ? 'Statements' : '对账单' },
    { href: `${prefix}/classic/finance/settlements`, label: en ? 'Driver Settlements' : '司机交账' },
  ]

  useEffect(() => {
    const user = getSession()
    if (!user || !canEnterPage(user, '/classic/accounting', ['FINANCE', 'OPERATOR'])) {
      router.push(`${prefix}/enter`)
      return
    }
    setSession(toRoleSession(user))
    hydrate()
  }, [router, prefix])

  return (
    <div className="min-h-screen" style={{ background: '#f5f5f5' }}>
      <OdooNav session={session} appName={en ? 'Finance' : '财务'} menuItems={MENU_ITEMS} />
      <main>{children}</main>
    </div>
  )
}
