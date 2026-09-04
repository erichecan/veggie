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

/** 信息广场只对内部员工开放，RESTAURANT 客户门户账号进不来 */
const INTERNAL_ROLES = [
  'OPERATOR', 'BOSS', 'FINANCE', 'WAREHOUSE', 'SALES',
  'EXTERNAL_SALES', 'DISPATCH', 'PICKER', 'SORTER', 'DRIVER', 'OTHER',
]

export default function ClassicBulletinLayout({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<RoleSession | null>(null)
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  useEffect(() => {
    const user = getSession()
    const roles = Array.isArray(user?.roles) && user.roles.length > 0
      ? user.roles
      : (user?.role ? [user.role] : [])

    if (!user || !canEnterPage(user, '/classic/bulletin', INTERNAL_ROLES) || roles.includes('RESTAURANT')) {
      router.push(`${prefix}/enter`)
      return
    }
    setSession(toRoleSession(user))
    hydrate()
  }, [router, prefix])

  const LINKS = [{ href: `${prefix}/classic/operator`, label: isEn ? '← Back' : '← 返回' }]

  return (
    <div className="min-h-screen bg-white">
      <OdooNav appName={isEn ? 'Bulletin Board' : '信息广场'} menuItems={LINKS} session={session} />
      <main className="max-w-3xl mx-auto px-4 py-6">{children}</main>
    </div>
  )
}
