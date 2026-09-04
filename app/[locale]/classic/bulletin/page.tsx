'use client'
import { useEffect, useMemo, useState } from 'react'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet } from '@/lib/api'
import { getSession } from '@/lib/session'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { BULLETIN_CATEGORIES, bulletinCategoryLabel, type BulletinCategoryValue } from '@/lib/bulletin-categories'
import BulletinComposer from './_components/BulletinComposer'
import BulletinPostCard from './_components/BulletinPostCard'
import type { BulletinPost } from './_components/types'

const MANAGE_ROLES = ['BOSS', 'OPERATOR']

export default function BulletinPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const [posts, setPosts] = useState<BulletinPost[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState<BulletinCategoryValue | 'ALL'>('ALL')
  const [q, setQ] = useState('')

  const session = useMemo(() => getSession(), [])
  const roles = session?.roles && session.roles.length > 0 ? session.roles : (session?.role ? [session.role] : [])
  const canManage = roles.some((r) => MANAGE_ROLES.includes(r))

  async function load() {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (category !== 'ALL') params.set('category', category)
      if (q.trim()) params.set('q', q.trim())
      params.set('pageSize', '50')
      const data = await apiGet<{ items: BulletinPost[] }>(`/api/bulletin-posts?${params.toString()}`)
      setPosts(data.items)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Failed to load' : '加载失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category])

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault()
    load()
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-gray-800">{isEn ? 'Bulletin Board' : '信息广场'}</h1>
        <p className="text-sm text-gray-400">
          {isEn
            ? 'Shortages, arrivals, price changes… post it here instead of digging through chat history.'
            : '缺货、到货、调价……大家的消息都发在这，别再刷微信群翻记录了'}
        </p>
      </div>

      <BulletinComposer isEn={isEn} onCreated={(post) => setPosts((prev) => [post, ...prev])} />

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setCategory('ALL')}
          className={`px-3 py-1 rounded-full text-sm border ${category === 'ALL' ? 'bg-purple-600 text-white border-purple-600' : 'border-gray-300 text-gray-600'}`}
        >
          {isEn ? 'All' : '全部'}
        </button>
        {BULLETIN_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCategory(c)}
            className={`px-3 py-1 rounded-full text-sm border ${category === c ? 'bg-purple-600 text-white border-purple-600' : 'border-gray-300 text-gray-600'}`}
          >
            {bulletinCategoryLabel(c, isEn)}
          </button>
        ))}

        <form onSubmit={handleSearchSubmit} className="ml-auto flex items-center gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={isEn ? 'Search…' : '搜索关键词…'}
            className="h-8 w-48 text-sm"
          />
        </form>
      </div>

      {loading ? (
        <p className="text-center text-gray-400 text-sm py-12">{isEn ? 'Loading…' : '加载中…'}</p>
      ) : posts.length === 0 ? (
        <p className="text-center text-gray-400 text-sm py-12">
          {isEn ? 'No posts yet — be the first to post.' : '还没有人发布信息，来发第一条吧'}
        </p>
      ) : (
        <div className="space-y-3">
          {posts.map((post) => (
            <BulletinPostCard
              key={post.id}
              post={post}
              isEn={isEn}
              currentUserId={session?.userId}
              canManage={canManage}
              onDeleted={(id) => setPosts((prev) => prev.filter((p) => p.id !== id))}
              onPinToggled={(updated) =>
                setPosts((prev) =>
                  [...prev.filter((p) => p.id !== updated.id), updated].sort((a, b) => {
                    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
                    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
                  }),
                )
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}
