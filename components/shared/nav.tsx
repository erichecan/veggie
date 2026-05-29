'use client'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { useState, useRef, useEffect } from 'react'
import { StoreAPI } from '@/lib/store'
import { logout as clearSession } from '@/lib/session'
import type { RoleSession } from '@/lib/types'
import HelpDrawer from '@/components/onboarding/HelpDrawer'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiPost } from '@/lib/api'
import { toast } from 'sonner'
import { useTranslations, useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'

interface NavProps {
  session: RoleSession | null
  links?: { href: string; label: string }[]
  /** If provided, renders the ? help button wired to HelpDrawer for this role */
  onReplayTour?: () => void
}

export default function Nav({ session, links = [], onReplayTour }: NavProps) {
  const router = useRouter()
  const pathname = usePathname()
  const locale = useLocale()
  const t = useTranslations('nav')
  const tRoles = useTranslations('roles')

  const [pwdOpen, setPwdOpen] = useState(false)
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [saving, setSaving] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function doLogout() {
    StoreAPI.setRole(null)
    clearSession()
    // Redirect to enter page, preserving locale
    const enterPath = locale === routing.defaultLocale ? '/enter' : `/${locale}/enter`
    router.push(enterPath)
  }

  function openChangePwd() {
    setOldPwd('')
    setNewPwd('')
    setConfirmPwd('')
    setPwdOpen(true)
  }

  async function handleChangePwd() {
    if (!oldPwd) { toast.error(t('pwdErrors.currentRequired')); return }
    if (newPwd.length < 6) { toast.error(t('pwdErrors.tooShort')); return }
    if (newPwd !== confirmPwd) { toast.error(t('pwdErrors.mismatch')); return }
    setSaving(true)
    try {
      await apiPost('/api/auth/change-password', { oldPassword: oldPwd, newPassword: newPwd })
      toast.success(t('pwdErrors.success'))
      setPwdOpen(false)
      setTimeout(doLogout, 1000)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('pwdErrors.failed'))
    } finally {
      setSaving(false)
    }
  }

  function switchLanguage() {
    setMenuOpen(false)
    const otherLocale = locale === 'zh' ? 'en' : 'zh'

    // Strip the current locale prefix if present
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

    const newPath = otherLocale === routing.defaultLocale
      ? pathWithoutLocale || '/'
      : `/${otherLocale}${pathWithoutLocale}`

    // 关键：写 NEXT_LOCALE cookie（next-intl 读这个 cookie 决定 locale）
    // 不写的话 middleware 会按 cookie 把 /x 再次重定向回 /en/x，导致"切不回中文"
    document.cookie = `NEXT_LOCALE=${otherLocale}; path=/; max-age=${365 * 24 * 3600}; SameSite=Lax`

    // 硬刷而不是 router.push，确保 cookie 和 JS state 一起重置
    window.location.href = newPath
  }

  const helpRole = session?.role?.toUpperCase()

  const ROLE_LABELS: Record<string, string> = {
    operator: tRoles('operator'),
    restaurant: tRoles('restaurant'),
    picker: tRoles('picker'),
    sorter: tRoles('sorter'),
    driver: tRoles('driver'),
    boss: tRoles('boss'),
    finance: tRoles('finance'),
    warehouse: tRoles('warehouse'),
  }

  return (
    <>
      <header className="sticky top-0 z-40 bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4 min-w-0">
          <div className="flex items-center gap-4 min-w-0 flex-1">
            <Link
              href={locale === routing.defaultLocale ? '/' : `/${locale}`}
              className="text-green-700 font-bold text-lg flex items-center gap-1 flex-shrink-0"
            >
              {t('brand')}
            </Link>
            {/* 手机上 nav 横向滚动，不会挤压头像和退出按钮 */}
            <nav className="flex items-center gap-1 overflow-x-auto no-scrollbar min-w-0 flex-1">
              {links.map((l, i) => (
                l.href === ''
                  ? <span key={`sep-${i}`} className="text-gray-300 px-2 select-none flex-shrink-0" aria-hidden>│</span>
                  : <Link
                      key={l.href}
                      href={l.href}
                      className="px-3 py-1.5 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors whitespace-nowrap flex-shrink-0"
                    >
                      {l.label}
                    </Link>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3 text-sm">
            {session && (
              <>
                {helpRole && (
                  <HelpDrawer
                    role={helpRole}
                    onReplayTour={onReplayTour}
                  />
                )}

                <div className="relative" ref={menuRef}>
                  <button
                    onClick={() => setMenuOpen(v => !v)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-gray-600 hover:bg-gray-100 border border-gray-200 transition-colors"
                  >
                    <span className="text-gray-400">{ROLE_LABELS[session.role] ?? session.role}</span>
                    <strong className="text-gray-800">{session.name}</strong>
                    <svg className={`w-3.5 h-3.5 text-gray-400 transition-transform ${menuOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>

                  {menuOpen && (
                    <div className="absolute right-0 top-full mt-1 w-44 bg-white rounded-lg border border-gray-200 shadow-lg py-1 z-50">
                      <button
                        onClick={switchLanguage}
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                      >
                        <span>🌐</span> {t('switchLang')}
                      </button>
                      <div className="border-t border-gray-100 my-1" />
                      <button
                        onClick={() => { setMenuOpen(false); openChangePwd() }}
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                      >
                        <span>🔑</span> {t('changePwd')}
                      </button>
                      {session?.role === 'operator' && (
                        <>
                          <div className="border-t border-gray-100 my-1" />
                          <button
                            onClick={() => {
                              setMenuOpen(false)
                              const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
                              router.push(`${prefix}/operator/settings`)
                            }}
                            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                          >
                            <span>⚙️</span> {locale === routing.defaultLocale ? '设置' : 'Settings'}
                          </button>
                          <button
                            onClick={() => {
                              setMenuOpen(false)
                              const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
                              router.push(`${prefix}/classic/operator`)
                            }}
                            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                          >
                            <span>🔄</span> {locale === routing.defaultLocale ? '切换到经典版' : 'Switch to Classic'}
                          </button>
                        </>
                      )}
                      <div className="border-t border-gray-100 my-1" />
                      <button
                        onClick={() => { setMenuOpen(false); doLogout() }}
                        className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                      >
                        <span>🚪</span> {t('logout')}
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <Dialog open={pwdOpen} onOpenChange={setPwdOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('pwdDialog.title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label htmlFor="old-pwd">{t('pwdDialog.currentPwd')}</Label>
              <Input
                id="old-pwd"
                type="password"
                className="mt-1"
                value={oldPwd}
                onChange={e => setOldPwd(e.target.value)}
                placeholder={t('pwdDialog.currentPwdPlaceholder')}
                autoComplete="current-password"
              />
            </div>
            <div>
              <Label htmlFor="new-pwd">{t('pwdDialog.newPwd')} <span className="text-gray-400 font-normal text-xs">{t('pwdDialog.newPwdHint')}</span></Label>
              <Input
                id="new-pwd"
                type="password"
                className="mt-1"
                value={newPwd}
                onChange={e => setNewPwd(e.target.value)}
                placeholder={t('pwdDialog.newPwdPlaceholder')}
                autoComplete="new-password"
              />
            </div>
            <div>
              <Label htmlFor="confirm-pwd">{t('pwdDialog.confirmPwd')}</Label>
              <Input
                id="confirm-pwd"
                type="password"
                className="mt-1"
                value={confirmPwd}
                onChange={e => setConfirmPwd(e.target.value)}
                placeholder={t('pwdDialog.confirmPwdPlaceholder')}
                autoComplete="new-password"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPwdOpen(false)} disabled={saving}>{t('pwdDialog.cancel')}</Button>
            <Button className="bg-green-600 hover:bg-green-700" onClick={handleChangePwd} disabled={saving}>
              {saving ? t('pwdDialog.saving') : t('pwdDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
