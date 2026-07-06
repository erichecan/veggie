import { redirect } from 'next/navigation'
import { routing } from '@/i18n/routing'

// 波次管理列表页已废弃：分配统一在「配送调度中心」进行。
// 保留此重定向作为旧链接/书签的安全兜底（详情页 waves/[id] 仍在用）。
export default async function DeprecatedWavesListPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  redirect(`${prefix}/classic/operator/dispatch-console`)
}
