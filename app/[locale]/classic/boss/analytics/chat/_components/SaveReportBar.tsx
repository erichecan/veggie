'use client'
import { useState } from 'react'

export function SaveReportBar({
  isEn, onSave, onCancel,
}: {
  isEn: boolean
  onSave: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  return (
    <div className="mt-2 flex gap-2 items-center border border-gray-200 rounded px-2 py-1">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSave(name.trim())}
        placeholder={isEn ? 'Report name…' : '报表名称…'}
        className="flex-1 text-sm outline-none"
        autoFocus
      />
      <button
        onClick={() => name.trim() && onSave(name.trim())}
        className="h-6 px-2 text-xs rounded text-white"
        style={{ background: '#875A7B' }}
      >
        {isEn ? 'Save' : '保存'}
      </button>
      <button onClick={onCancel} className="h-6 px-2 text-xs text-gray-400">✕</button>
    </div>
  )
}
