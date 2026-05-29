'use client'
import { useState, useEffect, use, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPut } from '@/lib/api'
import type { Trip, ReturnItem } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { NumericInput } from '@/components/ui/numeric-input'
import { TripStatusBadge } from '@/components/shared/status-badge'

const PURPLE = '#875A7B'

const EXCEPTION_REASONS = ['品质问题', '数量错误', '客户拒收', '配送延误', '包装破损', '其他']

interface ExceptionProduct {
  productId: string
  productName: string
  quantity: number
  selected: boolean
}

export default function ClassicTripExecutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const [trip, setTrip] = useState<Trip | null>(null)
  const [expandedRest, setExpandedRest] = useState<string | null>(null)

  // 报告异常 modal
  const [exceptionModal, setExceptionModal] = useState<{ restId: string } | null>(null)
  const [exceptionProducts, setExceptionProducts] = useState<ExceptionProduct[]>([])
  const [exceptionReasons, setExceptionReasons] = useState<string[]>([])
  const [exceptionAction, setExceptionAction] = useState<'return' | 'exchange'>('return')

  // 旧退货 modal（保留兼容性）
  const [returnModal, setReturnModal] = useState<{ restId: string } | null>(null)
  const [returnForm, setReturnForm] = useState<{ productId: string; productName: string; qty: number; photo: string }>({
    productId: '', productName: '', qty: 1, photo: ''
  })
  const podInputRef = useRef<HTMLInputElement>(null)
  const returnPhotoRef = useRef<HTMLInputElement>(null)
  const [podRestId, setPodRestId] = useState<string | null>(null)

  function load() {
    apiGet<Trip>(`/api/trips/${id}`)
      .then(t => setTrip(t))
      .catch(() => setTrip(null))
  }

  useEffect(() => { load() }, [id])

  async function saveTrip(updated: Trip) {
    await apiPut(`/api/trips/${updated.id}`, updated)
    setTrip(updated)
  }

  function cloneTrip(): Trip {
    return JSON.parse(JSON.stringify(trip)) as Trip
  }

  async function verifyAllCargo() {
    if (!trip) return
    const updated = cloneTrip()
    updated.restaurants = updated.restaurants.map(r => ({ ...r, cargoVerified: true }))
    updated.status = 'verifying'
    await saveTrip(updated)
    toast.success('货物核查完成')
  }

  async function startDelivery() {
    if (!trip) return
    const updated = cloneTrip()
    updated.status = 'in_progress'
    await saveTrip(updated)
    toast.success('已确认出发，开始配送')
  }

  async function setPayment(restId: string, amount: number) {
    if (!trip) return
    const updated = cloneTrip()
    const r = updated.restaurants.find(r => r.restaurantId === restId)
    if (r) r.payment = amount
    await saveTrip(updated)
  }

  function openExceptionModal(restId: string) {
    if (!trip) return
    const rest = trip.restaurants.find(r => r.restaurantId === restId)
    if (!rest) return
    setExceptionProducts(rest.items.map(item => ({
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity,
      selected: false,
    })))
    setExceptionReasons([])
    setExceptionAction('return')
    setExceptionModal({ restId })
  }

  async function submitException() {
    if (!trip || !exceptionModal) return
    const selected = exceptionProducts.filter(p => p.selected)
    if (selected.length === 0) { toast.error('请勾选有异常的商品'); return }
    const reasonText = exceptionReasons.join('、')
    if (!reasonText.trim()) { toast.error('请填写异常原因'); return }

    const updated = cloneTrip()
    const r = updated.restaurants.find(r => r.restaurantId === exceptionModal.restId)
    if (!r) return

    const now = new Date().toISOString()
    for (const p of selected) {
      const entry: ReturnItem = {
        productId: p.productId,
        productName: p.productName,
        quantity: p.quantity,
        reason: reasonText,
        actionType: exceptionAction,
        restaurantId: r.restaurantId,
        restaurantName: r.restaurantName,
        tripId: trip.id,
        createdAt: now,
      }
      const existing = r.returns.find(x => x.productId === p.productId && x.actionType === exceptionAction)
      if (existing) {
        existing.quantity += p.quantity
        existing.reason = reasonText
      } else {
        r.returns.push(entry)
      }
    }

    await saveTrip(updated)
    setExceptionModal(null)
    toast.success('异常已记录，已添加到退换货记录')
  }

  async function addReturn(restId: string) {
    if (!trip) return
    const { productId, productName, qty, photo } = returnForm
    if (!productId || qty <= 0) { toast.error('请填写退货商品和数量'); return }
    const updated = cloneTrip()
    const r = updated.restaurants.find(r => r.restaurantId === restId)
    if (!r) return
    const existing = r.returns.find(x => x.productId === productId)
    if (existing) {
      existing.quantity += qty
      if (photo) existing.photo = photo
    } else {
      r.returns.push({ productId, productName, quantity: qty, photo: photo || undefined })
    }
    await saveTrip(updated)
    setReturnModal(null)
    setReturnForm({ productId: '', productName: '', qty: 1, photo: '' })
    toast.success('退货记录已添加')
  }

  function handlePodUpload(e: React.ChangeEvent<HTMLInputElement>, restId: string) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      const updated = cloneTrip()
      const r = updated.restaurants.find(r => r.restaurantId === restId)
      if (r) r.pods.push(reader.result as string)
      await saveTrip(updated)
      toast.success('POD 图片已上传')
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  function handleReturnPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setReturnForm(f => ({ ...f, photo: reader.result as string }))
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  async function markRestDelivered(restId: string) {
    if (!trip) return
    const r = trip.restaurants.find(r => r.restaurantId === restId)
    if (!r) return
    if (r.payment === undefined) { toast.error('请先填写实收货款'); return }
    const updated = cloneTrip()
    const ur = updated.restaurants.find(r => r.restaurantId === restId)
    if (ur) ur.delivered = true
    updated.totalPayment = updated.restaurants.reduce((s, r) => s + (r.payment ?? 0), 0)
    await saveTrip(updated)
    setExpandedRest(null)
    toast.success(`${r.restaurantName} 配送完成`)
  }

  async function endTrip() {
    if (!trip) return
    const unprocessed = trip.restaurants.filter(r => !r.delivered && r.returns.length === 0)
    if (unprocessed.length > 0) {
      const names = unprocessed.map(r => r.restaurantName).join('、')
      toast.error(`请先完成以下站点（送达或报告异常）：${names}`)
      return
    }
    const updated = cloneTrip()
    updated.status = 'completed'
    updated.totalPayment = updated.restaurants.reduce((s, r) => s + (r.payment ?? 0), 0)
    await saveTrip(updated)
    toast.success('行程已结束，订单已更新为完成')
    router.push(`${prefix}/classic/driver`)
  }

  if (!trip) return <div className="text-center py-16 text-gray-400">行程不存在</div>

  const allVerified = trip.restaurants.every(r => r.cargoVerified)
  const processedCount = trip.restaurants.filter(r => r.delivered || r.returns.length > 0).length
  const allProcessed = processedCount === trip.restaurants.length
  const tripStatus = trip.status.toLowerCase()

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <button
              onClick={() => router.push(`${prefix}/classic/driver`)}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              ← 返回任务列表
            </button>
          </div>
          <h1 className="text-xl font-bold text-gray-900">配送执行</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className="font-mono text-xs text-gray-400">{trip.id}</span>
            <TripStatusBadge status={trip.status} />
          </div>
        </div>
        {tripStatus !== 'completed' && (
          <Button
            onClick={endTrip}
            style={allProcessed ? { background: PURPLE, borderColor: PURPLE } : {}}
            className={allProcessed ? 'text-white hover:opacity-90' : ''}
            variant={allProcessed ? 'default' : 'outline'}
            disabled={tripStatus === 'pending' || tripStatus === 'verifying' || !allProcessed}
          >
            结束行程 ({processedCount}/{trip.restaurants.length})
          </Button>
        )}
      </div>

      {/* 核货阶段 */}
      {tripStatus === 'pending' && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 mb-5">
          <p className="font-medium text-yellow-800 mb-3">📦 出发前货物核查</p>
          <div className="space-y-2 mb-4">
            {trip.restaurants.map(r => (
              <div key={r.restaurantId} className="flex items-center justify-between text-sm">
                <span className="text-gray-700">🏪 {r.restaurantName}</span>
                <div className="flex items-center gap-2">
                  <span className="text-gray-500">{r.items.length} 种商品</span>
                  {r.cargoVerified
                    ? <span className="text-green-600 font-medium">✓ 已核</span>
                    : <span className="text-gray-400">待核</span>
                  }
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={verifyAllCargo} className="flex-1">
              一键核货完成
            </Button>
            <Button
              onClick={startDelivery}
              style={{ background: PURPLE, borderColor: PURPLE }}
              className="flex-1 text-white hover:opacity-90"
              disabled={!allVerified}
            >
              确认出发 🚛
            </Button>
          </div>
        </div>
      )}

      {tripStatus === 'verifying' && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 mb-5">
          <p className="font-medium text-yellow-800 mb-2">✅ 货物核查完成，可以出发</p>
          <Button
            onClick={startDelivery}
            style={{ background: PURPLE, borderColor: PURPLE }}
            className="w-full text-white hover:opacity-90"
          >
            确认出发 🚛
          </Button>
        </div>
      )}

      {/* 总收款信息 */}
      {(tripStatus === 'in_progress' || tripStatus === 'completed') && (
        <div className="rounded-xl p-4 mb-5 flex justify-between items-center" style={{ background: '#f3eff5', border: '1px solid #d4c0d4' }}>
          <span className="font-medium" style={{ color: PURPLE }}>💰 累计实收</span>
          <span className="text-2xl font-bold" style={{ color: PURPLE }}>€{trip.totalPayment.toFixed(2)}</span>
        </div>
      )}

      {/* 餐馆列表 */}
      <div className="space-y-3">
        {trip.restaurants.map(r => {
          const hasException = r.returns.length > 0
          const isProcessed = r.delivered || hasException
          const borderColor = r.delivered ? 'border-green-300' : hasException ? 'border-orange-300' : 'border-gray-200'
          const headerBg = r.delivered ? 'bg-green-50' : hasException ? 'bg-orange-50' : 'bg-gray-50'

          return (
            <div key={r.restaurantId} className={`bg-white rounded-xl border overflow-hidden ${borderColor}`}>
              <div className={`px-4 py-3 flex items-center justify-between ${headerBg}`}>
                {/* 左侧：餐馆名 + 状态 + 报告异常按钮 */}
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  <button
                    className="font-medium text-gray-900 text-left"
                    onClick={() => setExpandedRest(expandedRest === r.restaurantId ? null : r.restaurantId)}
                  >
                    🏪 {r.restaurantName}
                  </button>
                  {r.delivered && <span className="text-xs text-green-600 font-medium">✓ 已送达</span>}
                  {!r.delivered && hasException && (
                    <span className="text-xs text-orange-600 font-medium">⚠ 有异常</span>
                  )}
                  {!isProcessed && (tripStatus === 'in_progress' || tripStatus === 'verifying') && (
                    <button
                      className="text-xs px-2 py-0.5 rounded border border-orange-300 text-orange-600 bg-orange-50 hover:bg-orange-100 whitespace-nowrap"
                      onClick={e => { e.stopPropagation(); openExceptionModal(r.restaurantId) }}
                    >
                      报告异常
                    </button>
                  )}
                </div>
                {/* 右侧：金额 + 折叠箭头 */}
                <button
                  className="flex items-center gap-3 text-sm text-gray-500 shrink-0 ml-2"
                  onClick={() => setExpandedRest(expandedRest === r.restaurantId ? null : r.restaurantId)}
                >
                  <span>应收 €{r.items.reduce((s, i) => s + i.subtotal, 0).toFixed(2)}</span>
                  {r.payment !== undefined && <span className="font-medium" style={{ color: PURPLE }}>实收 €{r.payment.toFixed(2)}</span>}
                  <span className="text-gray-400">{expandedRest === r.restaurantId ? '▲' : '▼'}</span>
                </button>
              </div>

              {expandedRest === r.restaurantId && (
                <div className="p-4 space-y-4">
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
                      {r.items.map((item, i) => (
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
                        <td colSpan={3} className="pt-2 text-right font-medium text-gray-700">应收合计</td>
                        <td className="pt-2 text-right font-bold" style={{ color: PURPLE }}>
                          €{r.items.reduce((s, i) => s + i.subtotal, 0).toFixed(2)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>

                  {!r.delivered && (tripStatus === 'in_progress' || tripStatus === 'verifying') && (
                    <div className="border-t pt-4">
                      <label className="block text-sm font-medium text-gray-700 mb-1">💰 实收货款（元）</label>
                      <NumericInput
                        step="0.01"
                        placeholder="输入实收金额"
                        defaultValue={r.payment ?? ''}
                        onBlur={e => setPayment(r.restaurantId, parseFloat(e.target.value) || 0)}
                        className="w-48"
                      />
                    </div>
                  )}

                  {r.returns.length > 0 && (
                    <div className="border-t pt-4">
                      <p className="text-sm font-medium text-gray-700 mb-2">📦 退换货记录</p>
                      <div className="space-y-2">
                        {r.returns.map((ret, i) => (
                          <div key={i} className="flex items-center gap-3 text-sm text-gray-600 flex-wrap">
                            <span className="font-medium">{ret.productName}</span>
                            <span className="text-red-500">×{ret.quantity}</span>
                            {ret.actionType && (
                              <span className={`text-xs px-1.5 py-0.5 rounded ${ret.actionType === 'exchange' ? 'bg-blue-50 text-blue-600' : 'bg-red-50 text-red-600'}`}>
                                {ret.actionType === 'exchange' ? '换货' : '退货'}
                              </span>
                            )}
                            {ret.reason && <span className="text-gray-400 text-xs">{ret.reason}</span>}
                            {ret.photo && (
                              <img src={ret.photo} alt="退货图" className="w-10 h-10 rounded object-cover border" />
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {r.pods.length > 0 && (
                    <div className="border-t pt-4">
                      <p className="text-sm font-medium text-gray-700 mb-2">📷 POD 签收照片</p>
                      <div className="flex gap-2 flex-wrap">
                        {r.pods.map((pod, i) => (
                          <img key={i} src={pod} alt={`POD ${i+1}`} className="w-20 h-20 rounded object-cover border" />
                        ))}
                      </div>
                    </div>
                  )}

                  {!r.delivered && (tripStatus === 'in_progress' || tripStatus === 'verifying') && (
                    <div className="border-t pt-4 flex gap-2 flex-wrap">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openExceptionModal(r.restaurantId)}
                      >
                        ⚠ 报告异常
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setPodRestId(r.restaurantId)
                          podInputRef.current?.click()
                        }}
                      >
                        📷 上传 POD
                      </Button>
                      <Button
                        size="sm"
                        className="bg-green-600 hover:bg-green-700 ml-auto"
                        onClick={() => markRestDelivered(r.restaurantId)}
                      >
                        ✓ 完成此站
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <input
        ref={podInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={e => { if (podRestId) handlePodUpload(e, podRestId) }}
      />

      {/* 报告异常 Modal */}
      {exceptionModal && (() => {
        const rest = trip.restaurants.find(r => r.restaurantId === exceptionModal.restId)
        if (!rest) return null
        return (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl p-5 w-full max-w-md space-y-4 max-h-[90vh] overflow-y-auto">
              <h3 className="font-bold text-gray-900">报告异常 — {rest.restaurantName}</h3>

              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">选择有异常的商品（可多选）</p>
                <div className="space-y-2 border rounded-lg divide-y">
                  {exceptionProducts.map((p, i) => (
                    <div key={p.productId} className="flex items-center gap-3 px-3 py-2.5">
                      <input
                        type="checkbox"
                        id={`exc-${i}`}
                        checked={p.selected}
                        onChange={e => {
                          setExceptionProducts(prev => prev.map((x, j) => j === i ? { ...x, selected: e.target.checked } : x))
                        }}
                        className="w-4 h-4 cursor-pointer"
                        style={{ accentColor: PURPLE }}
                      />
                      <label htmlFor={`exc-${i}`} className="flex-1 text-sm cursor-pointer">
                        <span className="font-medium text-gray-800">{p.productName}</span>
                        <span className="text-gray-400 ml-2">已配 {p.quantity}</span>
                      </label>
                      {p.selected && (
                        <NumericInput
                          min={0.001}
                          step="0.001"
                          value={p.quantity}
                          onChange={e => {
                            const qty = Number(e.target.value) || 0
                            setExceptionProducts(prev => prev.map((x, j) => j === i ? { ...x, quantity: qty } : x))
                          }}
                          className="w-20 text-right"
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">异常原因（可多选）</p>
                <div className="flex flex-wrap gap-2 mb-2">
                  {EXCEPTION_REASONS.map(r => {
                    const active = exceptionReasons.includes(r)
                    return (
                      <button
                        key={r}
                        onClick={() => setExceptionReasons(prev =>
                          active ? prev.filter(x => x !== r) : [...prev, r]
                        )}
                        className="px-3 py-1 text-xs rounded-full border transition-colors"
                        style={active
                          ? { background: PURPLE, borderColor: PURPLE, color: 'white' }
                          : { borderColor: '#d1d5db', color: '#6b7280' }}
                      >
                        {r}
                      </button>
                    )
                  })}
                </div>
                <input
                  type="text"
                  placeholder="或输入自定义原因"
                  value={exceptionReasons.filter(r => !EXCEPTION_REASONS.includes(r)).join('')}
                  onChange={e => {
                    const custom = e.target.value
                    setExceptionReasons(prev => {
                      const presets = prev.filter(r => EXCEPTION_REASONS.includes(r))
                      return custom.trim() ? [...presets, custom] : presets
                    })
                  }}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1"
                  style={{ focusRingColor: PURPLE } as React.CSSProperties}
                />
              </div>

              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">处理方式</p>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={exceptionAction === 'return'}
                      onChange={() => setExceptionAction('return')}
                      style={{ accentColor: PURPLE }}
                    />
                    <span className="text-sm text-gray-700">退货</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={exceptionAction === 'exchange'}
                      onChange={() => setExceptionAction('exchange')}
                      style={{ accentColor: PURPLE }}
                    />
                    <span className="text-sm text-gray-700">换货</span>
                  </label>
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <Button variant="outline" className="flex-1" onClick={() => setExceptionModal(null)}>取消</Button>
                <Button
                  className="flex-1 text-white"
                  style={{ background: '#ea580c' }}
                  onClick={submitException}
                >
                  确认报告异常
                </Button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* 旧退货 Modal（保留兼容性）*/}
      {returnModal && (() => {
        const rest = trip.restaurants.find(r => r.restaurantId === returnModal.restId)
        if (!rest) return null
        return (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl p-5 w-full max-w-sm space-y-4">
              <h3 className="font-bold text-gray-900">记录退货 — {rest.restaurantName}</h3>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">选择退货商品</label>
                <select
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  value={returnForm.productId}
                  onChange={e => {
                    const item = rest.items.find(i => i.productId === e.target.value)
                    setReturnForm(f => ({ ...f, productId: e.target.value, productName: item?.productName ?? '' }))
                  }}
                >
                  <option value="">请选择</option>
                  {rest.items.map(item => (
                    <option key={item.productId} value={item.productId}>{item.productName}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">退货数量</label>
                <NumericInput
                  min={0.001}
                  step="0.001"
                  value={returnForm.qty}
                  onChange={e => setReturnForm(f => ({ ...f, qty: Number(e.target.value) || 0 }))}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">退货图片（可选）</label>
                {returnForm.photo ? <img src={returnForm.photo} alt="退货图" className="w-20 h-20 rounded object-cover border mb-2" /> : null}
                <Button variant="outline" size="sm" onClick={() => returnPhotoRef.current?.click()}>
                  📷 拍照 / 上传
                </Button>
                <input ref={returnPhotoRef} type="file" accept="image/*" className="hidden" onChange={handleReturnPhoto} />
              </div>
              <div className="flex gap-2 pt-2">
                <Button variant="outline" className="flex-1" onClick={() => setReturnModal(null)}>取消</Button>
                <Button className="flex-1 bg-red-600 hover:bg-red-700" onClick={() => addReturn(returnModal.restId)}>
                  确认退货
                </Button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
