'use client'
import { useEffect, useState, use } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut } from '@/lib/api'
import type { PickingWave, Order, WaveStatus } from '@/lib/types'

const STATUS_LABEL: Record<WaveStatus, string> = {
  pending:  '待拣货',
  picking:  '拣货中',
  picked:   '拣货完成',
  sorting:  '分货中',
  sorted:   '已分货',
}
const STATUS_COLOR: Record<WaveStatus, string> = {
  pending:  'bg-gray-100 text-gray-600',
  picking:  'bg-blue-50 text-blue-700',
  picked:   'bg-cyan-50 text-cyan-700',
  sorting:  'bg-purple-50 text-purple-700',
  sorted:   'bg-green-50 text-green-700',
}

interface RestaurantGroup {
  restaurantId: string
  restaurantName: string
  orders: Order[]
}

export default function ClassicSortingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const [wave, setWave] = useState<PickingWave | null>(null)
  const [restaurants, setRestaurants] = useState<RestaurantGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  async function load() {
    try {
      const [w, allOrders] = await Promise.all([
        apiGet<PickingWave>(`/api/waves/${id}`),
        apiGet<Order[]>('/api/orders?include_lines=false'),
      ])
      const normalized: PickingWave = {
        ...w,
        status: (w.status as string).toLowerCase() as WaveStatus,
        zones: w.zones ?? [],
        orderIds: w.orderIds ?? [],
      }
      setWave(normalized)
      const waveOrders = allOrders.filter(o => normalized.orderIds.includes(o.id))
      const map = new Map<string, RestaurantGroup>()
      waveOrders.forEach(o => {
        if (!map.has(o.restaurantId)) {
          map.set(o.restaurantId, {
            restaurantId: o.restaurantId,
            restaurantName: o.restaurantName,
            orders: [],
          })
        }
        map.get(o.restaurantId)!.orders.push(o)
      })
      setRestaurants(Array.from(map.values()))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  async function advance(targetStatus: 'sorting' | 'sorted') {
    if (!wave || updating) return
    setUpdating(true)
    try {
      await apiPut(`/api/waves/${wave.id}`, { ...wave, status: targetStatus })
      toast.success(targetStatus === 'sorting' ? '已开始分货' : '分货完成')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '状态更新失败')
    } finally {
      setUpdating(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6 text-sm text-gray-400 text-center">加载中…</div>
    )
  }
  if (!wave) {
    return (
      <div className="p-6 text-sm text-red-500 text-center">波次不存在</div>
    )
  }

  const status = wave.status as WaveStatus
  const canStart = status === 'picked'
  const canFinish = status === 'sorting'
  const totalItems = wave.zones.reduce(
    (s, z) => s + z.items.reduce((ss, i) => ss + i.requiredQty, 0),
    0,
  )
  const totalOrders = restaurants.reduce((s, r) => s + r.orders.length, 0)

  return (
    <div>
      {/* ── Odoo 风格顶部面包屑 + 状态栏 ── */}
      <div
        className="flex items-center justify-between px-4 py-2 text-sm border-b"
        style={{ background: '#f5f5f5', borderColor: '#e0d6e8' }}
      >
        <div className="flex items-center gap-1 text-gray-500">
          <button
            onClick={() => router.push(`${prefix}/classic/operator/sorting`)}
            className="hover:underline"
            style={{ color: '#875A7B' }}
          >
            分货
          </button>
          <span>/</span>
          <span className="font-mono text-gray-700">{wave.id.slice(0, 12)}…</span>
          <span
            className={`ml-2 inline-block px-2 py-0.5 rounded text-xs ${
              STATUS_COLOR[status] ?? 'bg-gray-100 text-gray-600'
            }`}
          >
            {STATUS_LABEL[status] ?? status}
          </span>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-2">
          {canStart && (
            <button
              onClick={() => advance('sorting')}
              disabled={updating}
              className="px-3 py-1 rounded text-sm text-white disabled:opacity-50"
              style={{ background: '#875A7B' }}
            >
              {updating ? '处理中…' : '开始分货'}
            </button>
          )}
          {canFinish && (
            <button
              onClick={() => advance('sorted')}
              disabled={updating}
              className="px-3 py-1 rounded text-sm text-white disabled:opacity-50"
              style={{ background: '#059669' }}
            >
              {updating ? '处理中…' : '确认分货完成'}
            </button>
          )}
        </div>
      </div>

      {/* ── 概览统计 ── */}
      <div
        className="grid grid-cols-2 md:grid-cols-4 gap-0 border-b text-sm"
        style={{ borderColor: '#e0d6e8' }}
      >
        {[
          { label: '餐馆数',   value: restaurants.length },
          { label: '订单数',   value: totalOrders },
          { label: '总件数',   value: totalItems },
          {
            label: '创建时间',
            value: new Date(wave.createdAt).toLocaleString('en-GB', {
              dateStyle: 'short',
              timeStyle: 'short',
            }),
          },
        ].map(s => (
          <div key={s.label} className="px-4 py-3 border-r last:border-r-0" style={{ borderColor: '#e0d6e8' }}>
            <div className="text-xs text-gray-500">{s.label}</div>
            <div className="font-semibold text-gray-800 mt-0.5">{s.value}</div>
          </div>
        ))}
      </div>

      {/* ── 餐馆分组列表 ── */}
      <div className="p-4 space-y-2">
        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
          按餐馆拆分 · {restaurants.length} 家
        </div>

        {restaurants.length === 0 && (
          <div
            className="border rounded py-12 text-center text-gray-400 text-sm"
            style={{ borderColor: '#e0d6e8' }}
          >
            该波次下没有订单
          </div>
        )}

        {restaurants.map(r => {
          const totalLines = r.orders.reduce(
            (s, o) => s + (Array.isArray(o.items) ? o.items.length : 0),
            0,
          )
          const totalQty = r.orders.reduce(
            (s, o) =>
              s +
              (Array.isArray(o.items)
                ? o.items.reduce((ss, i) => ss + (i.quantity ?? 0), 0)
                : 0),
            0,
          )
          const totalAmount = r.orders.reduce(
            (s, o) => s + Number(o.totalAmount ?? 0),
            0,
          )
          const isOpen = expanded === r.restaurantId

          return (
            <div
              key={r.restaurantId}
              className="border rounded overflow-hidden"
              style={{ borderColor: '#e0d6e8' }}
            >
              {/* 折叠头 */}
              <button
                onClick={() => setExpanded(isOpen ? null : r.restaurantId)}
                className="w-full px-4 py-3 flex items-center justify-between text-sm text-left hover:bg-[#875A7B]/20 transition-colors"
                style={{ background: isOpen ? '#faf5fc' : '#fff' }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: '#875A7B' }}
                  />
                  <span className="font-medium text-gray-900 truncate">
                    {r.restaurantName || r.restaurantId}
                  </span>
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-500 flex-shrink-0">
                  <span>{r.orders.length} 订单</span>
                  <span>{totalLines} 行</span>
                  <span>{totalQty} 件</span>
                  <span className="font-medium" style={{ color: '#059669' }}>
                    €{totalAmount.toFixed(2)}
                  </span>
                  <span className="text-gray-400 ml-1">{isOpen ? '▲' : '▼'}</span>
                </div>
              </button>

              {/* 展开内容：订单明细表格 */}
              {isOpen && (
                <div className="border-t divide-y" style={{ borderColor: '#e0d6e8' }}>
                  {r.orders.map(o => (
                    <div key={o.id} className="px-4 py-3 bg-white">
                      <div className="flex items-center justify-between text-xs text-gray-400 mb-2">
                        <span className="font-mono">{o.id.slice(0, 16)}…</span>
                        <span className="font-medium text-gray-700">
                          €{Number(o.totalAmount ?? 0).toFixed(2)}
                        </span>
                      </div>
                      <table className="w-full text-xs border-collapse">
                        <thead>
                          <tr style={{ background: '#f3eff5' }}>
                            <th className="text-left px-2 py-1 text-gray-600 font-medium">商品</th>
                            <th className="text-left px-2 py-1 text-gray-600 font-medium">规格</th>
                            <th className="text-right px-2 py-1 text-gray-600 font-medium">数量</th>
                            <th className="text-right px-2 py-1 text-gray-600 font-medium">单价</th>
                            <th className="text-right px-2 py-1 text-gray-600 font-medium">小计</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Array.isArray(o.items) &&
                            o.items.map((it, i) => (
                              <tr
                                key={i}
                                className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}
                              >
                                <td className="px-2 py-1 text-gray-800">{it.productName}</td>
                                <td className="px-2 py-1 text-gray-500">{it.spec || '—'}</td>
                                <td className="px-2 py-1 text-right font-medium">{it.quantity}</td>
                                <td className="px-2 py-1 text-right text-gray-600">
                                  €{Number(it.price ?? 0).toFixed(2)}
                                </td>
                                <td className="px-2 py-1 text-right font-medium text-gray-800">
                                  €{Number(it.subtotal ?? 0).toFixed(2)}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
