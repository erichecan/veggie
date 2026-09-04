'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import OdooNav from '@/components/classic/OdooNav'
import { getSession, toRoleSession } from '@/lib/session'
import { hydrate } from '@/lib/store'
import type { RoleSession } from '@/lib/types'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { canEnterPage } from '@/lib/rbac/page-guard'
import { decodePermissions } from '@/lib/rbac/bitmap'

export default function ClassicBossLayout({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<RoleSession | null>(null)
  // ⛔ 20260901：数据库备份入口原来按 session.role === 'boss' 显隐，
  // session 是 toRoleSession() 出来的单角色，兼任 BOSS 但主角色不是 BOSS 的账号
  // 永远看不到这条入口，即使确实有 system.backup.* 权限。改按权限位图判。
  const [canBackup, setCanBackup] = useState(false)
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const LINKS = [
    // 20260821：数据中心不再新标签页打开，需要一个返回销售系统的入口
    { href: `${prefix}/classic/operator`, label: isEn ? '← Back to Sales' : '← 返回销售' },
    { href: `${prefix}/classic/boss`, label: isEn ? 'Overview' : '经营总览' },
    { href: `${prefix}/classic/boss/analytics/sales-overview`, label: isEn ? 'Sales Overview' : '销售统计' },
    { href: `${prefix}/classic/boss/analytics/customers`, label: isEn ? 'Customer Analysis' : '客户分析' },
    { href: `${prefix}/classic/boss/analytics/margin`, label: isEn ? 'Margin Analysis' : '毛利分析' },
    // 「利润表」20260902 重新补上：过账链路（postInvoiceToJournal/postVendorBillToJournal）
    // 已经接进 /api/invoices/[id]/post 和 /api/vendor-bills/[id]，JournalEntry 不再是死代码。
    // 但页面口径仍是"毛利"（营收−COGS），运营费用录入入口依然不存在，页面自己会标注清楚。
    { href: `${prefix}/classic/boss/analytics/income-statement`, label: isEn ? 'Income Statement' : '利润表' },
    { href: `${prefix}/classic/boss/analytics/ar-aging`, label: isEn ? 'AR Aging' : '应收账龄' },
    { href: `${prefix}/classic/boss/analytics/ap-aging`, label: isEn ? 'AP Aging' : '应付账龄' },
    { href: `${prefix}/classic/boss/analytics/procurement`, label: isEn ? 'Procurement' : '采购运营' },
    { href: `${prefix}/classic/boss/analytics/logistics`, label: isEn ? 'Logistics Analysis' : '物流分析' },
    { href: `${prefix}/classic/boss/analytics/driver-commission`, label: isEn ? 'Driver Commission' : '司机提成' },
    { href: `${prefix}/classic/boss/analytics/internal-control`, label: isEn ? 'Internal Control' : '内控审计' },
    // 20260821：报表分析（原 operator/reports）物理迁入数据中心
    { href: `${prefix}/classic/boss/reports/sales`, label: isEn ? 'Sales Report' : '销售分析' },
    { href: `${prefix}/classic/boss/reports/purchasing`, label: isEn ? 'Purchasing Report' : '采购分析' },
    { href: `${prefix}/classic/boss/reports/logistics`, label: isEn ? 'Logistics Report' : '物流分析（报表）' },
    // 数据库备份涉及全库敏感数据，按权限点收紧（本 layout 本身放行 BOSS+OPERATOR）
    ...(canBackup
      ? [
          { href: '', label: '│' },
          { href: `${prefix}/classic/boss/system/backups`, label: isEn ? 'Database Backups' : '数据库备份' },
        ]
      : []),
  ]

  useEffect(() => {
    const user = getSession()
    if (!user || !canEnterPage(user, '/classic/boss', ['BOSS', 'OPERATOR'])) {
      router.push(`${prefix}/enter`)
      return
    }
    setSession(toRoleSession(user))
    setCanBackup(decodePermissions(user.pm).has('system.backup.read'))
    hydrate()
  }, [router, prefix])

  return (
    <div className="min-h-screen bg-white">
      <OdooNav appName={isEn ? 'Reports' : '报表'} menuItems={LINKS} session={session} />
      <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>
    </div>
  )
}
