'use client'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPatch } from '@/lib/api'

const PURPLE = '#875A7B'
const BORDER = '#d4b8d0'

interface ZoneSummary {
  zoneId: string
  key: string
  nameZh: string
  tempRangeLabel: string | null
  skuCount: number
  totalValue: number
  warningCount: number
}

interface ZoneMismatch {
  productId: string
  productName: string
  qtyOnHand: number
  currentZoneId: string
  currentZoneNameZh: string
  requiredZoneId: string
  requiredZoneNameZh: string
}

interface ZoneInventoryData {
  zones: ZoneSummary[]
  mismatches: ZoneMismatch[]
  unplacedCount: number
}

const ZONE_ICON: Record<string, string> = {
  FROZEN: '🧊',
  CHILLED: '❄️',
  DRY: '🌾',
  AMBIENT: '🛒',
}

function formatMoney(v: number) {
  return v.toLocaleString('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
}

export default function ZoneInventoryPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`

  const [data, setData] = useState<ZoneInventoryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiGet<ZoneInventoryData>('/api/analytics/zone-inventory?limit=200')
      setData(res)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function confirmMove(m: ZoneMismatch) {
    setConfirmingId(m.productId)
    try {
      await apiPatch(`/api/products/${m.productId}/zone`, { zoneId: m.requiredZoneId })
      toast.success(`「${m.productName}」已确认移至 ${m.requiredZoneNameZh}`)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    } finally {
      setConfirmingId(null)
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <button onClick={() => router.push(`${prefix}/classic/operator/inventory`)} className="hover:underline">
          库存管理
        </button>
        <span>/</span>
        <span style={{ color: PURPLE }}>仓库地图·温区库存</span>
      </div>

      <h1 className="text-lg font-semibold" style={{ color: PURPLE }}>仓库地图·温区库存</h1>

      {loading && <div className="py-12 text-center text-sm text-gray-400">加载中...</div>}

      {!loading && data && (
        <>
          {/* Zone cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {data.zones.map(z => (
              <div
                key={z.zoneId}
                className="bg-white rounded-lg border p-4 space-y-2"
                style={{ borderColor: BORDER }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-2xl">{ZONE_ICON[z.key] ?? '📦'}</span>
                  {z.warningCount > 0 && (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-500">
                      {z.warningCount} 项预警
                    </span>
                  )}
                </div>
                <div className="text-sm font-semibold text-gray-800">{z.nameZh}</div>
                {z.tempRangeLabel && (
                  <div className="text-xs text-gray-400">{z.tempRangeLabel}</div>
                )}
                <div className="flex items-end justify-between pt-1">
                  <div>
                    <div className="text-xs text-gray-400">SKU 数</div>
                    <div className="text-base font-mono font-semibold" style={{ color: PURPLE }}>{z.skuCount}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-gray-400">库存总值</div>
                    <div className="text-base font-mono font-semibold text-gray-700">{formatMoney(z.totalValue)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Mismatch table */}
          <div className="pt-2">
            <h2 className="text-sm font-semibold mb-2" style={{ color: PURPLE }}>
              温区不符 {data.mismatches.length > 0 && (
                <span className="text-xs font-normal text-gray-400 ml-1">（共 {data.mismatches.length} 项，按库存价值降序）</span>
              )}
            </h2>
            <div className="bg-white rounded-lg border overflow-hidden" style={{ borderColor: BORDER }}>
              <div
                className="grid gap-3 px-4 py-2.5 text-xs font-semibold border-b"
                style={{ borderColor: BORDER, color: PURPLE, background: '#faf5fb', gridTemplateColumns: '1fr 120px 120px 100px 140px' }}
              >
                <span>商品名称</span>
                <span>当前温区</span>
                <span>应放温区</span>
                <span className="text-right">在手库存</span>
                <span className="text-right">操作</span>
              </div>

              {data.mismatches.length === 0 && (
                <div className="py-12 text-center text-sm text-gray-400">暂无温区不符商品</div>
              )}

              {data.mismatches.map(m => (
                <div
                  key={m.productId}
                  className="grid gap-3 px-4 py-3 border-b last:border-b-0 items-center"
                  style={{ borderColor: '#f0e4ee', gridTemplateColumns: '1fr 120px 120px 100px 140px' }}
                >
                  <span className="text-sm font-medium text-gray-800">{m.productName}</span>
                  <span className="text-xs text-red-500">{m.currentZoneNameZh}</span>
                  <span className="text-xs text-green-600">{m.requiredZoneNameZh}</span>
                  <span className="text-sm font-mono text-right text-gray-700">{m.qtyOnHand.toFixed(2)}</span>
                  <div className="text-right">
                    <button
                      onClick={() => confirmMove(m)}
                      disabled={confirmingId === m.productId}
                      className="px-3 py-1.5 rounded text-xs font-medium text-white disabled:opacity-50"
                      style={{ background: PURPLE }}
                    >
                      {confirmingId === m.productId ? '处理中...' : '确认已移至正确温区'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Unplaced info line */}
          <div className="text-xs text-gray-400 pt-1">
            未定位商品：{data.unplacedCount} 个（该商品所属类目暂未映射业务温区，属预期情况）
          </div>
        </>
      )}
    </div>
  )
}
