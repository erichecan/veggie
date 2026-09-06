'use client'
import { useState, useRef, useEffect } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiPost } from '@/lib/api'
import type { AnalysisDsl } from '@/lib/analytics-chat/dsl-schema'
import { ChatEntryView, type ChatEntry, type ResultData } from './_components/ChatEntryView'
import { SaveReportBar } from './_components/SaveReportBar'

interface MessageResponse {
  status: 'confirm' | 'unsupported' | 'error'
  dsl?: AnalysisDsl
  confirmationText?: string
  reason?: string
}

export default function AnalyticsChatPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale

  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [savingDsl, setSavingDsl] = useState<AnalysisDsl | null>(null)
  const lastDslRef = useRef<AnalysisDsl | null>(null)
  const listEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries])

  async function send() {
    const question = input.trim()
    if (!question || busy) return
    setInput('')
    setEntries((prev) => [...prev, { kind: 'user', text: question }])
    setBusy(true)
    try {
      const res = await apiPost<MessageResponse>('/api/analytics-chat/message', {
        question,
        priorDsl: lastDslRef.current,
      })
      if (res.status === 'confirm' && res.dsl && res.confirmationText) {
        setEntries((prev) => [...prev, { kind: 'confirm', dsl: res.dsl!, text: res.confirmationText! }])
      } else {
        setEntries((prev) => [...prev, { kind: 'info', text: res.reason ?? (isEn ? 'Sorry, I could not understand this question.' : '抱歉，这个问题我理解不了。') }])
      }
    } catch (e) {
      setEntries((prev) => [...prev, { kind: 'info', text: e instanceof Error ? e.message : (isEn ? 'Request failed' : '请求失败') }])
    } finally {
      setBusy(false)
    }
  }

  async function confirmDsl(dsl: AnalysisDsl, text: string) {
    setBusy(true)
    setEntries((prev) => prev.map((e) => (e.kind === 'confirm' && e.text === text && !e.resolved ? { ...e, resolved: 'confirmed' } : e)))
    try {
      const res = await apiPost<{ dsl: AnalysisDsl } & ResultData>('/api/analytics-chat/confirm', {
        dsl, rawQuestion: text,
      })
      lastDslRef.current = res.dsl
      setEntries((prev) => [...prev, { kind: 'result', dsl: res.dsl, data: { metricLabel: res.metricLabel, result: res.result, narrative: res.narrative } }])
    } catch (e) {
      setEntries((prev) => [...prev, { kind: 'info', text: e instanceof Error ? e.message : (isEn ? 'Query failed' : '查询失败') }])
    } finally {
      setBusy(false)
    }
  }

  function cancelConfirm() {
    setEntries((prev) => {
      const idx = [...prev].reverse().findIndex((e) => e.kind === 'confirm' && !e.resolved)
      if (idx === -1) return prev
      const realIdx = prev.length - 1 - idx
      const next = [...prev]
      next[realIdx] = { ...(next[realIdx] as Extract<ChatEntry, { kind: 'confirm' }>), resolved: 'cancelled' }
      return next
    })
  }

  async function saveReport(name: string) {
    if (!savingDsl) return
    try {
      await apiPost('/api/analytics-chat/reports', { name, dsl: savingDsl })
      toast.success(isEn ? 'Saved' : '已保存')
      setSavingDsl(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
    }
  }

  return (
    <div className="max-w-3xl mx-auto flex flex-col" style={{ height: 'calc(100vh - 140px)' }}>
      <h1 className="text-lg font-medium mb-3" style={{ color: '#875A7B' }}>{isEn ? 'AI Data Chat' : 'AI 问数'}</h1>
      <div className="flex-1 overflow-y-auto space-y-3 p-2 bg-gray-50 rounded border border-gray-100">
        {entries.length === 0 && (
          <p className="text-sm text-gray-400 text-center mt-8">
            {isEn ? 'Try: "sales amount by salesperson this month"' : '试试问："本月按业务员分组的销售额"'}
          </p>
        )}
        {entries.map((entry, i) => (
          <ChatEntryView
            key={i}
            entry={entry}
            isEn={isEn}
            busy={busy}
            onConfirm={confirmDsl}
            onCancel={cancelConfirm}
            onSaveReport={setSavingDsl}
          />
        ))}
        <div ref={listEndRef} />
      </div>

      {savingDsl && <SaveReportBar isEn={isEn} onSave={saveReport} onCancel={() => setSavingDsl(null)} />}

      <div className="mt-2 flex items-center gap-2 border border-gray-300 rounded h-10 px-2 bg-white">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder={isEn ? 'Ask a question about your data…' : '问一个关于经营数据的问题…'}
          className="flex-1 text-sm outline-none"
          disabled={busy}
        />
        <button
          onClick={send}
          disabled={busy || !input.trim()}
          className="h-7 px-3 text-xs rounded text-white disabled:opacity-50"
          style={{ background: '#875A7B' }}
        >
          {isEn ? 'Send' : '发送'}
        </button>
      </div>
    </div>
  )
}
