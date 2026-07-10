'use client'
import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { logout as clearSession } from '@/lib/session'
import { StoreAPI } from '@/lib/store'
import type { RoleSession } from '@/lib/types'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiGet, apiPost, apiPatch } from '@/lib/api'
import { toast } from 'sonner'
import HelpDrawer from '@/components/onboarding/HelpDrawer'
import { formatDateTime } from '@/lib/format-date'

interface MenuItem {
  href: string
  label: string
  activePaths?: string[]
  /** true 时在新标签页打开（用于跳去另一个独立模块，避免用户进去后回不来） */
  newTab?: boolean
}

interface OdooNavProps {
  session: RoleSession | null
  appName: string
  menuItems: MenuItem[]
}

const APPS_ZH = [
  { label: '运营', icon: '📦', href: '/classic/operator/place-order' },
  { label: '销售单', icon: '🛒', href: '/classic/operator/orders' },
  { label: '拣货', icon: '🏭', href: '/classic/operator/dispatch-console' },
  { label: '仓库', icon: '🏪', href: '/classic/warehouse' },
  { label: '配送', icon: '🚚', href: '/classic/operator/trips' },
  { label: '发票', icon: '🧾', href: '/classic/operator/invoices' },
  { label: '退换货', icon: '↩️', href: '/classic/operator/returns' },
  { label: '会计', icon: '📒', href: '/classic/accounting' },
  { label: '采购', icon: '🛍️', href: '/classic/operator/purchases' },
  { label: '商品', icon: '🥦', href: '/classic/operator/products' },
  { label: '价格表', icon: '🏷️', href: '/classic/operator/pricelists' },
  { label: '分货员', icon: '🔀', href: '/classic/operator/sorting' },
  { label: '老板', icon: '📊', href: '/classic/boss' },
  { label: '数据分析', icon: '📈', href: '/classic/operator/reports/sales' },
  { label: '账户', icon: '👤', href: '/classic/operator/users' },
]

const APPS_EN = [
  { label: 'Operations', icon: '📦', href: '/classic/operator/customers' },
  { label: 'Orders', icon: '🛒', href: '/classic/operator/orders' },
  { label: 'Picking', icon: '🏭', href: '/classic/operator/dispatch-console' },
  { label: 'Warehouse', icon: '🏪', href: '/classic/warehouse' },
  { label: 'Delivery', icon: '🚚', href: '/classic/operator/trips' },
  { label: 'Invoices', icon: '🧾', href: '/classic/operator/invoices' },
  { label: 'Returns', icon: '↩️', href: '/classic/operator/returns' },
  { label: 'Accounting', icon: '📒', href: '/classic/accounting' },
  { label: 'Purchases', icon: '🛍️', href: '/classic/operator/purchases' },
  { label: 'Products', icon: '🥦', href: '/classic/operator/products' },
  { label: 'Pricelists', icon: '🏷️', href: '/classic/operator/pricelists' },
  { label: 'Sorter', icon: '🔀', href: '/classic/operator/sorting' },
  { label: 'Manager', icon: '📊', href: '/classic/boss' },
  { label: 'Reports', icon: '📈', href: '/classic/operator/reports/sales' },
  { label: 'Users', icon: '👤', href: '/classic/operator/users' },
]

