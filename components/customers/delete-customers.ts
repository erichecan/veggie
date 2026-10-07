'use client'
import { toast } from 'sonner'
import { apiPost, apiPut } from '@/lib/api'

/**
 * 客户 / 供应商列表共用的「删除」流程(20261007)：
 * 1. 确认 → POST /api/customers/bulk-delete
 * 2. 没有业务单据的直接删掉；有单据的服务端拒删并给原因
 * 3. 被拒的那些，问一句要不要改成归档(isActive=false，历史保留、可恢复)
 *
 * 返回是否有任何数据变化，调用方据此刷新列表。
 */

interface DeleteResult {
  deleted: Array<{ id: string; name: string }>
  blocked: Array<{ id: string; name: string; reasons: Array<{ zh: string; en: string }> }>
  notFound: number
}

export async function deleteCustomersFlow(
  ids: string[],
  opts: { isEn: boolean; noun: { zh: string; en: string } },
): Promise<boolean> {
  const { isEn, noun } = opts
  if (ids.length === 0) return false
  const ok = confirm(isEn
    ? `Permanently delete ${ids.length} ${noun.en}(s)?\n\nOnly records without any business documents (orders, invoices, payments, purchase orders…) can be deleted. Records that have documents will be listed and you can archive them instead.\n\nThis cannot be undone.`
    : `确认永久删除 ${ids.length} 个${noun.zh}？\n\n只能删除没有任何业务单据(订单、发票、收款、采购单等)的档案；有单据的会列出来，可以改为归档。\n\n删除后无法恢复。`)
  if (!ok) return false

  let res: DeleteResult
  try {
    res = await apiPost<DeleteResult>('/api/customers/bulk-delete', { ids })
  } catch (e) {
    toast.error(e instanceof Error ? e.message : (isEn ? 'Delete failed' : '删除失败'))
    return false
  }

  let changed = res.deleted.length > 0
  if (res.deleted.length > 0) {
    toast.success(isEn ? `Deleted ${res.deleted.length} ${noun.en}(s)` : `已删除 ${res.deleted.length} 个${noun.zh}`)
  }

  if (res.blocked.length > 0) {
    const lines = res.blocked.slice(0, 10).map(b =>
      `• ${b.name}: ${b.reasons.map(r => (isEn ? r.en : r.zh)).join(isEn ? ', ' : '、')}`)
    const more = res.blocked.length > 10 ? (isEn ? `\n… and ${res.blocked.length - 10} more` : `\n… 另有 ${res.blocked.length - 10} 个`) : ''
    const archive = confirm(isEn
      ? `${res.blocked.length} ${noun.en}(s) could not be deleted because they have business documents:\n\n${lines.join('\n')}${more}\n\nArchive them instead? (They disappear from lists and pickers; all history is kept and can be restored.)`
      : `${res.blocked.length} 个${noun.zh}有业务单据，不能删除：\n\n${lines.join('\n')}${more}\n\n改为归档？(从列表和下单选择中消失，历史完整保留，可恢复)`)
    if (archive) {
      const results = await Promise.allSettled(res.blocked.map(b => apiPut(`/api/customers/${b.id}`, { isActive: false })))
      const okCount = results.filter(r => r.status === 'fulfilled').length
      const failCount = results.length - okCount
      if (okCount > 0) changed = true
      if (failCount === 0) toast.success(isEn ? `Archived ${okCount} ${noun.en}(s)` : `已归档 ${okCount} 个${noun.zh}`)
      else toast.warning(isEn ? `Archived ${okCount}, ${failCount} failed` : `归档成功 ${okCount} 个，失败 ${failCount} 个`)
    }
  }

  if (res.notFound > 0) {
    toast.warning(isEn ? `${res.notFound} record(s) no longer exist or are not visible to you` : `${res.notFound} 条记录已不存在或你无权操作`)
  }
  return changed
}

export const DELETE_PERMISSION_HINT = {
  zh: '没有删除权限：需要在「用户管理 → 角色权限」里给你的角色勾选「客户 — 删除」',
  en: 'No delete permission: ask an admin to enable “Customer — Delete” for your role (Users → Roles)',
}
