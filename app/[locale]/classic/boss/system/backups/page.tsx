'use client'
import { useEffect, useState, useCallback } from 'react'
import { apiGet, apiPost, ApiError } from '@/lib/api'
import type { BackupJob } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { formatDateTime } from '@/lib/format-date'

function formatSize(bytes: number | null): string {
  if (!bytes) return '-'
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(1)} MB`
}

const STATUS_LABEL: Record<string, string> = {
  running: '进行中',
  success: '成功',
  failed: '失败',
}

export default function BackupsPage() {
  const [backups, setBackups] = useState<BackupJob[]>([])
  const [loading, setLoading] = useState(true)
  const [triggering, setTriggering] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiGet<{ backups: BackupJob[] }>('/api/backups')
      setBackups(res.backups)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '加载备份列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleTrigger() {
    setTriggering(true)
    try {
      await apiPost('/api/backups', {})
      toast.success('备份完成')
      await load()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '备份失败')
    } finally {
      setTriggering(false)
    }
  }

  async function handleDownload(id: string) {
    try {
      const res = await apiGet<{ url: string }>(`/api/backups/${id}/download`)
      window.open(res.url, '_blank')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '获取下载链接失败')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">数据库备份</h1>
        <Button onClick={handleTrigger} disabled={triggering}>
          {triggering ? '备份中…' : '立即备份'}
        </Button>
      </div>

      {loading ? (
        <p className="text-gray-500">加载中…</p>
      ) : backups.length === 0 ? (
        <p className="text-gray-500">还没有任何备份记录</p>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left border-b">
              <th className="py-2">时间</th>
              <th className="py-2">触发方式</th>
              <th className="py-2">状态</th>
              <th className="py-2">大小</th>
              <th className="py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.id} className="border-b">
                <td className="py-2">{formatDateTime(b.startedAt)}</td>
                <td className="py-2">{b.triggerType === 'MANUAL' ? '手动' : '自动'}</td>
                <td className="py-2">{STATUS_LABEL[b.status] ?? b.status}</td>
                <td className="py-2">{formatSize(b.sizeBytes)}</td>
                <td className="py-2">
                  {b.status === 'success' ? (
                    <Button variant="outline" size="sm" onClick={() => handleDownload(b.id)}>
                      下载
                    </Button>
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
