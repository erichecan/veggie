'use client'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import type { ExportColumn } from '@/lib/export/types'

/**
 * 导出前的字段勾选弹窗 —— 复用同一份 ExportColumn 定义（header 随 locale 显示，
 * key 是勾选状态与 ?fields= 参数的稳定标识），由 hooks/use-csv-export.tsx 内部渲染。
 */
export default function ExportFieldPickerDialog<T>({
  open, onClose, columns, isEn, onConfirm,
}: {
  open: boolean
  onClose: () => void
  columns: readonly ExportColumn<T>[]
  isEn: boolean
  onConfirm: (selectedKeys: string[]) => void
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(columns.map(c => c.key)))

  // 每次打开都重置成"全选"——避免记着上一次可能是别的实体、字段完全不同的选择
  useEffect(() => {
    if (open) setSelected(new Set(columns.map(c => c.key)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function toggle(key: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const allChecked = selected.size === columns.length
  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(columns.map(c => c.key)))
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEn ? 'Choose fields to export' : '选择要导出的字段'}</DialogTitle>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto space-y-0.5 text-sm border border-gray-100 rounded-lg p-2">
          <label className="flex items-center gap-2 px-1 py-1.5 font-medium border-b border-gray-100 mb-1 cursor-pointer">
            <input type="checkbox" checked={allChecked} onChange={toggleAll} />
            {isEn ? 'Select all' : '全选'}
          </label>
          {columns.map(c => (
            <label key={c.key} className="flex items-center gap-2 px-1 py-1.5 cursor-pointer hover:bg-gray-50 rounded">
              <input type="checkbox" checked={selected.has(c.key)} onChange={() => toggle(c.key)} />
              <span className="truncate">{isEn ? (c.headerEn ?? c.header) : c.header}</span>
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{isEn ? 'Cancel' : '取消'}</Button>
          <Button disabled={selected.size === 0} onClick={() => onConfirm([...selected])}>
            {isEn ? 'Export' : '导出'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
