'use client'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { BannerManager } from '@/components/classic/banner-manager'

export default function BannersPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  return <BannerManager isEn={isEn} />
}
