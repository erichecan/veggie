'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api'

/**
 * 客户联系人（多邮箱）管理。
 *
 * 这些邮箱就是发报价单/销售单时弹窗里的候选收件人 —— 在这里录不进来，
 * 那边就只能发给客户档案上那一个默认邮箱。
 */

interface Contact {
  id: string
  name: string
  email: string
  role: string
  phone: string
  isPrimary: boolean
  isActive: boolean
}

const EMPTY_DRAFT = { name: '', email: '', role: '', phone: '' }

export default function CustomerContactsPanel({
  customerId,
  isEn,
}: {
  customerId: string
  isEn: boolean
}) {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState(EMPTY_DRAFT)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setContacts(await apiGet<Contact[]>(`/api/customers/${customerId}/contacts`))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load contacts' : '加载联系人失败'))
    } finally {
      setLoading(false)
    }
  }, [customerId, isEn])

  useEffect(() => { load() }, [load])

  const add = async () => {
    if (saving) return
    if (!draft.name.trim() || !draft.email.trim()) {
      toast.error(isEn ? 'Name and email are required' : '姓名和邮箱不能为空')
      return
    }
    setSaving(true)
    try {
      await apiPost(`/api/customers/${customerId}/contacts`, draft)
      setDraft(EMPTY_DRAFT)
      setAdding(false)
      await load()
      toast.success(isEn ? 'Contact added' : '联系人已添加')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to add' : '添加失败'))
    } finally {
      setSaving(false)
    }
  }

  const setPrimary = async (c: Contact) => {
    if (c.isPrimary) return
    try {
      await apiPatch(`/api/customers/${customerId}/contacts/${c.id}`, { isPrimary: true })
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed' : '操作失败'))
    }
  }

  const remove = async (c: Contact) => {
    if (!confirm(isEn ? `Delete contact ${c.name} (${c.email})?` : `删除联系人 ${c.name}（${c.email}）？`)) return
    try {
      await apiDelete(`/api/customers/${customerId}/contacts/${c.id}`)
      await load()
      toast.success(isEn ? 'Contact deleted' : '联系人已删除')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to delete' : '删除失败'))
    }
  }

  return (
    <div>
      <div className="flex items-center gap-3">
        <button
          className="h-7 px-3 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
          onClick={() => setAdding((v) => !v)}
        >
          {adding ? (isEn ? 'Cancel' : '取消') : 'Add'}
        </button>
        <span className="text-xs text-gray-400">
          {isEn
            ? 'These addresses appear as recipients when emailing a quotation or order'
            : '这些邮箱会出现在发报价单/销售单的收件人选择里'}
        </span>
      </div>

      {adding && (
        <div className="mt-3 grid grid-cols-4 gap-2 rounded border border-gray-200 bg-gray-50 p-3">
          <input
            className="h-8 rounded border border-gray-300 px-2 text-sm"
            placeholder={isEn ? 'Name *' : '姓名 *'}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <input
            className="h-8 rounded border border-gray-300 px-2 text-sm"
            placeholder={isEn ? 'Email *' : '邮箱 *'}
            value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })}
          />
          <input
            className="h-8 rounded border border-gray-300 px-2 text-sm"
            placeholder={isEn ? 'Role (e.g. Purchasing)' : '职能（如：采购）'}
            value={draft.role}
            onChange={(e) => setDraft({ ...draft, role: e.target.value })}
          />
          <div className="flex gap-2">
            <input
              className="h-8 min-w-0 flex-1 rounded border border-gray-300 px-2 text-sm"
              placeholder={isEn ? 'Phone' : '电话'}
              value={draft.phone}
              onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
            />
            <button
              onClick={add}
              disabled={saving}
              className="h-8 shrink-0 rounded px-3 text-xs text-white disabled:opacity-50"
              style={{ background: '#875A7B' }}
            >
              {saving ? '…' : (isEn ? 'Save' : '保存')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="mt-3 text-sm text-gray-400">{isEn ? 'Loading…' : '加载中…'}</p>
      ) : contacts.length === 0 ? (
        <p className="mt-3 text-sm text-gray-400">
          {isEn ? 'No additional contacts yet.' : '还没有联系人。'}
        </p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-xs text-gray-500">
              <th className="py-1.5 text-left font-medium">{isEn ? 'Name' : '姓名'}</th>
              <th className="py-1.5 text-left font-medium">{isEn ? 'Email' : '邮箱'}</th>
              <th className="py-1.5 text-left font-medium">{isEn ? 'Role' : '职能'}</th>
              <th className="py-1.5 text-left font-medium">{isEn ? 'Phone' : '电话'}</th>
              <th className="py-1.5 text-center font-medium">{isEn ? 'Primary' : '主联系人'}</th>
              <th className="py-1.5" />
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id} className="border-b border-gray-100">
                <td className="py-2 text-gray-900">{c.name}</td>
                <td className="py-2 text-gray-700">{c.email}</td>
                <td className="py-2 text-gray-500">{c.role || '—'}</td>
                <td className="py-2 text-gray-500">{c.phone || '—'}</td>
                <td className="py-2 text-center">
                  <input
                    type="radio"
                    name="primary-contact"
                    checked={c.isPrimary}
                    onChange={() => setPrimary(c)}
                    className="h-4 w-4 accent-[#875A7B]"
                    aria-label={isEn ? `Set ${c.email} as primary` : `设 ${c.email} 为主联系人`}
                  />
                </td>
                <td className="py-2 text-right">
                  <button
                    onClick={() => remove(c)}
                    className="text-xs text-gray-400 hover:text-red-600"
                  >
                    {isEn ? 'Delete' : '删除'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
