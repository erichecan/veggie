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
  // AI 问数只发给 boss（analytics.chat.read 未像其它 analytics.* 权限那样普发 operator），
  // 跟其它 analytics 链接不一样，这里不能无条件放进 LINKS，否则 operator 点进去会 403。
  const [canUseAiChat, setCanUseAiChat] = useState(false)
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  // 20260920：客户要求数据中心只留几项，摘掉了 15 个分析页的导航入口，页面与接口原样保留。
  // 20260920 当天再按用户要求恢复其中 4 项：AI 问数 / 毛利分析 / 利润表 / 司机提成。
  // 其余 11 项（经营总览 / 销售统计 / 客户分析 / 采购进货分析 / 应收账龄 / 应付账龄 /
  // 采购运营 / 物流分析 / 内控审计 / 销售分析(reports/sales) / 物流分析（报表））仍摘除，
  // 要加回来就是把链接写回这个数组。
  const LINKS = [
    // 20260821：数据中心不再新标签页打开，需要一个返回销售系统的入口
    { href: `${prefix}/classic/operator`, label: isEn ? '← Back to Sales' : '← 返回销售' },
    // 20260913 的周/日钻取页面。20260920 标签从「销售钻取(月/周/日)」改名为「销售分析」：
    // 旧的同名页 boss/reports/sales（透视表口径，两套不同实现）已从导航撤下，名字不再撞车。
    { href: `${prefix}/classic/boss/sales-analysis`, label: isEn ? 'Sales Analysis' : '销售分析' },
    { href: `${prefix}/classic/boss/reports/purchasing`, label: isEn ? 'Purchase Analysis' : '采购分析' },
    ...(canUseAiChat ? [{ href: `${prefix}/classic/boss/analytics/chat`, label: isEn ? 'AI Data Chat' : 'AI 问数' }] : []),
    { href: `${prefix}/classic/boss/analytics/margin`, label: isEn ? 'Margin Analysis' : '毛利分析' },
    { href: `${prefix}/classic/boss/analytics/income-statement`, label: isEn ? 'Income Statement' : '利润表' },
    { href: `${prefix}/classic/boss/analytics/driver-commission`, label: isEn ? 'Driver Commission' : '司机提成' },
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
    setCanUseAiChat(decodePermissions(user.pm).has('analytics.chat.read'))
    hydrate()
  }, [router, prefix])

  return (
    <div className="min-h-screen bg-white">
      <OdooNav appName={isEn ? 'Reports' : '报表'} menuItems={LINKS} session={session} />
      <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>
    </div>
  )
}
