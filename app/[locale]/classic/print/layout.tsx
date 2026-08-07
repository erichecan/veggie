'use client'

import { useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { getSession } from '@/lib/session'
import { canEnterPage } from '@/lib/rbac/page-guard'
import { routing } from '@/i18n/routing'

/**
 * 打印中心的页面守卫。
 *
 * 8/6 审计留下的未解决问题：这个 layout 此前**没有任何角色判定**，
 * 全靠 middleware 的 matcher 兜着 —— 哪天有人动了 matcher，打印中心就又敞开了
 * （里面是整天的销售单、拣货单、配送单，含客户与价格）。这里补上第二道。
 *
 * 打印页要出干净的纸面，所以不套导航壳，判定不过直接跳回入口。
 */
export default function PrintLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const params = useParams()
  const locale = (params?.locale as string) ?? routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const [allowed, setAllowed] = useState(false)

  useEffect(() => {
    const user = getSession()
    if (!user || !canEnterPage(user, '/classic/print', ['OPERATOR', 'BOSS', 'FINANCE', 'DISPATCH', 'SALES'])) {
      router.push(`${prefix}/enter`)
      return
    }
    setAllowed(true)
  }, [router, prefix])

  if (!allowed) return null
  return <>{children}</>
}
