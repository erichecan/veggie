'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'

export default function UnitsRedirect() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  useEffect(() => { router.replace(`${prefix}/classic/operator/settings`) }, [router, prefix])
  return null
}
