'use client'
import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import type { Product, Order, PurchaseRecord } from '@/lib/types'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NumericInput } from '@/components/ui/numeric-input'
import { Label } from '@/components/ui/label'
import { DrillPanel, type DrillColumn } from '@/components/shared/drill-panel'

const PURPLE = '#875A7B'

type Tab = 'incoming' | 'outgoing' | 'inventory' | 'purchases'

type CardKey = 'incoming' | 'outgoing' | 'lowStock' | 'active' | 'expiring'

interface ExpiringLot {
  id: string
  lotNumber: string
  productId: string
  currentQty: string | number
  bestBefore: string
  isExpired: boolean
  daysRemaining: number
  product?: { id: string; name: string; spec?: string | null }
}

const TAB_LABELS: { id: Tab; label: string; icon: string }[] = [
  { id: 'incoming', label: '今日到货', icon: '📥' },
  { id: 'outgoing', label: '今日出货', icon: '📤' },
  { id: 'inventory', label: '库存总览', icon: '📊' },
  { id: 'purchases', label: '采购记录', icon: '🧾' },
]

function todayStart(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

interface PurchaseForm {
  productId: string
  quantity: string
  unitCost: string
  supplier: string
}

interface AdjustForm {
  productId: string
  qty: string
  note: string
}

export default function ClassicWarehousePage() {
  const [tab, setTab] = useState<Tab>('incoming')
  const [activeCard, setActiveCard] = useState<CardKey | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [orders, setOrders] = useState<Order[]>([])
  const [purchases, setPurchases] = useState<PurchaseRecord[]>([])

  const [purchaseOpen, setPurchaseOpen] = useState(false)
  const [purchaseForm, setPurchaseForm] = useState<PurchaseForm>({ productId: '', quantity: '', unitCost: '', supplier: '' })
  const [purchaseSaving, setPurchaseSaving] = useState(false)

  const [adjustOpen, setAdjustOpen] = useState(false)
  const [adjustForm, setAdjustForm] = useState<AdjustForm>({ productId: '', qty: '', note: '' })
  const [adjustSaving, setAdjustSaving] = useState(false)

  const [expiringLots, setExpiringLots] = useState<ExpiringLot[]>([])

  function load() {
    apiGet<Product[]>('/api/products').then(data => setProducts(data)).catch(() => {})
    apiGet<Order[]>('/api/orders?status=COMPLETED&include_lines=false').then(data => setOrders(data)).catch(() => {})
    apiGet<PurchaseRecord[]>('/api/purchases').then(data => setPurchases(data)).catch(() => {})
    apiGet<ExpiringLot[]>('/api/lots/expiring?days=3').then(data => setExpiringLots(Array.isArray(data) ? data : [])).catch(() => {})
  }

  useEffect(() => { load() }, [])

  const today = todayStart()
  const todayIncoming = purchases.filter(p => p.arrivedAt >= today)
  const todayOutgoing = orders
    .filter(o => o.status.toLowerCase() === 'completed' && o.createdAt >= today)
    .flatMap(o => o.items)
    .reduce<Record<string, { productName: string; spec: string; quantity: number }>>(
      (acc, item) => {
        if (!acc[item.productId]) {
          acc[item.productId] = { productName: item.productName, spec: item.spec, quantity: 0 }
        }
        acc[item.productId].quantity += item.quantity
        return acc
      }, {})

  const LOW_STOCK_THRESHOLD = 20
  const SLOW_MOVING_DAYS = 3
  const threeDaysAgo = new Date(Date.now() - SLOW_MOVING_DAYS * 86400000).toISOString()
  const recentSoldIds = new Set(
    orders
      .filter(o => o.createdAt >= threeDaysAgo)
      .flatMap(o => o.items.map(i => i.productId))
  )

  const activeProducts = products.filter(p => p.status === 'active')

  async function handlePurchaseSave() {
    if (purchaseSaving) return
    if (!purchaseForm.productId) { toast.error('请选择商品'); return }
    const qty = Number(purchaseForm.quantity)
    const cost = Number(purchaseForm.unitCost)
    if (!qty || qty <= 0 || qty > 100000) { toast.error('数量必须在 1–100,000 之间'); return }
    if (!cost || cost <= 0 || cost > 1000000) { toast.error('单价必须大于0'); return }
    if (!purchaseForm.supplier.trim()) { toast.error('供应商不能为空'); return }

    setPurchaseSaving(true)
    const prod = products.find(p => p.id === purchaseForm.productId)!
    try {
      await apiPost('/api/purchases', {
        productId: purchaseForm.productId,
        productName: prod.name,
        spec: prod.spec ?? '',
        quantity: qty,
        unitCost: cost,
        supplier: purchaseForm.supplier.trim().slice(0, 200),
        arrivedAt: new Date().toISOString(),
      })
      load()
      setPurchaseOpen(false)
      setPurchaseForm({ productId: '', quantity: '', unitCost: '', supplier: '' })
      toast.success(`已录入 ${prod.name} 入库 ${qty} 件，成本已更新`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '录入失败')
    } finally {
      setPurchaseSaving(false)
    }
  }

  async function handleAdjustSave() {
    if (adjustSaving) return
    if (!adjustForm.productId) { toast.error('请选择商品'); return }
    const qty = Number(adjustForm.qty)
    if (!qty) { toast.error('调整数量不能为0'); return }
    if (Math.abs(qty) > 100000) { toast.error('调整数量过大（最大 100,000）'); return }
    if (!adjustForm.note.trim()) { toast.error('请填写调整原因'); return }

    setAdjustSaving(true)
    try {
      await apiPost('/api/stock-moves', {
        productId: adjustForm.productId,
        qty,
        note: adjustForm.note.trim().slice(0, 500),
      })
      load()
      setAdjustOpen(false)
      setAdjustForm({ productId: '', qty: '', note: '' })
      toast.success('库存已调整')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '调整失败')
    } finally {
      setAdjustSaving(false)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">仓库管理</h1>
          <p className="text-sm text-gray-500 mt-1">
            {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })} · 实时库存与进出货记录
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => setAdjustOpen(true)}
            style={{ borderColor: PURPLE, color: PURPLE }}
            className="hover:opacity-80"
          >
            调整库存
          </Button>
          <Button
            onClick={() => setPurchaseOpen(true)}
            style={{ background: PURPLE }}
            className="text-white hover:opacity-90"
          >
            + 录入采购
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <MiniCard
          label="今日到货批次"
          value={`${todayIncoming.length} 批`}
          icon="📥"
          color="text-blue-700"
          active={activeCard === 'incoming'}
          onClick={() => setActiveCard(prev => prev === 'incoming' ? null : 'incoming')}
        />
        <MiniCard
          label="今日出货品类"
          value={`${Object.keys(todayOutgoing).length} 种`}
          icon="📤"
          color="text-emerald-700"
          active={activeCard === 'outgoing'}
          onClick={() => setActiveCard(prev => prev === 'outgoing' ? null : 'outgoing')}
        />
        <MiniCard
          label="低库存预警"
          value={`${activeProducts.filter(p => (p.qtyOnHand ?? p.stock ?? 0) <= LOW_STOCK_THRESHOLD).length} 种`}
          icon="⚠️"
          color="text-amber-700"
          active={activeCard === 'lowStock'}
          onClick={() => setActiveCard(prev => prev === 'lowStock' ? null : 'lowStock')}
        />
        <MiniCard
          label="临期/过期批次"
          value={`${expiringLots.length} 批`}
          icon="🕐"
          color={expiringLots.some(l => l.isExpired) ? 'text-red-700' : 'text-orange-700'}
          active={activeCard === 'expiring'}
          onClick={() => setActiveCard(prev => prev === 'expiring' ? null : 'expiring')}
        />
        <MiniCard
          label="在售商品"
          value={`${activeProducts.length} 种`}
          icon="🥬"
          color="text-gray-700"
          active={activeCard === 'active'}
          onClick={() => setActiveCard(prev => prev === 'active' ? null : 'active')}
        />
      </div>

      <WarehouseDrillPanel
        activeCard={activeCard}
        close={() => setActiveCard(null)}
        todayIncoming={todayIncoming}
        todayOutgoing={todayOutgoing}
        lowStockProducts={activeProducts.filter(p => (p.qtyOnHand ?? p.stock ?? 0) <= LOW_STOCK_THRESHOLD)}
        activeProducts={activeProducts}
        expiringLots={expiringLots}
        switchTab={setTab}
        openAdjust={(productId) => { setAdjustForm({ productId, qty: '', note: '' }); setAdjustOpen(true) }}
      />

      <div className="flex gap-1 mb-5 bg-white border border-gray-200 rounded-xl p-1">
        {TAB_LABELS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
              tab === t.id ? 'text-white shadow-sm' : 'text-gray-600 hover:bg-gray-100'
            }`}
            style={tab === t.id ? { background: PURPLE } : {}}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'incoming' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between" style={{ background: '#f3eff5' }}>
            <div>
              <h3 className="font-semibold text-gray-800">📥 今日到货清单</h3>
              <p className="text-xs text-gray-500 mt-0.5">共 {todayIncoming.length} 批次入库</p>
            </div>
            <Button
              size="sm"
              onClick={() => setPurchaseOpen(true)}
              style={{ background: PURPLE }}
              className="text-white hover:opacity-90 text-xs"
            >
              + 录入到货
            </Button>
          </div>
          {todayIncoming.length === 0 ? (
            <div className="py-12 text-center text-gray-400 text-sm">今日暂无到货记录，点击「录入到货」添加</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">商品</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">规格</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">供应商</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600">数量</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600">单价</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">到货时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {todayIncoming.map(p => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{p.productName}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{p.spec}</td>
                    <td className="px-4 py-3 text-gray-600">{p.supplier}</td>
                    <td className="px-4 py-3 text-right font-bold text-blue-700">{p.quantity}</td>
                    <td className="px-4 py-3 text-right text-gray-600">€{p.unitCost.toFixed(2)}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {new Date(p.arrivedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'outgoing' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100" style={{ background: '#f3eff5' }}>
            <h3 className="font-semibold text-gray-800">📤 今日出货汇总</h3>
            <p className="text-xs text-gray-500 mt-0.5">基于今日已完成订单汇总</p>
          </div>
          {Object.keys(todayOutgoing).length === 0 ? (
            <div className="py-12 text-center text-gray-400 text-sm">今日暂无出货记录（订单需完成后才计入）</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">商品</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">规格</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600">出货量</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {Object.values(todayOutgoing).map((item, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{item.productName}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{item.spec}</td>
                    <td className="px-4 py-3 text-right font-bold text-emerald-700">{item.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'inventory' && (
        <div className="space-y-3">
          {activeProducts.filter(p => (p.qtyOnHand ?? p.stock ?? 0) <= LOW_STOCK_THRESHOLD).length > 0 && (
            <div className="rounded-xl p-4" style={{ background: '#f3eff5', border: '1px solid #d4c0d4' }}>
              <h3 className="font-semibold mb-3" style={{ color: PURPLE }}>⚠️ 低库存预警（≤{LOW_STOCK_THRESHOLD}件）</h3>
              <div className="space-y-2">
                {activeProducts
                  .filter(p => (p.qtyOnHand ?? p.stock ?? 0) <= LOW_STOCK_THRESHOLD)
                  .map(p => (
                    <div key={p.id} className="flex items-center justify-between bg-white rounded-lg px-3 py-2 border border-gray-200">
                      <span className="font-medium text-gray-900">{p.name}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-gray-500">{p.spec}</span>
                        <span className="text-sm font-bold px-2 py-0.5 rounded-full" style={{ background: '#f3eff5', color: PURPLE }}>
                          剩余 {(p.qtyOnHand ?? p.stock ?? 0)} 件
                        </span>
                        <button
                          onClick={() => { setAdjustForm({ productId: p.id, qty: '', note: '补货入库' }); setAdjustOpen(true) }}
                          className="text-xs hover:underline"
                          style={{ color: PURPLE }}
                        >
                          调整库存
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <h3 className="font-semibold text-gray-800">📊 全部商品库存</h3>
              <Button size="sm" variant="outline" onClick={() => setAdjustOpen(true)} className="text-xs">
                + 库存调整
              </Button>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">商品</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">规格</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600">库存</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600">成本价</th>
                  <th className="text-center px-4 py-2.5 font-medium text-gray-600">状态</th>
                  <th className="text-center px-4 py-2.5 font-medium text-gray-600">动销</th>
                  <th className="text-center px-4 py-2.5 font-medium text-gray-600">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {products.map(p => {
                  const isLow = (p.qtyOnHand ?? p.stock ?? 0) <= LOW_STOCK_THRESHOLD && p.status === 'active'
                  const isSlow = !recentSoldIds.has(p.id) && p.status === 'active'
                  return (
                    <tr key={p.id} className="hover:bg-gray-50" style={isLow ? { background: '#fdf8ff' } : {}}>
                      <td className="px-4 py-3 font-medium">{p.name}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{p.spec}</td>
                      <td className={`px-4 py-3 text-right font-bold ${isLow ? '' : 'text-gray-900'}`} style={isLow ? { color: PURPLE } : {}}>
                        {(p.qtyOnHand ?? p.stock ?? 0)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-500 text-xs">
                        {p.standardPrice != null ? `€${p.standardPrice.toFixed(2)}` : '-'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          p.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
                        }`}>
                          {p.status === 'active' ? '在售' : '下架'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {p.status === 'active' && (
                          isSlow ? (
                            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">滞销</span>
                          ) : (
                            <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">正常</span>
                          )
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={() => { setAdjustForm({ productId: p.id, qty: '', note: '' }); setAdjustOpen(true) }}
                          className="text-xs hover:underline"
                          style={{ color: PURPLE }}
                        >
                          调整
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'purchases' && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between" style={{ background: '#f3eff5' }}>
            <div>
              <h3 className="font-semibold text-gray-800">🧾 采购记录</h3>
              <p className="text-xs text-gray-500 mt-0.5">共 {purchases.length} 条</p>
            </div>
            <Button
              size="sm"
              onClick={() => setPurchaseOpen(true)}
              style={{ background: PURPLE }}
              className="text-white hover:opacity-90 text-xs"
            >
              + 录入采购
            </Button>
          </div>
          {purchases.length === 0 ? (
            <div className="py-12 text-center text-gray-400 text-sm">暂无采购记录</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">商品</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">供应商</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600">数量</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600">单价</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600">金额</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">到货时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {purchases.map(p => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="font-medium">{p.productName}</div>
                      <div className="text-xs text-gray-400">{p.spec}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{p.supplier}</td>
                    <td className="px-4 py-3 text-right font-bold text-gray-800">{p.quantity}</td>
                    <td className="px-4 py-3 text-right text-gray-600">€{p.unitCost.toFixed(2)}</td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      €{(p.quantity * p.unitCost).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {new Date(p.arrivedAt).toLocaleString('en-GB')}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 border-t border-gray-200">
                <tr>
                  <td colSpan={4} className="px-4 py-2.5 text-right text-sm text-gray-600 font-medium">采购总额</td>
                  <td className="px-4 py-2.5 text-right font-bold text-gray-900">
                    €{purchases.reduce((s, p) => s + p.quantity * p.unitCost, 0).toFixed(2)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      )}

      {/* 录入采购对话框 */}
      <Dialog open={purchaseOpen} onOpenChange={setPurchaseOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>录入采购入库</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>选择商品 *</Label>
              <select
                className="mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2"
                style={{ ['--tw-ring-color' as string]: PURPLE }}
                value={purchaseForm.productId}
                onChange={e => setPurchaseForm(f => ({ ...f, productId: e.target.value }))}
              >
                <option value="">请选择商品...</option>
                {products.filter(p => p.status === 'active').map(p => (
                  <option key={p.id} value={p.id}>{p.name} {p.spec ? `(${p.spec})` : ''}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="pur-qty">入库数量 *</Label>
                <NumericInput
                  id="pur-qty"
                  min={0.001}
                  step="0.001"
                  className="mt-1"
                  value={purchaseForm.quantity}
                  onChange={e => setPurchaseForm(f => ({ ...f, quantity: e.target.value }))}
                  placeholder="如 100 或 0.6"
                />
              </div>
              <div>
                <Label htmlFor="pur-cost">进货单价（€）*</Label>
                <NumericInput
                  id="pur-cost"
                  min={0}
                  step={0.01}
                  className="mt-1"
                  value={purchaseForm.unitCost}
                  onChange={e => setPurchaseForm(f => ({ ...f, unitCost: e.target.value }))}
                  placeholder="如 1.50"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="pur-supplier">供应商 *</Label>
              <Input
                id="pur-supplier"
                className="mt-1"
                value={purchaseForm.supplier}
                onChange={e => setPurchaseForm(f => ({ ...f, supplier: e.target.value }))}
                placeholder="如 Dublin Fresh Produce Ltd"
              />
            </div>
            <div className="p-3 rounded-lg text-xs" style={{ background: '#f3eff5', border: '1px solid #d4c0d4', color: PURPLE }}>
              录入后将自动更新商品库存和加权平均成本价
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPurchaseOpen(false)} disabled={purchaseSaving}>取消</Button>
            <Button
              style={{ background: PURPLE }}
              className="text-white hover:opacity-90"
              onClick={handlePurchaseSave}
              disabled={purchaseSaving}
            >
              {purchaseSaving ? '保存中…' : '确认入库'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 库存调整对话框 */}
      <Dialog open={adjustOpen} onOpenChange={setAdjustOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>库存调整</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>选择商品 *</Label>
              <select
                className="mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2"
                value={adjustForm.productId}
                onChange={e => setAdjustForm(f => ({ ...f, productId: e.target.value }))}
              >
                <option value="">请选择商品...</option>
                {products.map(p => {
                  const qty = p.qtyOnHand ?? p.stock ?? 0
                  return (
                    <option key={p.id} value={p.id}>{p.name} (当前库存: {qty})</option>
                  )
                })}
              </select>
            </div>
            <div>
              <Label htmlFor="adj-qty">调整数量 *</Label>
              <NumericInput
                id="adj-qty"
                step="0.001"
                className="mt-1"
                value={adjustForm.qty}
                onChange={e => setAdjustForm(f => ({ ...f, qty: e.target.value }))}
                placeholder="正数=增加，负数=减少，如 +10 或 -0.5"
              />
            </div>
            <div>
              <Label htmlFor="adj-note">调整原因 *</Label>
              <Input
                id="adj-note"
                className="mt-1"
                value={adjustForm.note}
                onChange={e => setAdjustForm(f => ({ ...f, note: e.target.value }))}
                placeholder="如：损耗处理、盘点调整、客户退货"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustOpen(false)} disabled={adjustSaving}>取消</Button>
            <Button
              style={{ background: PURPLE }}
              className="text-white hover:opacity-90"
              onClick={handleAdjustSave}
              disabled={adjustSaving}
            >
              {adjustSaving ? '调整中…' : '确认调整'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function MiniCard({ label, value, icon, color, active, onClick }: {
  label: string
  value: string
  icon: string
  color: string
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-xl border p-4 shadow-sm transition-all w-full ${
        active
          ? 'bg-amber-50 border-amber-300 ring-2 ring-amber-200 shadow-md'
          : 'bg-white border-gray-200 hover:shadow-md hover:border-gray-300'
      }`}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-500 flex items-center gap-1">
            {label}
            <span className="text-[10px] text-gray-400">{active ? '▾' : '›'}</span>
          </p>
          <p className={`text-xl font-bold mt-0.5 ${color}`}>{value}</p>
        </div>
        <span className="text-2xl">{icon}</span>
      </div>
    </button>
  )
}

interface OutgoingItem { productName: string; spec: string; quantity: number }

function WarehouseDrillPanel({
  activeCard, close, todayIncoming, todayOutgoing, lowStockProducts, activeProducts, expiringLots, switchTab, openAdjust,
}: {
  activeCard: CardKey | null
  close: () => void
  todayIncoming: PurchaseRecord[]
  todayOutgoing: Record<string, OutgoingItem>
  lowStockProducts: Product[]
  activeProducts: Product[]
  expiringLots: ExpiringLot[]
  switchTab: (t: Tab) => void
  openAdjust: (productId: string) => void
}) {
  if (!activeCard) return null

  if (activeCard === 'incoming') {
    const cols: DrillColumn<PurchaseRecord>[] = [
      { key: 'name', label: '商品', render: p => <span className="font-medium text-gray-800">{p.productName}</span> },
      { key: 'spec', label: '规格', render: p => <span className="text-xs text-gray-500">{p.spec}</span> },
      { key: 'supplier', label: '供应商', render: p => <span className="text-gray-600">{p.supplier}</span> },
      { key: 'qty', label: '数量', align: 'right', render: p => <span className="font-bold text-blue-700">{p.quantity}</span> },
      { key: 'cost', label: '单价', align: 'right', render: p => <span className="text-gray-600">€{p.unitCost.toFixed(2)}</span> },
      {
        key: 'time', label: '到货时间', render: p =>
          <span className="text-xs text-gray-500">{new Date(p.arrivedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>,
      },
    ]
    return (
      <div className="mb-6">
        <DrillPanel<PurchaseRecord>
          title="今日到货批次"
          fullListLabel="切换到「今日到货」页签"
          columns={cols}
          rows={todayIncoming}
          rowKey={p => p.id}
          onClose={close}
          emptyText="今日暂无到货记录"
        />
        <div className="-mt-4 mb-2 text-right">
          <button onClick={() => { switchTab('incoming'); close() }} className="text-xs hover:underline" style={{ color: PURPLE }}>
            切换到「今日到货」页签 →
          </button>
        </div>
      </div>
    )
  }

  if (activeCard === 'outgoing') {
    const rows = Object.entries(todayOutgoing).map(([productId, item]) => ({ productId, ...item }))
    const cols: DrillColumn<typeof rows[0]>[] = [
      { key: 'name', label: '商品', render: r => <span className="font-medium text-gray-800">{r.productName}</span> },
      { key: 'spec', label: '规格', render: r => <span className="text-xs text-gray-500">{r.spec}</span> },
      { key: 'qty', label: '出货量', align: 'right', render: r => <span className="font-bold text-emerald-700">{r.quantity}</span> },
    ]
    return (
      <div className="mb-6">
        <DrillPanel
          title="今日出货品类"
          fullListLabel="切换到「今日出货」页签"
          columns={cols}
          rows={rows}
          rowKey={r => r.productId}
          onClose={close}
          emptyText="今日暂无出货记录"
        />
        <div className="-mt-4 mb-2 text-right">
          <button onClick={() => { switchTab('outgoing'); close() }} className="text-xs hover:underline" style={{ color: PURPLE }}>
            切换到「今日出货」页签 →
          </button>
        </div>
      </div>
    )
  }

  if (activeCard === 'expiring') {
    const cols: DrillColumn<ExpiringLot>[] = [
      {
        key: 'product', label: '商品', render: l =>
          <span className="font-medium text-gray-800">{l.product?.name ?? '未知商品'}</span>,
      },
      {
        key: 'lot', label: '批号', render: l =>
          <span className="text-xs font-mono text-gray-600">{l.lotNumber}</span>,
      },
      {
        key: 'qty', label: '剩余库存', align: 'right', render: l =>
          <span className="font-bold text-gray-900">{Number(l.currentQty)}</span>,
      },
      {
        key: 'bestBefore', label: '保质期', render: l => {
          const d = new Date(l.bestBefore)
          return (
            <span className={`text-xs font-medium ${l.isExpired ? 'text-red-600' : 'text-orange-600'}`}>
              {d.toLocaleDateString('zh-CN')}
              {l.isExpired
                ? ` (已过期 ${Math.abs(l.daysRemaining)} 天)`
                : ` (剩 ${l.daysRemaining} 天)`}
            </span>
          )
        },
      },
      {
        key: 'status', label: '状态', align: 'center', render: l =>
          l.isExpired
            ? <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">已过期</span>
            : <span className="text-xs px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 font-medium">临期</span>,
      },
    ]
    const sorted = [...expiringLots].sort((a, b) => a.daysRemaining - b.daysRemaining)
    return (
      <div className="mb-6">
        <DrillPanel<ExpiringLot>
          title="临期/过期批次"
          columns={cols}
          rows={sorted}
          rowKey={l => l.id}
          onClose={close}
          emptyText="暂无临期或过期批次"
        />
      </div>
    )
  }

  if (activeCard === 'lowStock' || activeCard === 'active') {
    const isLow = activeCard === 'lowStock'
    const rows = isLow
      ? [...lowStockProducts].sort((a, b) => (a.qtyOnHand ?? a.stock ?? 0) - (b.qtyOnHand ?? b.stock ?? 0))
      : activeProducts
    const cols: DrillColumn<Product>[] = [
      { key: 'name', label: '商品', render: p => <span className="font-medium text-gray-800">{p.name}</span> },
      { key: 'spec', label: '规格', render: p => <span className="text-xs text-gray-500">{p.spec}</span> },
      {
        key: 'qty', label: '库存', align: 'right', render: p => {
          const q = p.qtyOnHand ?? p.stock ?? 0
          return <span className={`font-bold ${q <= 20 ? 'text-amber-700' : 'text-gray-900'}`}>{q}</span>
        },
      },
      {
        key: 'cost', label: '成本价', align: 'right', render: p =>
          p.standardPrice != null ? <span className="text-gray-600">€{p.standardPrice.toFixed(2)}</span> : <span className="text-gray-300">—</span>,
      },
      {
        key: 'action', label: '操作', align: 'center', render: p => (
          <button
            onClick={(e) => { e.stopPropagation(); openAdjust(p.id) }}
            className="text-xs hover:underline"
            style={{ color: PURPLE }}
          >
            调整库存
          </button>
        ),
      },
    ]
    return (
      <div className="mb-6">
        <DrillPanel<Product>
          title={isLow ? '低库存预警商品' : '在售商品'}
          fullListLabel="切换到「库存总览」页签"
          columns={cols}
          rows={rows}
          rowKey={p => p.id}
          onClose={close}
          emptyText={isLow ? '暂无低库存商品' : '暂无在售商品'}
        />
        <div className="-mt-4 mb-2 text-right">
          <button onClick={() => { switchTab('inventory'); close() }} className="text-xs hover:underline" style={{ color: PURPLE }}>
            切换到「库存总览」页签 →
          </button>
        </div>
      </div>
    )
  }

  return null
}
