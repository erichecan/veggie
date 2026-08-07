'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { routing } from '@/i18n/routing'
import { writeAuthCookie } from '@/lib/session'

export default function EnterPage() {
  const router = useRouter()
  const locale = useLocale()
  const t = useTranslations('enter')

  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const ROLE_PATHS: Record<string, string> = {
    OPERATOR: `${prefix}/classic/operator/quotations`,
    RESTAURANT: `${prefix}/customer-portal`,
    SORTER: `${prefix}/classic/sorter`,
    DRIVER: `${prefix}/classic/driver`,
    BOSS: `${prefix}/classic/boss`,
    FINANCE: `${prefix}/classic/accounting`,
    WAREHOUSE: `${prefix}/classic/warehouse`,
  }

  const DEMO_ACCOUNTS = [
    { labelKey: 'operator' as const, email: 'operator@veggie.com' },
    { labelKey: 'warehouse' as const, email: 'warehouse@veggie.com' },
    { labelKey: 'restaurant' as const, email: 'restaurant1@veggie.com' },
    { labelKey: 'driver' as const, email: 'driver@veggie.com' },
    { labelKey: 'boss' as const, email: 'boss@veggie.com' },
    { labelKey: 'finance' as const, email: 'finance@veggie.com' },
  ]

  const PASSWORD = 'Demo1234!'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState<string | null>(null)

  async function doLogin(loginEmail: string, loginPassword: string, tag: string) {
    setError('')
    setLoading(tag)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.error || t('networkError')); return }
      writeAuthCookie(data.token)
      localStorage.setItem('veggie_token', data.token)
      localStorage.setItem('veggie_user', JSON.stringify(data.user))
      router.replace(ROLE_PATHS[data.user.role] ?? `${prefix}/`)
    } catch {
      setError(t('networkError'))
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8" style={{ background: '#f5f0f8' }}>
      <div className="w-full max-w-sm space-y-5">
        <div className="text-center">
          <div className="text-4xl mb-3">🟣</div>
          <h1 className="text-2xl font-bold" style={{ color: '#4a2545' }}>蔬菜批发系统</h1>
          <p className="text-sm mt-1" style={{ color: '#7c5a8e' }}>Odoo 风格经典界面</p>
        </div>

        {/* 一键登录 */}
        <div className="rounded-2xl shadow-sm border p-5" style={{ background: 'white', borderColor: '#d4b8d0' }}>
          <p className="text-xs font-medium mb-3" style={{ color: '#875A7B' }}>{t('demoTitle')}</p>
          <div className="grid grid-cols-3 gap-2">
            {DEMO_ACCOUNTS.map(({ labelKey, email: demoEmail }) => (
              <button
                key={demoEmail}
                onClick={() => doLogin(demoEmail, PASSWORD, demoEmail)}
                disabled={loading !== null}
                className="disabled:opacity-50 text-white text-xs font-medium py-2 rounded-lg transition-colors"
                style={{ background: '#875A7B' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#7a5070' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#875A7B' }}
              >
                {loading === demoEmail ? '···' : t(`roles.${labelKey}`)}
              </button>
            ))}
          </div>
        </div>

        {/* 手动登录 */}
        <form
          onSubmit={e => { e.preventDefault(); doLogin(email, password, 'form') }}
          className="rounded-2xl shadow-sm border p-5 space-y-3"
          style={{ background: 'white', borderColor: '#d4b8d0' }}
        >
          <p className="text-xs font-medium" style={{ color: '#875A7B' }}>{t('manualTitle')}</p>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder={t('emailPlaceholder')}
            className="w-full rounded-lg px-3 py-2.5 text-sm outline-none border"
            style={{ borderColor: '#d4b8d0' }}
            onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = '#875A7B'; (e.currentTarget as HTMLElement).style.boxShadow = '0 0 0 2px #e8d5f0' }}
            onBlur={e => { (e.currentTarget as HTMLElement).style.borderColor = '#d4b8d0'; (e.currentTarget as HTMLElement).style.boxShadow = 'none' }}
            required
            autoComplete="email"
          />
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder={t('passwordPlaceholder')}
            className="w-full rounded-lg px-3 py-2.5 text-sm outline-none border"
            style={{ borderColor: '#d4b8d0' }}
            onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = '#875A7B'; (e.currentTarget as HTMLElement).style.boxShadow = '0 0 0 2px #e8d5f0' }}
            onBlur={e => { (e.currentTarget as HTMLElement).style.borderColor = '#d4b8d0'; (e.currentTarget as HTMLElement).style.boxShadow = 'none' }}
            required
            autoComplete="current-password"
          />
          {error && (
            <div className="text-red-600 text-sm bg-red-50 rounded-lg px-3 py-2">{error}</div>
          )}
          <button
            type="submit"
            disabled={loading !== null}
            className="w-full disabled:opacity-50 text-white font-medium py-2.5 rounded-lg text-sm transition-colors"
            style={{ background: '#875A7B' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#7a5070' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#875A7B' }}
          >
            {loading === 'form' ? t('loggingIn') : t('loginBtn')}
          </button>
        </form>
      </div>
    </div>
  )
}
