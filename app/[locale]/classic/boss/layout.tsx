'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import OdooNav from '@/components/classic/OdooNav'
import { getSession, toRoleSession } from '@/lib/session'
import { hydrate } from '@/lib/store'
import type { RoleSession } from '@/lib/types'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'

export default function ClassicBossLayout({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<RoleSession | null>(null)
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const LINKS = [
    { href: `${prefix}/classic/boss`, label: '经营总览' },
    { href: `${prefix}/classic/boss/sales-analysis`, label: '销售分析' },
    { href: `${prefix}/classic/boss/purchase-analysis`, label: '采购分析' },
  ]

  useEffect(() => {
    const user = getSession()
    if (!user || !['BOSS', 'OPERATOR'].includes(user.role)) {
      router.push(`${prefix}/enter`)
      return
    }
    setSession(toRoleSession(user))
    hydrate()
  }, [router, prefix])

  return (
    <div className="min-h-screen bg-white">
      <OdooNav appName="报表" menuItems={LINKS} session={session} />
      <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>
    </div>
  )
}
