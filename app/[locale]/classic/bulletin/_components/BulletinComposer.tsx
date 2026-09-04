'use client'
import { useRef, useState } from 'react'
import { apiPost, apiUpload } from '@/lib/api'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { BULLETIN_CATEGORIES, bulletinCategoryLabel, type BulletinCategoryValue } from '@/lib/bulletin-categories'
import type { BulletinPost } from './types'

export default function BulletinComposer({ isEn = false, onCreated }: { isEn?: boolean; onCreated: (post: BulletinPost) => void }) {
  const [category, setCategory] = useState<BulletinCategoryValue>('OTHER')
  const [content, setContent] = useState('')
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const { url } = await apiUpload<{ url: string }>('/api/bulletin-posts/upload-image', form)
      setImageUrl(url)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Image upload failed' : '图片上传失败'))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleSubmit() {
    const trimmed = content.trim()
    if (!trimmed) {
      toast.error(isEn ? 'Write something before posting' : '说点什么再发布吧')
      return
    }
    setSubmitting(true)
    try {
      const post = await apiPost<BulletinPost>('/api/bulletin-posts', {
        category,
        content: trimmed,
        imageUrl,
      })
      onCreated(post)
      setContent('')
      setImageUrl(null)
      setCategory('OTHER')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Failed to post' : '发布失败'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="border border-gray-200 rounded-lg p-4 space-y-3 bg-gray-50/50">
      <div className="flex items-center gap-2">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as BulletinCategoryValue)}
          className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-purple-400"
        >
          {BULLETIN_CATEGORIES.map((c) => (
            <option key={c} value={c}>{bulletinCategoryLabel(c, isEn)}</option>
          ))}
        </select>
        <span className="text-xs text-gray-400">
          {isEn ? "Reminder: don't post confidential numbers like quotes or costs here" : '提醒：报价、成本等保密数字不要发在这里'}
        </span>
      </div>

      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={isEn ? 'Out of stock? Just arrived? Supplier price change? Let everyone know…' : '缺货了？到货了？供应商调价了？发出来让大家都看到……'}
        rows={3}
        className="bg-white"
      />

      {imageUrl && (
        <div className="relative inline-block">
          <img src={imageUrl} alt="" className="h-20 rounded border border-gray-200 object-cover" />
          <button
            type="button"
            onClick={() => setImageUrl(null)}
            className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-gray-800 text-white text-xs flex items-center justify-center"
          >
            ×
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={handleFileChange}
            className="hidden"
            id="bulletin-image-input"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (isEn ? 'Uploading…' : '上传中…') : imageUrl ? (isEn ? 'Change Photo' : '换一张图') : (isEn ? '📷 Add Photo' : '📷 加图片')}
          </Button>
        </div>
        <Button type="button" size="sm" disabled={submitting} onClick={handleSubmit}>
          {submitting ? (isEn ? 'Posting…' : '发布中…') : (isEn ? 'Post' : '发布')}
        </Button>
      </div>
    </div>
  )
}
