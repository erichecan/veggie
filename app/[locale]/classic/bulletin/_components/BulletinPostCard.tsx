'use client'
import { useState } from 'react'
import { apiDelete, apiPatch } from '@/lib/api'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { formatDateTime } from '@/lib/format-date'
import { bulletinCategoryLabel } from '@/lib/bulletin-categories'
import type { BulletinPost } from './types'

const CATEGORY_BADGE_VARIANT: Record<BulletinPost['category'], string> = {
  SHORTAGE: 'bg-red-100 text-red-700 border-red-200',
  ARRIVAL: 'bg-green-100 text-green-700 border-green-200',
  PRICE_CHANGE: 'bg-amber-100 text-amber-700 border-amber-200',
  OTHER: 'bg-gray-100 text-gray-600 border-gray-200',
}

export default function BulletinPostCard({
  post,
  isEn = false,
  currentUserId,
  canManage,
  onDeleted,
  onPinToggled,
}: {
  post: BulletinPost
  isEn?: boolean
  currentUserId: string | undefined
  canManage: boolean
  onDeleted: (id: string) => void
  onPinToggled: (post: BulletinPost) => void
}) {
  const [busy, setBusy] = useState(false)
  const isOwner = post.author?.id === currentUserId
  const canDelete = isOwner || canManage

  async function handleDelete() {
    if (!window.confirm(isEn ? 'Delete this post?' : '确定删除这条信息吗？')) return
    setBusy(true)
    try {
      await apiDelete(`/api/bulletin-posts/${post.id}`)
      onDeleted(post.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Failed to delete' : '删除失败'))
    } finally {
      setBusy(false)
    }
  }

  async function handleTogglePin() {
    setBusy(true)
    try {
      const updated = await apiPatch<BulletinPost>(`/api/bulletin-posts/${post.id}/pin`, {
        pinned: !post.pinned,
      })
      onPinToggled(updated)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Action failed' : '操作失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`border rounded-lg p-4 ${post.pinned ? 'border-purple-300 bg-purple-50/40' : 'border-gray-200'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          {post.pinned && <span className="text-xs text-purple-600 font-medium">📌 {isEn ? 'Pinned' : '置顶'}</span>}
          <Badge variant="outline" className={CATEGORY_BADGE_VARIANT[post.category]}>
            {bulletinCategoryLabel(post.category, isEn)}
          </Badge>
          <span className="text-sm font-medium text-gray-800">
            {post.author?.name ?? (isEn ? 'System' : '系统')}
          </span>
          <span className="text-xs text-gray-400">{formatDateTime(post.createdAt)}</span>
        </div>

        {(canDelete || canManage) && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {canManage && (
              <button
                type="button"
                disabled={busy}
                onClick={handleTogglePin}
                className="text-xs text-gray-400 hover:text-purple-600"
              >
                {post.pinned ? (isEn ? 'Unpin' : '取消置顶') : (isEn ? 'Pin' : '置顶')}
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                disabled={busy}
                onClick={handleDelete}
                className="text-xs text-gray-400 hover:text-red-600"
              >
                {isEn ? 'Delete' : '删除'}
              </button>
            )}
          </div>
        )}
      </div>

      <p className="mt-2 text-sm text-gray-700 whitespace-pre-wrap break-words">{post.content}</p>

      {post.imageUrl && (
        <img src={post.imageUrl} alt="" className="mt-2 max-h-64 rounded border border-gray-200 object-cover" />
      )}
    </div>
  )
}
