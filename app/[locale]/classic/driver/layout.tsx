'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import OdooNav from '@/components/classic/OdooNav'
import { getSession, toRoleSession } from '@/lib/session'
import { hydrate } from '@/lib/store'
import type { RoleSession } from '@/lib/types'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'

export default function ClassicDriverLayout({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<RoleSession | null>(null)
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const LINKS = [
    { href: `${prefix}/classic/driver`, label: '配送任务' },
    { href: `${prefix}/classic/driver/settlement`, label: '交账' },
  ]

  useEffect(() => {
    const user = getSession()
    if (!user || !['DRIVER', 'OPERATOR'].includes(user.role)) {
      router.push(`${prefix}/enter`)
      return
    }
    setSession(toRoleSession(user))
    hydrate()
  }, [router, prefix])

  return (
    <div className="min-h-screen bg-white">
      <OdooNav appName="配送" menuItems={LINKS} session={session} />
      <main className="max-w-4xl mx-auto px-4 py-6">{children}</main>
    </div>
  )
}
