import { redirect } from 'next/navigation'
import { routing } from '@/i18n/routing'

/** 公共首页统一进入商品商城；后台登录继续使用 /enter。 */
export default async function RootPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  redirect(`${prefix}/shop`)
}
