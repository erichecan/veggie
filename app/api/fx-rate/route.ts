import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'

/**
 * GET /api/fx-rate?currency=USD&date=YYYY-MM-DD
 * ============================================================================
 * 采购单新建页汇率自动回填：currency → EUR（公司记账本位币）的当日汇率。
 * 代理 Frankfurter（ECB 官方汇率，免费无需 Key），按天做进程内缓存，
 * 接口不可用时返回 rate:null，前端允许手动填汇率，不阻塞下单。
 */

const cache = new Map<string, { rate: number; fetchedAt: number }>()
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const { searchParams } = new URL(req.url)
    const currency = (searchParams.get('currency') || 'EUR').toUpperCase().trim()
    const date = searchParams.get('date')?.trim() || new Date().toISOString().slice(0, 10)

    if (currency === 'EUR') {
      return NextResponse.json({ currency, date, rate: 1, source: 'identity' })
    }

    const cacheKey = `${date}:${currency}`
    const cached = cache.get(cacheKey)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return NextResponse.json({ currency, date, rate: cached.rate, source: 'cache' })
    }

    async function fetchRate(url: string): Promise<number> {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      try {
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok) throw new Error(`frankfurter ${res.status}`)
        const json = await res.json()
        const rate = Number(json?.rates?.EUR)
        if (!Number.isFinite(rate) || rate <= 0) throw new Error('无效汇率数据')
        return rate
      } finally {
        clearTimeout(timeout)
      }
    }

    try {
      const rate = await fetchRate(`https://api.frankfurter.app/${date}?base=${encodeURIComponent(currency)}&symbols=EUR`)
      cache.set(cacheKey, { rate, fetchedAt: Date.now() })
      return NextResponse.json({ currency, date, rate, source: 'frankfurter' })
    } catch (error) {
      console.error('[GET /api/fx-rate] exact date failed, trying latest', error)
      // 当日汇率取不到(节假日/接口抖动)时退一步拿"最近一次可用汇率"兜底，不阻塞下单；
      // source 标为 fallback-latest，前端据此提示"汇率待确认"，别当成当日实时汇率用(20260713)。
      try {
        const rate = await fetchRate(`https://api.frankfurter.app/latest?base=${encodeURIComponent(currency)}&symbols=EUR`)
        return NextResponse.json({ currency, date, rate, source: 'fallback-latest' })
      } catch (fallbackError) {
        console.error('[GET /api/fx-rate] fallback latest also failed', fallbackError)
        return NextResponse.json({ currency, date, rate: null, source: 'unavailable' })
      }
    }
  })
}
