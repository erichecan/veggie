'use client'
import { useEffect, useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet } from '@/lib/api'

interface SimilarProductCandidate {
  id: string
  name: string
  internalRef: string | null
  score: number
}

/**
 * 软提醒：不阻断表单提交，仅在输入名称时列出可能重复的已有商品供人工核对。
 * onPick 可选：传入后每条候选旁多一个「使用此商品」按钮，点击即回调选中的商品
 * （供调用方直接绑定到已有商品，跳过新建）。
 */
export default function SimilarProductAlert({
  name,
  excludeId,
  onPick,
}: {
  name: string
  excludeId?: string
  onPick?: (candidate: SimilarProductCandidate) => void
}) {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const [candidates, setCandidates] = useState<SimilarProductCandidate[]>([])

  useEffect(() => {
    const query = name.trim()
    const timer = setTimeout(async () => {
      if (query.length < 2) { setCandidates([]); return }
      try {
        const params = new URLSearchParams({ name: query })
        if (excludeId) params.set('excludeId', excludeId)
        const res = await apiGet<{ candidates: SimilarProductCandidate[] }>(`/api/products/similar?${params}`)
        setCandidates(res.candidates ?? [])
      } catch {
        setCandidates([])
      }
    }, 400)
    return () => clearTimeout(timer)
  }, [name, excludeId])

  if (candidates.length === 0) return null

  return (
    <div className="mb-2 px-3 py-2 rounded border text-sm" style={{ background: '#fefce8', borderColor: '#fde047' }}>
      <div className="flex items-center gap-1.5 font-medium text-yellow-800 mb-1">
        <span>✳️</span> {isEn
          ? `Found ${candidates.length} similar product(s) — please confirm this isn't a duplicate`
          : `发现 ${candidates.length} 个相似商品，确认这不是重复商品`}
      </div>
      <ul className="space-y-0.5">
        {candidates.map(c => (
          <li key={c.id} className="flex items-center gap-2">
            <a
              href={`${prefix}/classic/operator/products/${c.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-yellow-900 underline hover:text-yellow-700"
            >
              {c.name}
            </a>
            {c.internalRef && (
              <span className="text-yellow-700">
                {isEn ? ` (Internal ref ${c.internalRef})` : ` （内部编号 ${c.internalRef}）`}
              </span>
            )}
            {onPick && (
              <button
                type="button"
                onClick={() => onPick(c)}
                className="px-1.5 py-0.5 rounded border border-yellow-400 text-yellow-800 hover:bg-yellow-100 text-xs"
              >
                {isEn ? 'Use this product' : '使用此商品'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
