import { redirect } from 'next/navigation'
import { routing } from '@/i18n/routing'

// 20260920：数据中心导航按客户要求收敛到「销售钻取 / 采购分析 / 数据库备份」三项，
// 原首页「经营总览」不再挂入口，整页搬到 boss/overview（直链仍可达，方便日后恢复）。
// 这里保留重定向：点进数据中心直接落到留下的第一张报表。
export default async function ClassicBossHomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  redirect(`${prefix}/classic/boss/sales-analysis`)
}
