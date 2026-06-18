import { redirect } from 'next/navigation'
import { routing } from '@/i18n/routing'

// 工作台已下线：服务端重定向到「下单（报价单）」页
export default async function OperatorHome({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  redirect(`${prefix}/classic/operator/quotations`)
}
