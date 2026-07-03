'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import OdooNav from '@/components/classic/OdooNav'
import { getSession, toRoleSession } from '@/lib/session'
import { hydrate } from '@/lib/store'
import type { RoleSession } from '@/lib/types'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'

export default function ClassicWarehouseLayout({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<RoleSession | null>(null)
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const LINKS = [
    { href: `${prefix}/classic/warehouse`, label: '仓库管理' },
    { href: `${prefix}/classic/warehouse/stock-take`, label: '库存盘点' },
  ]

  useEffect(() => {
    const user = getSession()
    if (!user || !['WAREHOUSE', 'OPERATOR', 'BOSS'].includes(user.role)) {
      router.push(`${prefix}/enter`)
      return
    }
    setSession(toRoleSession(user))
    hydrate()
  }, [router, prefix])

  return (
    <div className="min-h-screen bg-white">
      <OdooNav appName="库存" menuItems={LINKS} session={session} />
      <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>
    </div>
  )
}
