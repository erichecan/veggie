import { redirect } from 'next/navigation'
import { routing } from '@/i18n/routing'

// 20260920：这条路由原本是另一套「销售分析」（ReportingProvider 透视表口径），
// 与 boss/sales-analysis 英文标题同名、数据口径不同，客户明确只要后者。
// 20260920 早些时候已从导航撤下，但旧书签/历史链接仍会落到这里，
// 于是整页改为重定向——系统里不再有第二个「销售分析」。
// 旧实现见 git 历史（本文件 740081a 之前的版本），reports/logistics 仍是同一套写法。
export default async function LegacySalesReportRedirect({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  redirect(`${prefix}/classic/boss/sales-analysis`)
}
