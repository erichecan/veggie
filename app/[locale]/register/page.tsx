'use client'
/**
 * 餐馆自助注册：提交后新建一条「待审核」客户档案 + 登录账号，
 * 不能立即登录下单，等内部人工审核通过才激活（见 DEV-PLAN.md 20260926）。
 */
import { useState } from 'react'
import { PASSWORD_MIN_LENGTH } from '@/lib/password-policy'

const PURPLE = '#875A7B'
const BORDER = '#d4b8d0'

interface FormState {
  restaurantName: string
  contactName: string
  email: string
  password: string
  confirmPassword: string
  phone: string
  address: string
}

function emptyForm(): FormState {
  return { restaurantName: '', contactName: '', email: '', password: '', confirmPassword: '', phone: '', address: '' }
}

function FieldInput({ id, label, value, onChange, placeholder, type = 'text', required = true }: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  type?: string
  required?: boolean
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium" style={{ color: '#4a2545' }}>
        {label}{required && <span className="text-red-500"> *</span>}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg px-3 py-2.5 text-sm outline-none border"
        style={{ borderColor: BORDER }}
        onFocus={e => { (e.currentTarget as HTMLElement).style.borderColor = PURPLE; (e.currentTarget as HTMLElement).style.boxShadow = '0 0 0 2px #e8d5f0' }}
        onBlur={e => { (e.currentTarget as HTMLElement).style.borderColor = BORDER; (e.currentTarget as HTMLElement).style.boxShadow = 'none' }}
      />
    </div>
  )
}

export default function RegisterPage() {
  const [form, setForm] = useState<FormState>(emptyForm())
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  function set<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm(f => ({ ...f, [k]: v }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!form.restaurantName.trim() || !form.contactName.trim() || !form.email.trim()
      || !form.password || !form.phone.trim() || !form.address.trim()) {
      setError('带 * 的字段都要填')
      return
    }
    if (form.password.length < PASSWORD_MIN_LENGTH) {
      setError(`密码至少 ${PASSWORD_MIN_LENGTH} 位`)
      return
    }
    if (form.password !== form.confirmPassword) {
      setError('两次密码不一致')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantName: form.restaurantName.trim(),
          contactName: form.contactName.trim(),
          email: form.email.trim().toLowerCase(),
          password: form.password,
          phone: form.phone.trim(),
          address: form.address.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || '提交失败，请重试')
        return
      }
      setSubmitted(true)
    } catch {
      setError('网络错误，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-start sm:items-center justify-center px-4 pt-12 pb-8 sm:py-8" style={{ background: '#f5f0f8' }}>
        <div className="w-full max-w-sm text-center rounded-2xl shadow-sm border p-6 space-y-3" style={{ background: 'white', borderColor: BORDER }}>
          <div className="text-4xl">📝</div>
          <h1 className="text-lg font-bold" style={{ color: '#4a2545' }}>注册申请已提交</h1>
          <p className="text-sm text-gray-500 leading-relaxed">
            我们会尽快核实「{form.restaurantName}」的信息，通过后会发邮件到 <span className="font-medium" style={{ color: PURPLE }}>{form.email}</span> 通知您，届时即可用此邮箱登录下单。
          </p>
          <p className="text-xs text-gray-400">审核期间暂时无法登录，请耐心等待。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-start sm:items-center justify-center px-4 pt-12 pb-8 sm:py-8" style={{ background: '#f5f0f8' }}>
      <div className="w-full max-w-sm space-y-5">
        <div className="text-center">
          <div className="text-4xl mb-3">🟣</div>
          <h1 className="text-2xl font-bold" style={{ color: '#4a2545' }}>餐馆账号注册</h1>
          <p className="text-sm mt-1" style={{ color: '#7c5a8e' }}>提交后需内部审核通过才能登录下单</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl shadow-sm border p-5 space-y-3"
          style={{ background: 'white', borderColor: BORDER }}
        >
          <FieldInput id="r-restaurant" label="餐馆名称" value={form.restaurantName} onChange={v => set('restaurantName', v)} placeholder="如 都柏林小厨" />
          <FieldInput id="r-contact" label="联系人姓名" value={form.contactName} onChange={v => set('contactName', v)} placeholder="如 张三" />
          <FieldInput id="r-email" label="邮箱（登录账号）" type="email" value={form.email} onChange={v => set('email', v)} placeholder="用于登录，请填写常用邮箱" />
          <FieldInput id="r-phone" label="联系电话" value={form.phone} onChange={v => set('phone', v)} placeholder="08X-XXX-XXXX" />
          <FieldInput id="r-address" label="送货地址" value={form.address} onChange={v => set('address', v)} placeholder="街道、城市、邮编" />
          <FieldInput id="r-password" label="密码" type="password" value={form.password} onChange={v => set('password', v)} placeholder={`至少 ${PASSWORD_MIN_LENGTH} 位`} />
          <FieldInput id="r-confirm" label="确认密码" type="password" value={form.confirmPassword} onChange={v => set('confirmPassword', v)} placeholder="再输入一次" />

          {error && (
            <div className="text-red-600 text-sm bg-red-50 rounded-lg px-3 py-2">{error}</div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full disabled:opacity-50 text-white font-medium py-2.5 rounded-lg text-sm transition-colors"
            style={{ background: PURPLE }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#7a5070' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = PURPLE }}
          >
            {submitting ? '提交中…' : '提交注册申请'}
          </button>

          <p className="text-xs text-gray-400 text-center">
            已有账号？<a href="../enter" className="underline" style={{ color: PURPLE }}>直接登录</a>
          </p>
        </form>
      </div>
    </div>
  )
}
