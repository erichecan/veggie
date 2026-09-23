'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

interface SecondRowLink {
  href: string
  label: string
}

/**
 * 数据中心导航第二行：20260920 客户要求摘掉、20260923 又要求恢复的分析入口。
 * 不复用 OdooNav——那是全局应用外壳（应用切换器/通知/用户菜单/登出），只应该出现一次；
 * 这里只是紧贴在它下方的一条纯链接带，颜色比 OdooNav 深一档以区分层级。
 */
export default function SecondRowNav({ links }: { links: SecondRowLink[] }) {
  const pathname = usePathname()
  return (
    <nav className="flex items-center gap-0 h-9 px-4 overflow-x-auto" style={{ background: '#6b4864' }}>
      {links.map(link => {
        const isActive = pathname === link.href || pathname.startsWith(link.href + '/')
        return (
          <Link
            key={link.href}
            href={link.href}
            className="px-1.5 h-9 flex items-center text-[12px] whitespace-nowrap transition-colors flex-shrink-0"
            style={{
              color: 'white',
              background: isActive ? 'rgba(0,0,0,0.15)' : 'transparent',
              borderBottom: isActive ? '2px solid rgba(255,255,255,0.9)' : '2px solid transparent',
            }}
            onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.08)' }}
            onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            {link.label}
          </Link>
        )
      })}
    </nav>
  )
}
