'use client'
import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut } from '@/lib/api'
import type { PickingWave, Order } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { WaveStatusBadge } from '@/components/shared/status-badge'

const PURPLE = '#875A7B'

interface RestaurantSort {
  restaurantId: string
  restaurantName: string
  orders: Order[]
  done: boolean
}

export default function ClassicSortingExecutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const [wave, setWave] = useState<PickingWave | null>(null)
  const [restaurants, setRestaurants] = useState<RestaurantSort[]>([])

  function load() {
    Promise.all([
      apiGet<PickingWave>(`/api/waves/${id}`),
      apiGet<Order[]>('/api/orders?include_lines=false'),
    ]).then(([w, allOrders]) => {
      setWave(w)
      const orders = allOrders.filter(o => w.orderIds.includes(o.id))
      const restMap = new Map<string, RestaurantSort>()
      orders.forEach(o => {
        if (!restMap.has(o.restaurantId)) {
          restMap.set(o.restaurantId, {
            restaurantId: o.restaurantId,
            restaurantName: o.restaurantName,
            orders: [],
            done: false,
          })
        }
        restMap.get(o.restaurantId)!.orders.push(o)
      })
      setRestaurants(Array.from(restMap.values()))
    }).catch(() => {})
  }

  useEffect(() => { load() }, [id])

  async function markRestDone(rId: string) {
    setRestaurants(prev => prev.map(r => r.restaurantId === rId ? { ...r, done: !r.done } : r))
    if (!wave) return
    const updated: PickingWave = {
      ...wave,
      status: wave.status.toLowerCase() === 'picked' ? 'sorting' : wave.status,
    }
    await apiPut(`/api/waves/${updated.id}`, updated)
    setWave(updated)
  }

  async function submitSorting() {
    if (!wave) return
    const incomplete = restaurants.filter(r => !r.done)
    if (incomplete.length > 0) {
      if (!confirm(`还有 ${incomplete.length} 家餐馆未完成分货，确认提交？`)) return
    }
    const updated: PickingWave = { ...wave, status: 'sorted' }
    await apiPut(`/api/waves/${updated.id}`, updated)
    toast.success('分货完成！已通知司机')
    router.push(`${prefix}/classic/sorter`)
  }

  if (!wave) return <div className="text-center py-16 text-gray-400">波次不存在</div>

  const doneCount = restaurants.filter(r => r.done).length

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <button
              onClick={() => router.push(`${prefix}/classic/sorter`)}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              ← 返回分货任务
            </button>
          </div>
          <h1 className="text-xl font-bold text-gray-900">分货执行</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className="font-mono text-xs text-gray-400">{wave.id}</span>
            <WaveStatusBadge status={wave.status} />
          </div>
        </div>
        <Button
          onClick={submitSorting}
          style={{ background: PURPLE, borderColor: PURPLE }}
          className="text-white hover:opacity-90"
          disabled={wave.status.toLowerCase() === 'sorted'}
        >
          完成分货 ({doneCount}/{restaurants.length})
        </Button>
      </div>

      <div className="space-y-4">
        {restaurants.map(r => (
          <div key={r.restaurantId} className={`bg-white rounded-xl border border-gray-200 overflow-hidden ${r.done ? 'border-green-300' : ''}`}>
            <div className={`px-4 py-3 flex items-center justify-between ${r.done ? 'bg-green-50' : 'bg-gray-50'}`}>
              <h3 className="font-medium text-gray-900">🏪 {r.restaurantName}</h3>
              <button
                onClick={() => markRestDone(r.restaurantId)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  r.done
                    ? 'bg-green-100 text-green-700 hover:bg-green-200'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {r.done ? '✓ 已完成装箱' : '标记完成'}
              </button>
            </div>
            <div className="p-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="pb-2 font-medium">商品</th>
                    <th className="pb-2 font-medium">规格</th>
                    <th className="pb-2 text-right font-medium">数量</th>
                    <th className="pb-2 text-right font-medium">小计</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {r.orders.flatMap(o => o.items).map((item, i) => (
                    <tr key={i}>
                      <td className="py-1.5 font-medium">{item.productName}</td>
                      <td className="py-1.5 text-gray-500">{item.spec}</td>
                      <td className="py-1.5 text-right">{item.quantity}</td>
                      <td className="py-1.5 text-right" style={{ color: PURPLE }}>€{item.subtotal.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-gray-200">
                    <td colSpan={3} className="pt-2 text-right font-medium text-gray-700">合计</td>
                    <td className="pt-2 text-right font-bold" style={{ color: PURPLE }}>
                      €{r.orders.reduce((s, o) => s + o.totalAmount, 0).toFixed(2)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
