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
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const LINKS = [
    // 20260821：数据中心不再新标签页打开，需要一个返回销售系统的入口
    { href: `${prefix}/classic/operator`, label: '← 返回销售' },
    { href: `${prefix}/classic/boss`, label: '经营总览' },
    { href: `${prefix}/classic/boss/analytics/sales-overview`, label: '销售统计' },
    { href: `${prefix}/classic/boss/analytics/customers`, label: '客户分析' },
    { href: `${prefix}/classic/boss/analytics/margin`, label: '毛利分析' },
    // 「利润表」入口于 20260802 摘除：它指向的页面与 API 从未存在，点进去是 404。
    // 不补的理由：利润表 = 收入 − 成本 − 费用，而**费用这一项没有数据来源**——
    // 系统没有「其他收入/支出」录入模块，Account 虽有 10 个科目但 JournalEntry 与
    // JournalEntryLine 均为 0 条，复式记账是空壳。硬做只能产出一张缺全部运营费用的表。
    // 恢复此入口的前置条件：① 建费用录入（或把 VendorBill 中非采购类账单归入费用科目）；
    // ② 让 JournalEntry 真正产生分录；③ 出成本结转，使销售成本不再只依赖 Lot.unitCost 覆盖率。
    { href: `${prefix}/classic/boss/analytics/ar-aging`, label: '应收账龄' },
    { href: `${prefix}/classic/boss/analytics/ap-aging`, label: '应付账龄' },
    { href: `${prefix}/classic/boss/analytics/procurement`, label: '采购运营' },
    { href: `${prefix}/classic/boss/analytics/logistics`, label: '物流分析' },
    { href: `${prefix}/classic/boss/analytics/driver-commission`, label: '司机提成' },
    { href: `${prefix}/classic/boss/analytics/internal-control`, label: '内控审计' },
    // 20260821：报表分析（原 operator/reports）物理迁入数据中心
    { href: `${prefix}/classic/boss/reports/sales`, label: '销售分析' },
    { href: `${prefix}/classic/boss/reports/purchasing`, label: '采购分析' },
    { href: `${prefix}/classic/boss/reports/logistics`, label: '物流分析（报表）' },
    // 数据库备份涉及全库敏感数据，按权限点收紧（本 layout 本身放行 BOSS+OPERATOR）
    ...(canBackup
      ? [
          { href: '', label: '│' },
          { href: `${prefix}/classic/boss/system/backups`, label: '数据库备份' },
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
      <OdooNav appName="报表" menuItems={LINKS} session={session} />
      <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>
    </div>
  )
}
