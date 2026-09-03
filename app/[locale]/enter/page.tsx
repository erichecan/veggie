'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { routing } from '@/i18n/routing'
import { getDefaultLandingPath } from '@/lib/rbac/page-guard'

export default function EnterPage() {
  const router = useRouter()
  const locale = useLocale()
  const t = useTranslations('enter')

  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState<string | null>(null)
  const [permissionChanged, setPermissionChanged] = useState(false)

  // 被 lib/api.ts 以 ?reason=permission-changed 踢回来的。直接读 location 而不用
  // useSearchParams：后者会把这个页面拖进 Suspense 边界的要求里，为一行提示不值得。
  useEffect(() => {
    if (typeof window === 'undefined') return
    const reason = new URLSearchParams(window.location.search).get('reason')
    setPermissionChanged(reason === 'permission-changed')
  }, [])

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
      // cookie 由登录接口的 Set-Cookie 下发（HttpOnly），这里只存 localStorage
      // 供 lib/api.ts 的 Authorization 头使用
      localStorage.setItem('veggie_token', data.token)
      localStorage.setItem('veggie_user', JSON.stringify(data.user))
      // 还在用初始密码的账号先去改密码 —— 后端也会挡（withAuth 的
      // PASSWORD_CHANGE_REQUIRED），这里跳转只是别让人先看到一屏 403
      if (data.user.mustChangePassword) {
        router.replace(`${prefix}/change-password?forced=1`)
        return
      }
      router.replace(getDefaultLandingPath(data.user, prefix))
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

        {/*
          ⛔ 这里原来是「一键登录」：6 个演示账号按钮 + 前端写死的密码 `Demo1234!`，
          点一下就以 BOSS 身份进系统。开发期方便，但这套东西现在跑在客户的公网域名上，
          等于把管理员入口敞开给任何打开登录页的人。20260807 已移除，只保留邮箱 + 密码。

          ⚠️ 移除按钮**不等于**账号安全了 —— 那 6 个账号仍然存在且密码仍是 Demo1234!，
          知道邮箱的人照样能登进来。真正的修复是改密码，见
          docs/20260807-production-credentials-audit.md。
        */}

        {/* 登录 */}
        <form
          onSubmit={e => { e.preventDefault(); doLogin(email, password, 'form') }}
          className="rounded-2xl shadow-sm border p-5 space-y-3"
          style={{ background: 'white', borderColor: '#d4b8d0' }}
        >
          <p className="text-xs font-medium" style={{ color: '#875A7B' }}>{t('manualTitle')}</p>
          {permissionChanged && (
            <div className="text-amber-800 text-sm bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              {locale === routing.defaultLocale
                ? '您的权限已被管理员调整，请重新登录后生效。'
                : 'Your permissions were changed by an administrator — sign in again for them to take effect.'}
            </div>
          )}
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
