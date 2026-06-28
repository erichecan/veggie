'use client'
import { useState, useEffect, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import type { PickingWave, WaveStatus } from '@/lib/types'
import OdooControlPanel from '@/components/classic/OdooControlPanel'

/* ─── Slot colour palette (matches list page) ──────────────────────────── */
const SLOT_COLORS: Record<number, { bg: string; text: string; border: string; badge: string }> = {
  1: { bg: '#ede9fe', text: '#6d28d9', border: '#875A7B', badge: 'linear-gradient(135deg,#7c3aed,#6d28d9)' },
  2: { bg: '#fef3c7', text: '#92400e', border: '#f59e0b', badge: 'linear-gradient(135deg,#f59e0b,#d97706)' },
  3: { bg: '#d1fae5', text: '#065f46', border: '#10b981', badge: 'linear-gradient(135deg,#10b981,#059669)' },
  4: { bg: '#dbeafe', text: '#1e40af', border: '#3b82f6', badge: 'linear-gradient(135deg,#3b82f6,#2563eb)' },
  5: { bg: '#fce7f3', text: '#9d174d', border: '#ec4899', badge: 'linear-gradient(135deg,#ec4899,#db2777)' },
}
function slotColor(n: number) {
  const key = ((n - 1) % 5) + 1
  return SLOT_COLORS[key]
}

/** 判断计量单位是否为千克类（kg / 千克 / KG） */
function isKgUom(uomName?: string): boolean {
  if (!uomName) return false
  const n = uomName.trim().toLowerCase()
  return n === 'kg' || n === '千克' || n === 'kilogram' || n === 'kilograms'
}

export default function ClassicWaveDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [wave, setWave] = useState<PickingWave | null>(null)
  const [loading, setLoading] = useState(true)
  const [shortages, setShortages] = useState<{ productId: string; productName: string; demandQty: number; stockQty: number; shortageQty: number; shortageRate: number }[]>([])
  const [shortageSummary, setShortageSummary] = useState<{ totalProducts: number; shortageProducts: number; shortageRate: number } | null>(null)
  const [showShortages, setShowShortages] = useState(false)
  const printRef = useRef<HTMLDivElement>(null)

  async function load() {
    setLoading(true)
    try {
      const [raw, shortageData] = await Promise.all([
        apiGet<Record<string, unknown>>(`/api/waves/${id}`),
        apiGet<{ shortages: typeof shortages; summary: typeof shortageSummary }>(`/api/waves/${id}/shortage`).catch(() => null),
      ])
      const w: PickingWave = {
        ...(raw as unknown as PickingWave),
        status: (raw.status as string).toLowerCase() as WaveStatus,
        zones: (raw.zones as PickingWave['zones']) ?? [],
        orderIds: (raw.orderIds as string[]) ?? [],
      }
      setWave(w)
      if (shortageData) {
        setShortages(shortageData.shortages ?? [])
        setShortageSummary(shortageData.summary ?? null)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载波次失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [id])

  function handlePrint() {
    if (!wave) return
    const w = window.open('', '_blank', 'noopener,width=900,height=720')
    if (!w) { toast.error('请允许弹出窗口以打印'); return }
    const wLabel = wave.name ?? `Wave ${wave.waveNumber ?? '?'}`
    const dLabel = wave.driverName ?? '未指定'
    const isBulk = wave.waveType === 'bulk'
    const zonesHtml = wave.zones.length === 0
      ? '<p style="color:#999;text-align:center;padding:32px;">暂无拣货明细</p>'
      : wave.zones.map(z => `
          <div style="border:1px solid #e0e0e0;border-radius:6px;overflow:hidden;margin-bottom:12px;background:#fff;">
            <div style="padding:8px 14px;background:#f3eff5;color:#875A7B;font-weight:600;font-size:13px;border-bottom:1px solid #e0e0e0;">
              📦 ${z.name} <span style="font-weight:400;color:#888;font-size:12px;">${z.items.length} 种商品</span>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
              <thead>
                <tr style="background:#f8f8f8;border-bottom:1px solid #e0e0e0;">
                  <th style="padding:6px 12px;text-align:left;font-weight:500;color:#555;font-size:12px;">商品</th>
                  <th style="padding:6px 12px;text-align:left;font-weight:500;color:#555;font-size:12px;">规格</th>
                  <th style="padding:6px 12px;text-align:left;font-weight:500;color:#555;font-size:12px;">单位</th>
                  <th style="padding:6px 12px;text-align:right;font-weight:500;color:#555;font-size:12px;">需拣量</th>
                  <th style="padding:6px 12px;text-align:center;font-weight:500;color:#555;font-size:12px;">完成</th>
                  <th style="padding:6px 12px;text-align:left;font-weight:500;color:#555;font-size:12px;">涉及餐馆</th>
                </tr>
              </thead>
              <tbody>
                ${z.items.map((it, i) => `
                  <tr style="border-bottom:1px solid #e8e8e8;background:${i % 2 === 1 ? '#fafafa' : '#fff'};">
                    <td style="padding:7px 12px;color:#333;">${it.productName}</td>
                    <td style="padding:7px 12px;color:#888;">${it.spec ?? ''}</td>
                    <td style="padding:7px 12px;color:#888;">${it.uomName ?? ''}</td>
                    <td style="padding:7px 12px;text-align:right;font-weight:bold;color:#111;">${isKgUom(it.uomName) ? Number(it.requiredQty).toFixed(2) : it.requiredQty}</td>
                    <td style="padding:7px 12px;text-align:center;color:#ccc;font-size:16px;">☐</td>
                    <td style="padding:7px 12px;font-size:11px;color:#888;">${it.restaurants.join('、')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `).join('')
    w.document.write(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>${wLabel} 拣货单</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#fff;padding:20px}@media print{@page{margin:1cm}body{padding:0}}</style>
</head><body>
<div style="margin-bottom:16px;">
  <h1 style="font-size:18px;font-weight:bold;color:#111;">${wLabel} — 拣货单</h1>
  <p style="font-size:13px;color:#555;margin-top:4px;">
    司机：<strong>${dLabel}</strong>
    <span style="margin-left:16px;">类型：<strong>${isBulk ? '大货' : '散货'}</strong></span>
    <span style="margin-left:16px;">打印时间：${new Date().toLocaleString('en-GB')}</span>
  </p>
</div>
${zonesHtml}
<script>window.print();<\/script>
</body></html>`)
    w.document.close()
    w.focus()
  }

  if (loading) {
    return (
      <div>
        <OdooControlPanel breadcrumb={['仓库', '拣货波次', '...']} searchValue="" onSearch={() => {}} total={0} page={1} pageSize={1} />
        <div className="flex items-center justify-center py-24 text-gray-400">
          <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: '#875A7B' }} />
          加载中...
        </div>
      </div>
    )
  }

  if (!wave) {
    return (
      <div>
        <OdooControlPanel breadcrumb={['仓库', '拣货波次', '不存在']} searchValue="" onSearch={() => {}} total={0} page={1} pageSize={1} />
        <div className="py-24 text-center text-gray-400">波次不存在或已删除</div>
      </div>
    )
  }

  const waveLabel = wave.name ?? `Wave ${wave.waveNumber ?? '?'}`
  const totalItems = wave.zones.reduce((s, z) => s + z.items.length, 0)

  const driverLabel = wave.driverName ?? '未指定'
  const isBulk = wave.waveType === 'bulk'
  const sc = slotColor(wave.waveNumber ?? 1)

  return (
    <>
      {/* Print styles */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-only { display: block !important; }
          body { background: white; }
          .print-area { padding: 0; }
        }
        .print-only { display: none; }
      `}</style>

      <div>
        <div className="no-print">
          <OdooControlPanel
            breadcrumb={['仓库', '拣货波次', waveLabel]}
            permanentActions={[
              { label: '← 返回列表', onClick: () => router.back() },
              { label: '🖨 打印拣货单', onClick: handlePrint },
            ]}
            searchValue=""
            onSearch={() => {}}
            total={totalItems}
            page={1}
            pageSize={999}
          />
        </div>

        <div className="p-4 space-y-4 print-area" ref={printRef}>
          {/* Print header */}
          <div className="print-only mb-4">
            <h1 className="text-xl font-bold">{waveLabel} — 拣货单</h1>
            <p className="text-sm text-gray-700 mt-0.5">
              司机：<strong>{driverLabel}</strong>
              <span className="ml-3">类型：<strong>{isBulk ? '大货' : '散货'}</strong></span>
            </p>
            <p className="text-sm text-gray-500 mt-0.5">打印时间：{new Date().toLocaleString('en-GB')}</p>
          </div>

          {/* Meta info with slot-colored header */}
          <div className="bg-white border border-gray-200 rounded overflow-hidden" style={{ borderLeft: `4px solid ${isBulk ? '#f59e0b' : '#875A7B'}` }}>
            <div className="px-4 py-3 flex items-center gap-3 border-b border-gray-100">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-lg flex-shrink-0"
                style={{ background: sc.badge }}
              >
                {wave.waveNumber ?? '?'}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-gray-800">{driverLabel}</span>
                  <span
                    className="text-[11px] px-2 py-0.5 rounded-full font-medium"
                    style={{ background: sc.bg, color: sc.text }}
                  >
                    {isBulk ? '大货' : '散货'}
                  </span>
                </div>
                <div className="text-xs text-gray-500 mt-0.5">{waveLabel}</div>
              </div>
            </div>
            <div className="px-4 py-2 flex flex-wrap gap-6 text-sm text-gray-600">
              <span>关联订单：<strong className="text-gray-900">{wave.orderIds.length}</strong> 张</span>
              <span>分区（餐馆）：<strong className="text-gray-900">{wave.zones.length}</strong> 个</span>
              <span>商品种类：<strong className="text-gray-900">{totalItems}</strong> 种</span>
              <span>创建时间：{new Date(wave.createdAt).toLocaleString('en-GB')}</span>
            </div>
          </div>

          {/* Shortage warning */}
          {shortageSummary && shortageSummary.shortageProducts > 0 && (
            <div className="border border-orange-300 rounded bg-orange-50 overflow-hidden">
              <button
                onClick={() => setShowShortages(v => !v)}
                className="w-full px-4 py-2.5 flex items-center justify-between text-sm font-medium text-orange-800 hover:bg-orange-100 transition-colors"
              >
                <span>
                  ⚠️ 缺货预警：{shortageSummary.shortageProducts}/{shortageSummary.totalProducts} 种商品缺货，缺货率 {(shortageSummary.shortageRate * 100).toFixed(1)}%
                </span>
                <span className="text-xs">{showShortages ? '▲ 收起' : '▼ 展开'}</span>
              </button>
              {showShortages && (
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr style={{ background: '#fff7ed', borderBottom: '1px solid #fdba74' }}>
                      <th className="px-3 py-2 text-left font-medium text-orange-700" style={{ fontSize: '12px' }}>商品</th>
                      <th className="px-3 py-2 text-right font-medium text-orange-700" style={{ fontSize: '12px' }}>需求量</th>
                      <th className="px-3 py-2 text-right font-medium text-orange-700" style={{ fontSize: '12px' }}>库存量</th>
                      <th className="px-3 py-2 text-right font-medium text-orange-700" style={{ fontSize: '12px' }}>缺口</th>
                      <th className="px-3 py-2 text-right font-medium text-orange-700" style={{ fontSize: '12px' }}>缺货率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shortages.map(s => (
                      <tr key={s.productId} style={{ borderBottom: '1px solid #fed7aa' }}>
                        <td className="px-3 py-2 text-gray-700">{s.productName}</td>
                        <td className="px-3 py-2 text-right text-gray-700">{s.demandQty}</td>
                        <td className="px-3 py-2 text-right text-gray-700">{s.stockQty}</td>
                        <td className="px-3 py-2 text-right font-bold text-red-600">{s.shortageQty}</td>
                        <td className="px-3 py-2 text-right text-orange-600">{(s.shortageRate * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Zones (read-only picking list) */}
          {wave.zones.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded p-8 text-center text-gray-400 text-sm">
              暂无拣货明细
            </div>
          ) : (
            wave.zones.map((zone) => (
              <div key={zone.name} className="border border-gray-200 rounded overflow-hidden bg-white">
                <div className="px-4 py-2 font-medium text-sm border-b border-gray-200" style={{ background: '#f3eff5', color: '#875A7B' }}>
                  📦 {zone.name}
                  <span className="ml-2 text-xs font-normal text-gray-500">
                    {zone.items.length} 种商品
                  </span>
                </div>
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr style={{ background: '#f8f8f8', borderBottom: '1px solid #e0e0e0' }}>
                      <th className="px-3 py-2 text-left font-medium text-gray-600" style={{ fontSize: '12px' }}>商品</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600" style={{ fontSize: '12px' }}>规格</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600" style={{ fontSize: '12px' }}>单位</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-600" style={{ fontSize: '12px' }}>需拣量</th>
                      <th className="px-3 py-2 text-center font-medium text-gray-600" style={{ fontSize: '12px' }}>完成</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-600" style={{ fontSize: '12px' }}>涉及餐馆</th>
                    </tr>
                  </thead>
                  <tbody>
                    {zone.items.map((item) => (
                      <tr
                        key={item.productId}
                        style={{ borderBottom: '1px solid #e8e8e8' }}
                      >
                        <td className="px-3 py-2 text-gray-700">
                          <div className="flex items-center gap-2">
                            {item.image && (
                              <img src={item.image} alt={item.productName} className="w-7 h-7 rounded object-cover bg-gray-100" />
                            )}
                            <span>{item.productName}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-gray-500">{item.spec}</td>
                        <td className="px-3 py-2 text-gray-500">{item.uomName ?? ''}</td>
                        <td className="px-3 py-2 text-right font-bold text-gray-900">
                          {isKgUom(item.uomName) ? Number(item.requiredQty).toFixed(2) : item.requiredQty}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {/* Print: checkbox for manual ticking */}
                          <span className="text-base text-gray-300">☐</span>
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-500">{item.restaurants.join('、')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  )
}