export default function OdooNav({ session, appName, menuItems }: OdooNavProps) {
  const router = useRouter()
  const pathname = usePathname()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const APPS = isEn ? APPS_EN : APPS_ZH
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [appSwitcherOpen, setAppSwitcherOpen] = useState(false)
  const [pwdOpen, setPwdOpen] = useState(false)
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [saving, setSaving] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [notifItems, setNotifItems] = useState<Array<{ id: string; type: string; title: string; body: string; read: boolean; createdAt: string }>>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const appSwitcherRef = useRef<HTMLDivElement>(null)
  const notifRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false)
      }
      if (appSwitcherRef.current && !appSwitcherRef.current.contains(e.target as Node)) {
        setAppSwitcherOpen(false)
      }
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (!session) return
    let cancelled = false
    async function fetchUnread() {
      try {
        const data = await apiGet<{ unreadCount: number }>('/api/notifications?unreadOnly=false&pageSize=1')
        if (!cancelled) setUnreadCount(data.unreadCount)
      } catch { /* ignore */ }
    }
    fetchUnread()
    const interval = setInterval(fetchUnread, 60_000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [session])

  function doLogout() {
    StoreAPI.setRole(null)
    clearSession()
    const enterPath = locale === routing.defaultLocale ? '/enter' : `/${locale}/enter`
    router.push(enterPath)
  }

  function switchLocale() {
    setUserMenuOpen(false)
    const newLocale = locale === 'zh' ? 'en' : 'zh'
    // Strip current locale prefix if present
    let pathWithoutLocale = pathname
    for (const loc of routing.locales) {
      if (pathWithoutLocale.startsWith(`/${loc}/`)) {
        pathWithoutLocale = pathWithoutLocale.slice(loc.length + 1)
        break
      } else if (pathWithoutLocale === `/${loc}`) {
        pathWithoutLocale = '/'
        break
      }
    }
    if (!pathWithoutLocale.startsWith('/')) pathWithoutLocale = '/' + pathWithoutLocale
    const newPath = newLocale === routing.defaultLocale ? pathWithoutLocale || '/' : `/${newLocale}${pathWithoutLocale}`
    // Write cookie so next-intl keeps the chosen locale across navigation
    document.cookie = `NEXT_LOCALE=${newLocale}; path=/; max-age=${365 * 24 * 3600}; SameSite=Lax`
    window.location.href = newPath
  }

  function openChangePwd() {
    setOldPwd('')
    setNewPwd('')
    setConfirmPwd('')
    setUserMenuOpen(false)
    setPwdOpen(true)
  }

  async function handleChangePwd() {
    if (!oldPwd) { toast.error(isEn ? 'Please enter current password' : '请输入当前密码'); return }
    if (newPwd.length < 6) { toast.error(isEn ? 'Password must be at least 6 characters' : '新密码至少 6 位'); return }
    if (newPwd !== confirmPwd) { toast.error(isEn ? 'Passwords do not match' : '两次密码不一致'); return }
    setSaving(true)
    try {
      await apiPost('/api/auth/change-password', { oldPassword: oldPwd, newPassword: newPwd })
      toast.success(isEn ? 'Password changed, please log in again' : '密码已修改，请重新登录')
      setPwdOpen(false)
      setTimeout(doLogout, 1000)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed, please try again' : '修改失败，请重试'))
    } finally {
      setSaving(false)
    }
  }

  async function openNotifications() {
    setNotifOpen(v => !v)
    if (!notifOpen) {
      try {
        const data = await apiGet<{ items: typeof notifItems; unreadCount: number }>('/api/notifications?pageSize=20')
        setNotifItems(data.items)
        setUnreadCount(data.unreadCount)
      } catch { /* ignore */ }
    }
  }

  async function markAllRead() {
    try {
      await apiPatch('/api/notifications', { markAllRead: true })
      setNotifItems(prev => prev.map(n => ({ ...n, read: true })))
      setUnreadCount(0)
    } catch { /* ignore */ }
  }

  async function markRead(id: string) {
    try {
      await apiPatch('/api/notifications', { ids: [id] })
      setNotifItems(prev => prev.map(n => n.id === id ? { ...n, read: true } : n))
      setUnreadCount(prev => Math.max(0, prev - 1))
    } catch { /* ignore */ }
  }

  function appHref(href: string) {
    return locale === routing.defaultLocale ? href : `/${locale}${href}`
  }

  return (
    <>
    <header className="sticky top-0 z-40" style={{ background: '#875A7B' }}>
      <div className="flex items-center h-11 px-4 gap-0">
        {/* 应用切换器 */}
        <div className="relative mr-1" ref={appSwitcherRef}>
          <button
            onClick={() => setAppSwitcherOpen(v => !v)}
            className="flex items-center justify-center w-9 h-9 rounded hover:bg-white/10 transition-colors"
            title="切换应用"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <rect x="2" y="2" width="6" height="6" rx="1" fill="white" opacity="0.9"/>
              <rect x="12" y="2" width="6" height="6" rx="1" fill="white" opacity="0.9"/>
              <rect x="2" y="12" width="6" height="6" rx="1" fill="white" opacity="0.9"/>
              <rect x="12" y="12" width="6" height="6" rx="1" fill="white" opacity="0.9"/>
            </svg>
          </button>

          {appSwitcherOpen && (
            <div
              className="absolute left-0 top-full mt-1 bg-white rounded shadow-xl border border-gray-200 z-50 p-3"
              style={{ width: 272 }}
            >
              <p className="text-xs text-gray-400 px-1 pb-2 font-medium uppercase tracking-wide">{isEn ? 'Apps' : '应用'}</p>
              <div className="grid grid-cols-4 gap-1">
                {APPS.map(app => (
                  <Link
                    key={app.href}
                    href={appHref(app.href)}
                    onClick={() => setAppSwitcherOpen(false)}
                    className="flex flex-col items-center gap-1 p-2 rounded hover:bg-gray-50 transition-colors text-center"
                  >
                    <span className="text-2xl leading-none">{app.icon}</span>
                    <span className="text-xs text-gray-700 leading-tight">{app.label}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 应用名 */}
        <span className="text-white font-semibold text-sm mr-6 whitespace-nowrap">{appName}</span>

        {/* 二级导航 */}
        <nav className="flex items-center gap-0 flex-1 overflow-x-auto">
          {menuItems.map((item, i) => {
            // 空 href 作分隔符
            if (item.href === '') {
              return (
                <span
                  key={`sep-${i}`}
                  className="px-2 text-white/40 select-none flex-shrink-0"
                  aria-hidden
                >│</span>
              )
            }
            // 精确匹配，或以 href+'/' 开头（子页面继承高亮）
            // 但若存在更长的菜单项也匹配当前路径，则本项不激活
            // 这样可防止 /classic/operator 永远匹配所有子页面
            // activePaths 允许额外路径归属到本菜单项
            const extraPaths = item.activePaths ?? []
            const matchesExtra = extraPaths.some(p => pathname === p || pathname.startsWith(p + '/'))
            const isActive = matchesExtra || pathname === item.href || (
              pathname.startsWith(item.href + '/') &&
              !menuItems.some(other =>
                other.href !== item.href &&
                (
                  (other.href && other.href.length > item.href.length && pathname.startsWith(other.href)) ||
                  (other.activePaths ?? []).some(p => pathname === p || pathname.startsWith(p + '/'))
                )
              )
            )
            if (item.newTab) {
              return (
                <a
                  key={item.href}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3 h-11 flex items-center gap-1 text-sm whitespace-nowrap transition-colors flex-shrink-0"
                  style={{ color: 'white' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.08)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
                >
                  {item.label}
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.7">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </a>
              )
            }
            return (
              <Link
                key={item.href}
                href={item.href}
                className="px-3 h-11 flex items-center text-sm whitespace-nowrap transition-colors flex-shrink-0"
                style={{
                  color: 'white',
                  background: isActive ? 'rgba(0,0,0,0.15)' : 'transparent',
                  borderBottom: isActive ? '2px solid rgba(255,255,255,0.9)' : '2px solid transparent',
                }}
                onMouseEnter={e => {
                  if (!isActive) (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.08)'
                }}
                onMouseLeave={e => {
                  if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'
                }}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>

        {/* 帮助按钮 */}
        <div className="flex-shrink-0 mr-2">
          <HelpDrawer role={session?.role?.toUpperCase() ?? 'OPERATOR'} />
        </div>

        {/* P1-11 通知铃铛 */}
        {session && (
          <div className="relative flex-shrink-0 mr-2" ref={notifRef}>
            <button
              onClick={openNotifications}
              className="relative flex items-center justify-center w-9 h-9 rounded hover:bg-white/10 transition-colors"
              title={isEn ? 'Notifications' : '通知'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
              </svg>
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>

            {notifOpen && (
              <div className="absolute right-0 top-full mt-1 w-80 bg-white rounded-lg shadow-xl border border-gray-200 z-50 max-h-96 flex flex-col">
                <div className="flex items-center justify-between px-4 py-2.5 border-b">
                  <span className="font-semibold text-sm text-gray-800">{isEn ? 'Notifications' : '通知'}</span>
                  {unreadCount > 0 && (
                    <button onClick={markAllRead} className="text-xs hover:underline" style={{ color: '#875A7B' }}>
                      {isEn ? 'Mark all read' : '全部已读'}
                    </button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto">
                  {notifItems.length === 0 ? (
                    <p className="text-center text-gray-400 text-sm py-8">{isEn ? 'No notifications' : '暂无通知'}</p>
                  ) : (
                    notifItems.map(n => (
                      <div
                        key={n.id}
                        onClick={() => { if (!n.read) markRead(n.id) }}
                        className={`px-4 py-3 border-b last:border-b-0 cursor-pointer hover:bg-gray-50 transition-colors ${!n.read ? 'bg-purple-50/40' : ''}`}
                      >
                        <div className="flex items-start gap-2">
                          {!n.read && <span className="w-2 h-2 rounded-full bg-purple-500 mt-1.5 flex-shrink-0" />}
                          <div className="flex-1 min-w-0">
                            <p className={`text-sm ${!n.read ? 'font-medium text-gray-900' : 'text-gray-600'}`}>{n.title}</p>
                            <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{n.body}</p>
                            <p className="text-xs text-gray-300 mt-1">{formatDateTime(n.createdAt)}</p>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 用户菜单（含语言切换和修改密码） */}
        {session && (
          <div className="relative flex-shrink-0" ref={userMenuRef}>
            <button
              onClick={() => setUserMenuOpen(v => !v)}
              className="flex items-center gap-2 h-9 px-3 rounded text-sm text-white hover:bg-white/10 transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="5" r="3" fill="white" opacity="0.9"/>
                <path d="M2 13c0-3.314 2.686-5 6-5s6 1.686 6 5" stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0.9"/>
              </svg>
              <span>{session.name}</span>
              <svg className={`w-3 h-3 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 10 6">
                <path d="M1 1l4 4 4-4" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>

            {userMenuOpen && (
              <div className="absolute right-0 top-full mt-1 w-44 bg-white rounded shadow-lg border border-gray-200 py-1 z-50 text-sm">
                <button
                  onClick={switchLocale}
                  className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                >
                  <span>🌐</span> {locale === 'zh' ? 'Switch to English' : '切换为中文'}
                </button>
                <div className="border-t border-gray-100 my-1" />
                <button
                  onClick={openChangePwd}
                  className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                >
                  <span>🔑</span> {isEn ? 'Change Password' : '修改密码'}
                </button>
                {session?.role === 'operator' && (
                  <>
                    <div className="border-t border-gray-100 my-1" />
                    <button
                      onClick={() => { setUserMenuOpen(false); router.push(appHref('/classic/operator/flow')) }}
                      className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                    >
                      <span>🗺️</span> {isEn ? 'Process Map' : '业务流程图'}
                    </button>
                    <button
                      onClick={() => { setUserMenuOpen(false); router.push(appHref('/classic/operator/help')) }}
                      className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                    >
                      <span>📖</span> {isEn ? 'Help Center' : '帮助中心'}
                    </button>
                    <div className="border-t border-gray-100 my-1" />
                    <button
                      onClick={() => { setUserMenuOpen(false); router.push(appHref('/classic/operator/settings')) }}
                      className="w-full text-left px-4 py-2 text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                    >
                      <span>⚙️</span> {isEn ? 'Settings' : '设置'}
                    </button>
                  </>
                )}
                <div className="border-t border-gray-100 my-1" />
                <button
                  onClick={doLogout}
                  className="w-full text-left px-4 py-2 text-red-600 hover:bg-red-50 flex items-center gap-2"
                >
                  <span>🚪</span> {isEn ? 'Log Out' : '退出登录'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>

      <Dialog open={pwdOpen} onOpenChange={setPwdOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{isEn ? 'Change Password' : '修改密码'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label htmlFor="odoo-old-pwd">{isEn ? 'Current Password' : '当前密码'}</Label>
              <Input
                id="odoo-old-pwd"
                type="password"
                className="mt-1"
                value={oldPwd}
                onChange={e => setOldPwd(e.target.value)}
                placeholder={isEn ? 'Enter current password' : '请输入当前密码'}
                autoComplete="current-password"
              />
            </div>
            <div>
              <Label htmlFor="odoo-new-pwd">
                {isEn ? <>New Password <span className="text-gray-400 font-normal text-xs">(min 6 chars)</span></> : <>新密码 <span className="text-gray-400 font-normal text-xs">（至少 6 位）</span></>}
              </Label>
              <Input
                id="odoo-new-pwd"
                type="password"
                className="mt-1"
                value={newPwd}
                onChange={e => setNewPwd(e.target.value)}
                placeholder={isEn ? 'Enter new password' : '请输入新密码'}
                autoComplete="new-password"
              />
            </div>
            <div>
              <Label htmlFor="odoo-confirm-pwd">{isEn ? 'Confirm Password' : '确认新密码'}</Label>
              <Input
                id="odoo-confirm-pwd"
                type="password"
                className="mt-1"
                value={confirmPwd}
                onChange={e => setConfirmPwd(e.target.value)}
                placeholder={isEn ? 'Re-enter new password' : '再次输入新密码'}
                autoComplete="new-password"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPwdOpen(false)} disabled={saving}>{isEn ? 'Cancel' : '取消'}</Button>
            <Button
              onClick={handleChangePwd}
              disabled={saving}
              style={{ background: '#875A7B' }}
              className="text-white hover:opacity-90"
            >
              {saving ? (isEn ? 'Saving…' : '保存中…') : (isEn ? 'Confirm' : '确认修改')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
