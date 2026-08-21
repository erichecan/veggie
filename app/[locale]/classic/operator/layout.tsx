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

export default function ClassicOperatorLayout({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<RoleSession | null>(null)
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  // 导航分三组（2026-04-19 修改意见 #15 对齐）：
  //   Group A - 业务主流程：订单 → 拣货波次 → 分货 → 配送单 → 发票（平铺）
  //   Group B - 主数据：商品 → 客户 → 价格表 → 计量单位（平铺，客户要求可见可点，勿再折叠）
  //   Group C - 系统管理：用户管理（平铺）。⛔ 整条导航不再有任何折叠分组，
  //     客户 20260821 明确要求：常用菜单一律直接展示，不要下拉。
  // 英文版标签一律取短词（Units 而非 Units of Measure），否则整行会横向溢出
  // 数据分析中心插在「日销售中心」后面（Group A 内），不再单独分组
  const en = locale !== routing.defaultLocale
  const MENU_ITEMS = [
    // Group A（平铺）
    // 工作台已下线，隐藏导航入口（/classic/operator 会重定向到下单页）
    // { href: `${prefix}/classic/operator`, label: en ? 'Workbench' : '工作台' },
    { href: `${prefix}/classic/operator/quotations`, label: en ? 'Place Order' : '下单', activePaths: [`${prefix}/classic/operator/place-order`] },
    { href: `${prefix}/classic/operator/orders`,    label: en ? 'Orders'  : '销售单' },
    // 拣货波次、配送单已整合进「配送中心」，隐藏独立入口
    // { href: `${prefix}/classic/operator/waves`,     label: en ? 'Pick Waves'    : '拣货波次' },
    // { href: `${prefix}/classic/operator/sorting`,   label: en ? 'Sorting'       : '分货' },
    // { href: `${prefix}/classic/operator/trips`,     label: en ? 'Deliveries'    : '配送单' },
    { href: `${prefix}/classic/operator/dispatch-console`, label: en ? 'Dispatch' : '配送中心', activePaths: [`${prefix}/classic/operator/dispatch-console`] },
    { href: `${prefix}/classic/operator/daily-sales`, label: en ? 'Daily Sales' : '日销售中心' },
    // 数据分析中心：临时先屏蔽权限校验，让 OPERATOR 直接进入老板视角的分析页面（见 boss/layout.tsx + 相关 API 的 allowedRoles）
    // newTab: 老板视角是独立的导航体系，没有返回入口，新标签页打开避免用户回不去
    { href: `${prefix}/classic/boss`,   label: en ? 'Analytics' : '数据分析中心',
      newTab: true },
    // 发票 + 供应商账单合并到「会计」tab 式页面
    { href: `${prefix}/classic/operator/accounting`, label: en ? 'Accounting' : '会计', activePaths: [`${prefix}/classic/operator/accounting`] },
    { href: `${prefix}/classic/operator/returns`,  label: en ? 'Returns'       : '退换货' },
    // 信用票已隐藏导航入口
    // { href: `${prefix}/classic/operator/credit-notes`, label: en ? 'Credit Notes' : '信用票' },
    { href: `${prefix}/classic/operator/purchases`, label: en ? 'Purchases'     : '采购' },
    // 采购建议已整合进「库存管理」tab，供应商账单已移至发票旁，隐藏/移除此处入口
    // { href: `${prefix}/classic/operator/purchases/suggestions`, label: en ? 'Purchase Suggestions' : '采购建议' },
    { href: `${prefix}/classic/operator/inventory`, label: en ? 'Inventory'     : '库存管理', activePaths: [`${prefix}/classic/operator/inventory`] },
    // 报表分析（台账 H2）：Odoo 式可组合报表，销售/采购/物流三张。
    // ⚠️ 这三页此前代码全在、接口能返数据，却没有任何入口链接过去——功能到不了等于不存在
    { href: `${prefix}/classic/operator/reports/sales`, label: en ? 'Reports' : '报表分析', activePaths: [`${prefix}/classic/operator/reports`] },
    // divider
    { href: '', label: '│' },
    // Group B - 主数据（平铺）
    { href: `${prefix}/classic/operator/products`,  label: en ? 'Products'   : '商品' },
    { href: `${prefix}/classic/operator/customers`, label: en ? 'Customers'  : '客户' },
    { href: `${prefix}/classic/operator/pricelists`,label: en ? 'Pricelists' : '价格表' },
    { href: `${prefix}/classic/operator/settings/units`, label: en ? 'Units' : '计量单位' },
    // 司机配置已并入「配送调度中心」，隐藏独立导航入口
    // { href: `${prefix}/classic/operator/drivers`,        label: en ? 'Drivers'          : '司机配置' },
    // Group C - 系统（平铺）。原先折叠成「系统设置」下拉，客户 20260821 明确要求
    // 去掉分组标签、所有菜单直接可见可点，因此这里不再用 MenuGroup。
    { href: `${prefix}/classic/operator/users`, label: en ? 'Users' : '用户管理' },
  ]

  useEffect(() => {
    const user = getSession()
    if (!user || !canEnterPage(user, '/classic/operator', ['OPERATOR'])) {
      router.push(`${prefix}/enter`)
      return
    }
    setSession(toRoleSession(user))
    hydrate()
  }, [router, prefix])

  return (
    <div className="min-h-screen" style={{ background: '#f5f5f5' }}>
      <OdooNav session={session} appName={en ? 'Sales' : '销售'} menuItems={MENU_ITEMS} />
      <main>{children}</main>
    </div>
  )
}
