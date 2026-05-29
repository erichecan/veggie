'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'

/**
 * /classic/operator/pricing — 已按修改意见 #12 移除
 * 重定向到价格表列表页（/classic/operator/pricelists）
 */
export default function ClassicPricingRedirect() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  useEffect(() => {
    router.replace(`${prefix}/classic/operator/pricelists`)
  }, [router, prefix])

  return null
}
