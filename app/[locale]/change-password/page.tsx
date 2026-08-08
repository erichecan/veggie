'use client'
/**
 * 自助改密页。两种进入方式：
 *   1. 弱口令账号登录后被强制送到这里（`?forced=1`），改完才能用系统
 *   2. 任何人主动来改自己的密码
 *
 * 强制模式下不给「跳过」——那个按钮一存在，这件事就永远不会做完。
 */
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiPost } from '@/lib/api'
import { getSession, logout } from '@/lib/session'
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy'

const PURPLE = '#875A7B'

export default function ChangePasswordPage() {
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const [forced, setForced] = useState(false)
  const [who, setWho] = useState<string>('')
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const s = getSession()
    setWho(s?.email ?? '')
    const q = new URLSearchParams(window.location.search)
    setForced(q.get('forced') === '1' || Boolean(s?.mustChangePassword))
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (next !== confirm) {
      setError(isEn ? 'The two new passwords do not match' : '两次输入的新密码不一致')
      return
    }
    setSaving(true)
    try {
      await apiPost('/api/auth/change-password', { currentPassword: current, newPassword: next })
      setDone(true)
      // 改密后旧 token 已作废（permVersion 已 bump），必须重新登录
      logout()
      setTimeout(() => router.replace(`${prefix}/enter`), 1800)
    } catch (err) {
      setError(err instanceof Error ? err.message : (isEn ? 'Failed' : '修改失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8" style={{ background: '#f5f0f8' }}>
      <div className="w-full max-w-sm space-y-5">
        <div className="text-center">
          <div className="text-4xl mb-3">🔒</div>
          <h1 className="text-2xl font-bold" style={{ color: '#4a2545' }}>
            {isEn ? 'Change Password' : '修改密码'}
          </h1>
          {who && <p className="text-xs mt-1 text-gray-500 font-mono">{who}</p>}
        </div>

        {forced && !done && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {isEn
              ? 'Your account still uses the default password that was set when it was created. Please choose your own before continuing.'
              : '这个账号还在用创建时的初始密码。请先设置一个只有你知道的密码，然后才能使用系统。'}
          </div>
        )}

        {done ? (
          <div className="rounded-2xl shadow-sm border p-5 text-center space-y-2" style={{ background: 'white', borderColor: '#d4b8d0' }}>
            <p className="text-sm font-medium text-green-700">
              {isEn ? 'Password changed.' : '密码已修改。'}
            </p>
            <p className="text-xs text-gray-500">
              {isEn ? 'Taking you to the sign-in page…' : '正在带你回到登录页…'}
            </p>
          </div>
        ) : (
          <form onSubmit={submit} className="rounded-2xl shadow-sm border p-5 space-y-3"
            style={{ background: 'white', borderColor: '#d4b8d0' }}>
            <input
              type="password" value={current} onChange={(e) => setCurrent(e.target.value)}
              placeholder={isEn ? 'Current password' : '当前密码'}
              className="w-full rounded-lg px-3 py-2.5 text-sm outline-none border"
              style={{ borderColor: '#d4b8d0' }}
              required autoComplete="current-password"
            />
            <input
              type="password" value={next} onChange={(e) => setNext(e.target.value)}
              placeholder={isEn ? `New password (min ${PASSWORD_MIN_LENGTH})` : `新密码（至少 ${PASSWORD_MIN_LENGTH} 位）`}
              className="w-full rounded-lg px-3 py-2.5 text-sm outline-none border"
              style={{ borderColor: '#d4b8d0' }}
              required autoComplete="new-password"
            />
            <input
              type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              placeholder={isEn ? 'Confirm new password' : '确认新密码'}
              className="w-full rounded-lg px-3 py-2.5 text-sm outline-none border"
              style={{ borderColor: '#d4b8d0' }}
              required autoComplete="new-password"
            />
            <p className="text-[11px] text-gray-400">
              {isEn
                ? 'At least two of: letters, digits, symbols. Cannot contain your email name or a common weak password.'
                : '至少包含字母、数字、符号中的两类；不能包含自己的邮箱名，也不能是常见弱口令。'}
            </p>
            {error && (
              <div className="text-red-600 text-sm bg-red-50 rounded-lg px-3 py-2">{error}</div>
            )}
            <button
              type="submit" disabled={saving}
              className="w-full disabled:opacity-50 text-white font-medium py-2.5 rounded-lg text-sm"
              style={{ background: PURPLE }}
            >
              {saving ? (isEn ? 'Saving…' : '提交中…') : (isEn ? 'Change password' : '修改密码')}
            </button>
            {!forced && (
              <button
                type="button" onClick={() => router.back()}
                className="w-full text-xs text-gray-500 hover:underline pt-1"
              >
                {isEn ? 'Cancel' : '取消'}
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  )
}
