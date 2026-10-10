'use client'
/**
 * 配合 lib/hooks/use-draft-autosave.ts：页面发现本地有未保存的旧草稿时，
 * 在表单顶部渲染这一条，不用阻断式弹窗（避免盖住下面的提交按钮，
 * cookie-banner.tsx 踩过这个坑）。
 */
import { Button } from '@/components/ui/button'

interface DraftRestoreBannerProps {
  onRestore: () => void
  onDiscard: () => void
}

export default function DraftRestoreBanner({ onRestore, onDiscard }: DraftRestoreBannerProps) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <span>检测到上次未保存的内容，是否恢复？</span>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="outline" onClick={onDiscard}>丢弃</Button>
        <Button size="sm" onClick={onRestore}>恢复</Button>
      </div>
    </div>
  )
}
