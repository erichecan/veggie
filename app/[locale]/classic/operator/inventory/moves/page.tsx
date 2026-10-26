'use client'
/**
 * 库存流水 —— 20261014（复式改造 L3）
 * 全部库存流水，每行一笔「从 → 到」。可按商品、单据、库位、类型、日期筛选。
 * 也作为库存管理页的「库存流水」tab 嵌入；?sourceId= / ?productId= 可从单据、商品页直接带条件进来。
 */
import { useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import StockMovesTable, { type StockMoveFilter } from '@/components/classic/StockMovesTable'
import { LOC } from '@/lib/stock-locations'

const LOCATIONS: Array<{ id: string; zh: string; en: string }> = [
  { id: LOC.STOCK, zh: '仓库/库存', en: 'WH/Stock' },
  { id: LOC.CUSTOMERS, zh: '客户', en: 'Customers' },
  { id: LOC.VENDORS, zh: '供应商', en: 'Vendors' },
  { id: LOC.SCRAP, zh: '报废', en: 'Scrap' },
  { id: LOC.INVENTORY, zh: '盘点调整', en: 'Inventory adjustment' },
  { id: LOC.OPENING, zh: '期初', en: 'Opening balance' },
]

export default function StockMovesPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const sp = useSearchParams()
  const [q, setQ] = useState('')
  const [location, setLocation] = useState('')
  // type/from/to 支持从库存总览页「本月损耗率」卡片带条件跳转进来
  const [type, setType] = useState(() => sp?.get('type') || '')
  const [from, setFrom] = useState(() => sp?.get('from') || '')
  const [to, setTo] = useState(() => sp?.get('to') || '')
  const [total, setTotal] = useState<number | null>(null)

  const filter: StockMoveFilter = useMemo(() => ({
    q: q.trim() || undefined,
    location: location || undefined,
    type: type || undefined,
    from: from || undefined,
    to: to || undefined,
    sourceId: sp?.get('sourceId') || undefined,
    productId: sp?.get('productId') || undefined,
    lotId: sp?.get('lotId') || undefined,
  }), [q, location, type, from, to, sp])

  const ctl = 'border border-gray-300 rounded px-2 py-1 text-sm bg-white'
  return (
    <div className="space-y-3" data-testid="stock-moves-page">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">{isEn ? 'Stock Moves' : '库存流水'}</h1>
          <p className="text-xs text-gray-500">
            {isEn
              ? 'Every stock change is recorded as a move from one location to another (double-entry). On hand = Σ moves into/out of WH/Stock.'
              : '每一次库存变化都记成一笔「从一个库位到另一个库位」（复式）。在手量 = 进出「仓库/库存」的流水合计。'}
            {total != null && <span className="ml-2">{isEn ? `${total} moves` : `共 ${total} 笔`}</span>}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <input className={`${ctl} w-64`} placeholder={isEn ? 'Search product / reference / note' : '搜索商品 / 单据号 / 备注'} value={q} onChange={e => setQ(e.target.value)} />
        <select className={ctl} value={location} onChange={e => setLocation(e.target.value)}>
          <option value="">{isEn ? 'All locations' : '全部库位'}</option>
          {LOCATIONS.map(l => <option key={l.id} value={l.id}>{isEn ? l.en : l.zh}</option>)}
        </select>
        <select className={ctl} value={type} onChange={e => setType(e.target.value)}>
          <option value="">{isEn ? 'All types' : '全部类型'}</option>
          <option value="IN">{isEn ? 'In' : '入库'}</option>
          <option value="OUT">{isEn ? 'Out' : '出库'}</option>
          <option value="RETURN">{isEn ? 'Return' : '退回'}</option>
          <option value="SCRAP">{isEn ? 'Scrap' : '报废'}</option>
          <option value="ADJUSTMENT">{isEn ? 'Adjustment' : '调整'}</option>
        </select>
        <input type="date" className={ctl} value={from} onChange={e => setFrom(e.target.value)} />
        <span className="text-gray-400">–</span>
        <input type="date" className={ctl} value={to} onChange={e => setTo(e.target.value)} />
      </div>
      <StockMovesTable filter={filter} isEn={isEn} pageSize={100} showValue={false} onLoaded={setTotal} />
    </div>
  )
}
