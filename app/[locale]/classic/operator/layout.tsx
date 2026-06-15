'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import OdooNav from '@/components/classic/OdooNav'
import { getSession, toRoleSession } from '@/lib/session'
import { hydrate } from '@/lib/store'
import type { RoleSession } from '@/lib/types'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'

export default function ClassicOperatorLayout({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<RoleSession | null>(null)
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  // 导航分三组（2026-04-19 修改意见 #15 对齐）：
  //   Group A - 业务主流程：订单 → 拣货波次 → 分货 → 配送单 → 发票
  //   Group B - 主数据：商品 → 客户 → 价格表 → 计量单位
  //   Group C - 系统管理：用户
  // 空 href 的 `│` 作分隔符渲染（OdooNav 支持）
  const en = locale !== routing.defaultLocale
  const MENU_ITEMS = [
    // Group A
    { href: `${prefix}/classic/operator`, label: en ? 'Workbench' : '工作台' },
    { href: `${prefix}/classic/operator/quotations`, label: en ? 'Place Order' : '下单', activePaths: [`${prefix}/classic/operator/place-order`] },
    { href: `${prefix}/classic/operator/orders`,    label: en ? 'Sales Orders'  : '销售单' },
    { href: `${prefix}/classic/operator/waves`,     label: en ? 'Pick Waves'    : '拣货波次' },
    // { href: `${prefix}/classic/operator/sorting`,   label: en ? 'Sorting'       : '分货' },
    { href: `${prefix}/classic/operator/trips`,     label: en ? 'Deliveries'    : '配送单' },
    { href: `${prefix}/classic/operator/dispatch-console`, label: en ? 'Dispatch Console' : '配送调度中心', activePaths: [`${prefix}/classic/operator/dispatch-console`] },
    { href: `${prefix}/classic/operator/invoices`,  label: en ? 'Invoices'      : '发票' },
    { href: `${prefix}/classic/operator/returns`,  label: en ? 'Returns'       : '退换货' },
    { href: `${prefix}/classic/operator/credit-notes`, label: en ? 'Credit Notes' : '信用票' },
    { href: `${prefix}/classic/operator/purchases`, label: en ? 'Purchases'     : '采购' },
    { href: `${prefix}/classic/operator/purchases/suggestions`, label: en ? 'Purchase Suggestions' : '采购建议' },
    { href: `${prefix}/classic/operator/vendor-bills`, label: en ? 'Vendor Bills' : '供应商账单' },
    { href: `${prefix}/classic/operator/inventory`, label: en ? 'Inventory'     : '库存管理', activePaths: [`${prefix}/classic/operator/inventory`] },
    // divider
    { href: '', label: '│' },
    // Group B
    { href: `${prefix}/classic/operator/products`,  label: en ? 'Products'      : '商品' },
    { href: `${prefix}/classic/operator/customers`, label: en ? 'Customers'     : '客户' },
    { href: `${prefix}/classic/operator/pricelists`,label: en ? 'Pricelists'    : '价格表' },
    { href: `${prefix}/classic/operator/settings/units`, label: en ? 'Units of Measure' : '计量单位' },
    { href: `${prefix}/classic/operator/drivers`,        label: en ? 'Drivers'          : '司机配置' },
    // divider
    { href: '', label: '│' },
    // Group C – 分析
    { href: `${prefix}/classic/operator/reports/sales`,       label: en ? 'Sales Analysis'  : '销售分析',
      activePaths: [`${prefix}/classic/operator/reports/sales`] },
    { href: `${prefix}/classic/operator/reports/purchasing`,  label: en ? 'Purchase Analysis' : '采购分析',
      activePaths: [`${prefix}/classic/operator/reports/purchasing`] },
    { href: `${prefix}/classic/operator/reports/logistics`,   label: en ? 'Logistics Analysis' : '物流分析',
      activePaths: [`${prefix}/classic/operator/reports/logistics`] },
    // divider
    { href: '', label: '│' },
    // Group D
    { href: `${prefix}/classic/operator/users`,     label: en ? 'User Management' : '系统用户管理' },
  ]

  useEffect(() => {
    const user = getSession()
    if (!user || user.role !== 'OPERATOR') {
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
