'use client'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import type { OdooPricelist } from '@/lib/types'
import type { PricelistUsage } from '@/lib/pricelist-archive'
import PricelistSearchInput from '@/components/classic/PricelistSearchInput'

const PURPLE = '#875A7B'

/**
 * 归档价格表 / 批量替换客户价格表 共用的弹窗（20261030）。
 *
 * - mode='archive'：列出挂着这张表的全部客户，必须先选「替换为另一张表」或「直接移除」，
 *   确认后挪客户 + 归档在同一个事务里完成（POST /api/pricelists/:id/customers archive=true）。
 *   被别的启用中价格表的公式引用时不允许归档。
 * - mode='replace'：同一套挪客户逻辑但不归档，可以只勾一部分客户——主要用来清理存量
 *   「挂着已归档价格表」的客户，也能用于日常换表。
 */
export default function PricelistCustomersDialog({ mode, pricelist, allLists, onClose, onDone, isEn }: {
  mode: 'archive' | 'replace'
  pricelist: Pick<OdooPricelist, 'id' | 'name'>
  allLists: OdooPricelist[]
  onClose: () => void
  /** 处理成功后回调；archived 表示这张表已归档 */
  onDone: (archived: boolean) => void
  isEn: boolean
}) {
  const [usage, setUsage] = useState<PricelistUsage | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [action, setAction] = useState<'replace' | 'remove'>('replace')
  const [replacementId, setReplacementId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    apiGet<PricelistUsage>(`/api/pricelists/${pricelist.id}/customers`)
      .then(u => {
        setUsage(u)
        setSelected(new Set(u.customers.map(c => c.customerId)))
      })
      .catch(e => setLoadError(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败')))
  }, [pricelist.id, isEn])

  // 跟客户详情页可挂的范围一致：启用中 + 可选，且不能是它自己
  const replacementOptions = useMemo(
    () => allLists.filter(p => p.id !== pricelist.id && p.active !== false && p.selectable !== false),
    [allLists, pricelist.id],
  )
  const replacement = replacementOptions.find(p => p.id === replacementId) ?? null

  const customers = usage?.customers ?? []
  const targetCustomers = mode === 'archive' ? customers : customers.filter(c => selected.has(c.customerId))
  // 移除后没有别的价格表 → 退回牌价，价格会变，要单独点出来
  const fallbackToListPrice = action === 'remove' ? targetCustomers.filter(c => c.otherPricelistCount === 0) : []
  const blockedByRefs = mode === 'archive' && (usage?.referencedBy.length ?? 0) > 0

  const canSubmit = !!usage && !submitting && !blockedByRefs
    && (targetCustomers.length === 0
      ? mode === 'archive'
      : (action === 'remove' || !!replacement))

  async function submit() {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const allSelected = targetCustomers.length === customers.length
      const res = await apiPost<{ replaced: number; merged: number; removed: number; archived: boolean }>(
        `/api/pricelists/${pricelist.id}/customers`,
        {
          replacementId: action === 'replace' ? replacementId : null,
          ...(mode === 'replace' && !allSelected ? { customerIds: targetCustomers.map(c => c.customerId) } : {}),
          archive: mode === 'archive',
        },
      )
      const moved = res.replaced + res.merged + res.removed
      toast.success(mode === 'archive'
        ? (isEn ? `Archived; ${moved} customer(s) updated` : `已归档，处理了 ${moved} 个客户`)
        : (isEn ? `${moved} customer(s) updated` : `已处理 ${moved} 个客户`))
      onDone(res.archived)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed' : '处理失败'))
    } finally {
      setSubmitting(false)
    }
  }

  const title = mode === 'archive'
    ? (isEn ? `Archive pricelist "${pricelist.name}"` : `归档价格表「${pricelist.name}」`)
    : (isEn ? `Replace "${pricelist.name}" on customers` : `批量替换客户的价格表「${pricelist.name}」`)

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" style={{ border: '1px solid #ddd' }}>
        <div className="flex items-center justify-between px-6 py-3" style={{ borderBottom: '1px solid #e5e5e5' }}>
          <h2 className="text-sm font-medium text-gray-700">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
        </div>

        <div className="px-6 py-4 overflow-y-auto flex-1 text-sm space-y-4">
          {loadError && <p className="text-red-600">{loadError}</p>}
          {!usage && !loadError && <p className="text-gray-400">{isEn ? 'Loading…' : '加载中…'}</p>}

          {usage && blockedByRefs && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-red-700 text-xs">
              {isEn
                ? 'Cannot archive: formula rules in these active pricelists are based on this pricelist. Change those rules first:'
                : '不能归档：以下启用中的价格表有公式规则以这张表为基准，请先修改这些规则：'}
              <ul className="list-disc ml-5 mt-1">
                {usage.referencedBy.map(r => <li key={r.id}>{r.name}</li>)}
              </ul>
            </div>
          )}

          {usage && customers.length === 0 && (
            <p className="text-gray-600">
              {mode === 'archive'
                ? (isEn ? 'No customer uses this pricelist. It can be archived directly.' : '没有客户使用这张价格表，可以直接归档。')
                : (isEn ? 'No customer uses this pricelist.' : '没有客户使用这张价格表。')}
            </p>
          )}

          {usage && customers.length > 0 && (
            <>
              <p className="text-gray-600">
                {mode === 'archive'
                  ? (isEn
                      ? `${customers.length} customer(s) use this pricelist. An archived pricelist can't stay on customers — choose what to do with them:`
                      : `有 ${customers.length} 个客户在用这张价格表。归档后不能继续挂在客户上，请选择如何处理：`)
                  : (isEn
                      ? `${customers.length} customer(s) use this pricelist. Choose the customers and what to do:`
                      : `有 ${customers.length} 个客户在用这张价格表，勾选要处理的客户并选择处理方式：`)}
              </p>

              <div className="space-y-2">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="radio" checked={action === 'replace'} onChange={() => setAction('replace')} className="mt-1" style={{ accentColor: PURPLE }} />
                  <div className="flex-1">
                    <div className="text-gray-800">{isEn ? 'Replace with another pricelist (keeps its priority position)' : '替换为另一张价格表（保留原来的优先级位置）'}</div>
                    {action === 'replace' && (
                      <div className="mt-1.5">
                        {replacement ? (
                          <div className="flex items-center gap-2">
                            <span className="px-2 py-1 rounded text-xs font-medium" style={{ background: '#f3eff5', color: PURPLE }}>{replacement.name}</span>
                            <button type="button" onClick={() => setReplacementId(null)} className="text-xs text-gray-500 hover:underline">
                              {isEn ? 'Change' : '更换'}
                            </button>
                          </div>
                        ) : (
                          <PricelistSearchInput
                            pricelists={replacementOptions}
                            onSelect={p => setReplacementId(p.id)}
                            placeholder={isEn ? 'Search a pricelist…' : '搜索价格表…'}
                            emptyText={isEn ? 'No matching pricelist' : '没有匹配的价格表'}
                            inputClassName="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:border-[#875A7B]"
                          />
                        )}
                      </div>
                    )}
                  </div>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="radio" checked={action === 'remove'} onChange={() => setAction('remove')} className="mt-1" style={{ accentColor: PURPLE }} />
                  <div className="text-gray-800">{isEn ? 'Remove it from these customers' : '直接从这些客户上移除'}</div>
                </label>
              </div>

              {fallbackToListPrice.length > 0 && (
                <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800 text-xs">
                  {isEn
                    ? `${fallbackToListPrice.length} customer(s) have no other pricelist. After removal they will be charged the public list price — their prices will change.`
                    : `${fallbackToListPrice.length} 个客户只挂了这一张价格表，移除后将按牌价计价，价格会变。`}
                </div>
              )}

              <div className="border border-gray-200 rounded max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr className="text-gray-500">
                      {mode === 'replace' && (
                        <th className="px-2 py-1.5 w-8">
                          <input
                            type="checkbox"
                            checked={selected.size === customers.length}
                            onChange={e => setSelected(e.target.checked ? new Set(customers.map(c => c.customerId)) : new Set())}
                            style={{ accentColor: PURPLE }}
                          />
                        </th>
                      )}
                      <th className="text-right px-2 py-1.5 w-16">{isEn ? 'No' : '编号'}</th>
                      <th className="text-left px-2 py-1.5">{isEn ? 'Customer' : '客户'}</th>
                      <th className="text-left px-2 py-1.5">{isEn ? 'Priority' : '优先级'}</th>
                      <th className="text-left px-2 py-1.5">{isEn ? 'Other pricelists' : '其他价格表'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {customers.map(c => (
                      <tr key={c.customerId} className="border-t border-gray-100">
                        {mode === 'replace' && (
                          <td className="px-2 py-1 text-center">
                            <input
                              type="checkbox"
                              checked={selected.has(c.customerId)}
                              onChange={e => setSelected(prev => {
                                const next = new Set(prev)
                                if (e.target.checked) next.add(c.customerId)
                                else next.delete(c.customerId)
                                return next
                              })}
                              style={{ accentColor: PURPLE }}
                            />
                          </td>
                        )}
                        <td className="px-2 py-1 text-right text-gray-500 tabular-nums">{c.customerNo}</td>
                        <td className="px-2 py-1 text-gray-800">
                          {c.name}
                          {!c.isActive && <span className="ml-1 text-gray-400">({isEn ? 'archived' : '已归档'})</span>}
                        </td>
                        <td className="px-2 py-1 text-gray-600">{c.sequence}</td>
                        <td className="px-2 py-1">
                          {c.otherPricelistCount > 0
                            ? <span className="text-gray-600">{c.otherPricelistCount}</span>
                            : <span className="text-amber-700">{isEn ? 'none — list price after removal' : '无（移除后按牌价）'}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-3" style={{ borderTop: '1px solid #e5e5e5' }}>
          <button onClick={onClose} className="h-8 px-4 text-sm rounded border border-gray-300 text-gray-600 hover:bg-gray-50">
            {isEn ? 'Cancel' : '取消'}
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="h-8 px-4 text-sm font-medium text-white rounded disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: PURPLE }}
          >
            {submitting
              ? (isEn ? 'Working…' : '处理中…')
              : mode === 'archive'
                ? (isEn ? 'Archive' : '确认归档')
                : (isEn ? `Apply to ${targetCustomers.length} customer(s)` : `处理 ${targetCustomers.length} 个客户`)}
          </button>
        </div>
      </div>
    </div>
  )
}
