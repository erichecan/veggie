'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { getSession } from '@/lib/session'

const PURPLE = '#875A7B'

type Category = { id: string; name: string; nameZh: string | null; count: number }
type Product = { id: string; name: string; spec: string | null; saleDescription: string | null; images: string[]; categoryId: string | null }

export default function ShopPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const PAGE_SIZE = 60

  const [categoryId, setCategoryId] = useState('all')
  const [checkedLogin, setCheckedLogin] = useState(false)
  const [categories, setCategories] = useState<Category[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)

  // 已登录的餐厅账号直接进真正的下单门户，不需要再看匿名浏览版
  useEffect(() => {
    const user = getSession()
    if (user && user.role === 'RESTAURANT') {
      router.replace(`${prefix}/customer-portal`)
      return
    }
    setCheckedLogin(true)
  }, [router, prefix])

  useEffect(() => {
    if (!checkedLogin) return
    fetch('/api/public/categories').then(r => r.json()).then(setCategories).catch(() => setCategories([]))
  }, [checkedLogin])

  // 切分类时重新从第 1 页拉；不能把"切分类"和"翻页"揉进一个 effect，
  // 否则切分类那一下会先用旧 page 打一次接口
  useEffect(() => {
    if (!checkedLogin) return
    setPage(1)
    setLoading(true)
    const qs = new URLSearchParams({ page: '1', pageSize: String(PAGE_SIZE) })
    if (categoryId !== 'all') qs.set('categoryId', categoryId)
    fetch(`/api/public/products?${qs}`)
      .then(r => r.json())
      .then(data => {
        setProducts(data.products ?? [])
        setTotalPages(data.totalPages ?? 1)
      })
      .catch(() => { setProducts([]); setTotalPages(1) })
      .finally(() => setLoading(false))
  }, [checkedLogin, categoryId])

  function loadMore() {
    const nextPage = page + 1
    setLoadingMore(true)
    const qs = new URLSearchParams({ page: String(nextPage), pageSize: String(PAGE_SIZE) })
    if (categoryId !== 'all') qs.set('categoryId', categoryId)
    fetch(`/api/public/products?${qs}`)
      .then(r => r.json())
      .then(data => {
        setProducts(prev => [...prev, ...(data.products ?? [])])
        setTotalPages(data.totalPages ?? 1)
        setPage(nextPage)
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false))
  }

  function goLogin() {
    router.push(`${prefix}/enter?from=shop`)
  }

  if (!checkedLogin) return null

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-30 border-b bg-white shadow-sm">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <span className="text-lg font-bold" style={{ color: PURPLE }}>🥬 蔬菜批发商城</span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 hidden sm:inline">浏览商品无需登录，登录后可查看价格并下单</span>
            <button
              onClick={goLogin}
              className="px-4 py-1.5 rounded-md text-sm font-medium text-white transition-colors"
              style={{ background: PURPLE }}
            >
              登录 / 注册
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-4">
        <div className="flex gap-2 overflow-x-auto pb-1">
          <button
            onClick={() => setCategoryId('all')}
            className="px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors border"
            style={categoryId === 'all' ? { background: PURPLE, color: 'white', borderColor: PURPLE } : { borderColor: '#ddd', color: '#666' }}
          >
            全部
          </button>
          {categories.map(c => (
            <button
              key={c.id}
              onClick={() => setCategoryId(c.id)}
              className="px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors border"
              style={categoryId === c.id ? { background: PURPLE, color: 'white', borderColor: PURPLE } : { borderColor: '#ddd', color: '#666' }}
            >
              {c.nameZh || c.name}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="text-center py-20 text-gray-400 text-sm">加载中…</div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {products.map(p => (
                <div key={p.id} className="rounded-xl border bg-white p-3 flex flex-col gap-2" style={{ borderColor: '#eee' }}>
                  <div className="w-full aspect-square rounded-lg bg-gray-50 flex items-center justify-center overflow-hidden">
                    {p.images?.[0] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.images[0]} alt={p.name} className="w-full h-full object-cover" />
                    ) : (
                      <span className="text-4xl">🥬</span>
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{p.name}</p>
                    <p className="text-xs text-gray-400">{p.spec || p.saleDescription || ''}</p>
                  </div>
                  <button
                    onClick={goLogin}
                    className="w-full text-xs py-1.5 rounded-md border font-medium transition-colors"
                    style={{ borderColor: PURPLE, color: PURPLE }}
                  >
                    登录查看价格
                  </button>
                </div>
              ))}
            </div>

            {products.length === 0 && (
              <div className="text-center py-20 text-gray-400 text-sm">该分类暂无商品</div>
            )}

            {products.length > 0 && page < totalPages && (
              <div className="text-center pt-2">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="px-5 py-1.5 rounded-full text-xs font-medium border disabled:opacity-50"
                  style={{ borderColor: PURPLE, color: PURPLE }}
                >
                  {loadingMore ? '加载中…' : '加载更多'}
                </button>
              </div>
            )}
          </>
        )}

        <div className="text-center pt-4">
          <p className="text-xs text-gray-400">
            还没有账号？
            <Link href={`${prefix}/register`} className="ml-1 font-medium" style={{ color: PURPLE }}>
              去注册
            </Link>
          </p>
        </div>
      </main>
    </div>
  )
}
