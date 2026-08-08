'use client'
import { useState, useEffect, useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiGet, apiPost } from '@/lib/api'

/**
 * 把报价单 / 销售单发给客户。
 *
 * 报价单页和销售单页共用这一个组件 —— 两者本来就是同一个 Order
 * （PENDING 是报价单，确认后是销售单），措辞差异由后端按状态决定。
 */

interface Recipient {
  email: string
  name: string
  role: string
  isPrimary: boolean
  source: 'contact' | 'customer'
}

interface RecipientsResponse {
  customerName: string | null
  isQuotation: boolean
  recipients: Recipient[]
}

export default function SendEmailDialog({
  orderId,
  orderCode,
  open,
  onOpenChange,
}: {
  orderId: string
  orderCode: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [data, setData] = useState<RecipientsResponse | null>(null)
  const [to, setTo] = useState('')
  const [cc, setCc] = useState<string[]>([])
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    setDone(false)
    try {
      const res = await apiGet<RecipientsResponse>(`/api/orders/${orderId}/send-email`)
      setData(res)
      // 默认选中主联系人。没有主联系人就用第一个 —— 让用户一打开就能直接点发送
      const primary = res.recipients.find((r) => r.isPrimary) ?? res.recipients[0]
      setTo(primary?.email ?? '')
      setCc([])
    } catch (e) {
      setError(e instanceof Error ? e.message : '获取收件人失败')
    } finally {
      setLoading(false)
    }
  }, [orderId])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  // 主收件人换人时，把它从抄送里摘掉 —— 同一个人既是收件人又被抄送，会收到两封
  const pickTo = (email: string) => {
    setTo(email)
    setCc((prev) => prev.filter((e) => e !== email))
  }

  const toggleCc = (email: string) => {
    if (email === to) return
    setCc((prev) => (prev.includes(email) ? prev.filter((e) => e !== email) : [...prev, email]))
  }

  const send = async () => {
    if (!to || sending) return
    setSending(true)
    setError('')
    try {
      await apiPost(`/api/orders/${orderId}/send-email`, { to, cc })
      setDone(true)
      setTimeout(() => onOpenChange(false), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : '发送失败')
    } finally {
      setSending(false)
    }
  }

  const recipients = data?.recipients ?? []
  const isEmpty = !loading && recipients.length === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            发送{data?.isQuotation ? '报价单' : '销售单'} {orderCode}
            {data?.customerName ? ` — ${data.customerName}` : ''}
          </DialogTitle>
        </DialogHeader>

        {loading && <div className="py-8 text-center text-sm text-gray-500">加载收件人…</div>}

        {/* 一个邮箱都没有时要说清楚下一步做什么，而不是弹一个空列表让人干瞪眼 */}
        {isEmpty && (
          <div className="py-6 text-center">
            <div className="text-sm text-gray-700">该客户还没有任何邮箱地址</div>
            <div className="mt-2 text-xs text-gray-500">
              请先到「客户资料 → 联系人」里添加至少一个邮箱，再回来发送。
            </div>
          </div>
        )}

        {!loading && !isEmpty && (
          <div className="space-y-3">
            <div className="text-xs text-gray-500">
              选一个作为主收件人（收件人），其余可勾选为抄送（CC）
            </div>

            <div className="max-h-72 overflow-y-auto rounded border border-gray-200">
              {recipients.map((r) => {
                const isTo = r.email === to
                const isCc = cc.includes(r.email)
                return (
                  <div
                    key={r.email}
                    className={`flex items-center gap-3 border-b border-gray-100 px-3 py-2 last:border-b-0 ${
                      isTo ? 'bg-green-50' : ''
                    }`}
                  >
                    <input
                      type="radio"
                      name="send-email-to"
                      checked={isTo}
                      onChange={() => pickTo(r.email)}
                      className="h-4 w-4 shrink-0 accent-green-600"
                      aria-label={`设为主收件人 ${r.email}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-gray-900">{r.email}</div>
                      <div className="truncate text-xs text-gray-500">
                        {r.name}
                        {r.role ? ` · ${r.role}` : ''}
                        {r.source === 'customer' ? ' · 来自客户档案' : ''}
                      </div>
                    </div>
                    <label
                      className={`flex shrink-0 items-center gap-1 text-xs ${
                        isTo ? 'cursor-not-allowed text-gray-300' : 'cursor-pointer text-gray-600'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isCc}
                        disabled={isTo}
                        onChange={() => toggleCc(r.email)}
                        className="h-3.5 w-3.5 accent-gray-600"
                      />
                      抄送
                    </label>
                  </div>
                )
              })}
            </div>

            <div className="rounded bg-gray-50 px-3 py-2 text-xs text-gray-600">
              收件人：<span className="font-medium text-gray-900">{to || '未选择'}</span>
              {cc.length > 0 && (
                <>
                  <br />
                  抄送：<span className="font-medium text-gray-900">{cc.join('、')}</span>
                </>
              )}
              <br />
              附件：单据 PDF（与打印版本一致）
            </div>
          </div>
        )}

        {error && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        {done && (
          <div className="rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
            ✅ 已发送
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={send}
            disabled={!to || sending || isEmpty || done}
            className="rounded bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? '发送中…' : '发送'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
