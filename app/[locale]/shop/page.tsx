'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { getSession } from '@/lib/session'
import { LocaleSwitcher } from '@/components/shared/locale-switcher'
import { CategorySidebar } from '@/components/customer-portal/category-sidebar'

const PRIMARY = '#356b2f'
const PRIMARY_HOVER = '#285623'
const BORDER = '#dce7d9'

type Category = { id: string; parentId: string | null; name: string; nameZh: string | null; count: number }
type Product = { id: string; name: string; spec: string | null; saleDescription: string | null; images: string[]; categoryId: string | null }

export default function ShopPage() {
  const router = useRouter()
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
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
    // Session data lives in browser storage and must be checked after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    <div className="min-h-screen bg-[#f7faf6]">
      <header className="sticky top-0 z-30 border-b bg-white shadow-sm" style={{ borderColor: BORDER }}>
        <div className="mx-auto flex min-h-14 w-full max-w-screen-2xl items-center justify-between gap-3 px-4 py-2">
          <Link href={`${prefix}/shop`} aria-label={isEn ? 'JohnstoneBros home' : 'JohnstoneBros 首页'} className="inline-flex min-h-11 min-w-0 shrink items-center">
            <Image
              src="/johnstonebros-logo.png"
              alt="JohnstoneBros"
              width={258}
              height={38}
              priority
              className="h-auto w-[min(220px,48vw)] object-contain sm:w-[258px]"
            />
          </Link>
          <div className="flex items-center gap-2">
            <LocaleSwitcher colorScheme="green" />
            <button
              onClick={goLogin}
              className="min-h-11 rounded-lg px-3 py-2 text-sm font-semibold text-white transition-colors hover:brightness-95"
              style={{ background: PRIMARY }}
            >
              {isEn ? 'Sign In / Register' : '登录 / 注册'}
            </button>
          </div>
        </div>
      </header>

      <main className="w-full px-4 py-6 space-y-4">
        <div className="lg:flex lg:gap-4 lg:items-start">
          <CategorySidebar categories={categories} activeCategoryId={categoryId === 'all' ? null : categoryId} onSelect={id => { setPage(1); setLoading(true); setCategoryId(id ?? 'all') }} isEn={isEn} />
          <div className="min-w-0 flex-1">
            {loading ? (
              <div className="text-center py-20 text-gray-400 text-sm">{isEn ? 'Loading…' : '加载中…'}</div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-3">
                  {products.map(p => (
                    <div key={p.id} className="flex flex-col gap-2 rounded-xl border bg-white p-3" style={{ borderColor: BORDER }}>
                      <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg bg-[#f7faf6]">
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
                        style={{ borderColor: PRIMARY, color: PRIMARY }}
                      >
                        {isEn ? 'Sign in for prices' : '登录查看价格'}
                      </button>
                    </div>
                  ))}
                </div>

                {products.length === 0 && (
                  <div className="text-center py-20 text-gray-400 text-sm">{isEn ? 'No products in this category' : '该分类暂无商品'}</div>
                )}

                {products.length > 0 && page < totalPages && (
                  <div className="text-center pt-2">
                    <button
                      onClick={loadMore}
                      disabled={loadingMore}
                      className="px-5 py-1.5 rounded-full text-xs font-medium border disabled:opacity-50"
                      style={{ borderColor: PRIMARY, color: PRIMARY }}
                    >
                      {loadingMore ? (isEn ? 'Loading…' : '加载中…') : (isEn ? 'Load more' : '加载更多')}
                    </button>
                  </div>
                )}
              </>
            )}

          </div>
        </div>
        <div className="text-center pt-4">
          <p className="text-xs text-gray-400">
            {isEn ? 'Don’t have an account?' : '还没有账号？'}
            <Link href={`${prefix}/register`} className="ml-1 font-medium" style={{ color: PRIMARY_HOVER }}>
              {isEn ? 'Register' : '去注册'}
            </Link>
          </p>
        </div>
      </main>
    </div>
  )
}
