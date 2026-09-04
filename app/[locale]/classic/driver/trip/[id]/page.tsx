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
import BatchMap, { type MapMarker } from '@/components/shared/BatchMap'
import SignaturePad from '@/components/driver/SignaturePad'

const PURPLE = '#875A7B'

const EXCEPTION_REASONS_ZH = ['品质问题', '数量错误', '客户拒收', '配送延误', '包装破损', '其他']
const EXCEPTION_REASONS_EN = ['Quality issue', 'Wrong quantity', 'Customer refused', 'Delivery delay', 'Damaged packaging', 'Other']

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
  const isEn = locale !== routing.defaultLocale
  const EXCEPTION_REASONS = isEn ? EXCEPTION_REASONS_EN : EXCEPTION_REASONS_ZH
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const [trip, setTrip] = useState<Trip | null>(null)
  const [expandedRest, setExpandedRest] = useState<string | null>(null)

  // 报告异常 modal
  const [exceptionModal, setExceptionModal] = useState<{ restId: string } | null>(null)
  const [exceptionProducts, setExceptionProducts] = useState<ExceptionProduct[]>([])
  const [exceptionReasons, setExceptionReasons] = useState<string[]>([])
  const [exceptionAction, setExceptionAction] = useState<'return' | 'exchange'>('return')

  // 电子签收 modal（Sign on Glass）
  const [signModal, setSignModal] = useState<{ restId: string; restName: string } | null>(null)
  const [signData, setSignData] = useState<string | null>(null)
  const [signerName, setSignerName] = useState('')
  const [signing, setSigning] = useState(false)

  const podInputRef = useRef<HTMLInputElement>(null)
  const [podRestId, setPodRestId] = useState<string | null>(null)

  // 站点坐标（只读，独立于 trip state：绝不随 saveTrip 原样 PUT 回去，
  // 否则 Prisma 会因 Trip.restaurants 里混入未知字段而报错）
  const [coords, setCoords] = useState<Record<string, { lat: number; lng: number }>>({})

  function load() {
    apiGet<Trip>(`/api/trips/${id}`)
      .then(t => setTrip(t))
      .catch(() => setTrip(null))
  }

  useEffect(() => { load() }, [id])

  useEffect(() => {
    if (!trip || trip.restaurants.length === 0) return
    const ids = trip.restaurants.map(r => r.restaurantId).join(',')
    apiGet<Array<{ id: string; latitude: number | null; longitude: number | null }>>(
      `/api/customers/coordinates?ids=${encodeURIComponent(ids)}`
    ).then(list => {
      const map: Record<string, { lat: number; lng: number }> = {}
      for (const c of list) {
        if (c.latitude !== null && c.longitude !== null) map[c.id] = { lat: c.latitude, lng: c.longitude }
      }
      setCoords(map)
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip?.id])

  function buildNavUrl(restId: string, address?: string): string | null {
    const c = coords[restId]
    if (c) return `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}`
    if (address) return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`
    return null
  }

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
    toast.success(isEn ? 'Cargo verification complete' : '货物核查完成')
  }

  async function startDelivery() {
    if (!trip) return
    const updated = cloneTrip()
    updated.status = 'in_progress'
    await saveTrip(updated)
    toast.success(isEn ? 'Departure confirmed, delivery started' : '已确认出发，开始配送')
  }

  /**
   * 实收货款。必须规整到分——现场手滑输入 40.504050 这类值时，parseFloat 会原样落库，
   * 之后一路带进累计实收、司机交账、发票核销，产生分以下的尾数对不平。
   * 负数按 0 处理：收款不可能为负，输错了不如归零让人看出来。
   */
  async function setPayment(restId: string, amount: number) {
    if (!trip) return
    const clean = Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100) / 100) : 0
    const updated = cloneTrip()
    const r = updated.restaurants.find(r => r.restaurantId === restId)
    if (r) r.payment = clean
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
    if (selected.length === 0) { toast.error(isEn ? 'Please select the affected products' : '请勾选有异常的商品'); return }
    const reasonText = exceptionReasons.join(isEn ? ', ' : '、')
    if (!reasonText.trim()) { toast.error(isEn ? 'Please enter a reason' : '请填写异常原因'); return }

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
    toast.success(isEn ? 'Exception recorded and added to returns/exchanges' : '异常已记录，已添加到退换货记录')
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
      toast.success(isEn ? 'POD photo uploaded' : 'POD 图片已上传')
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  /** 打开电子签收面板。签收是送达的唯一入口——合同要求客户电子签名 */
  function openSignModal(restId: string) {
    if (!trip) return
    const r = trip.restaurants.find(r => r.restaurantId === restId)
    if (!r) return
    if (r.payment === undefined) { toast.error(isEn ? 'Please enter the amount collected first' : '请先填写实收货款'); return }
    setSignData(null)
    setSignerName('')
    setSignModal({ restId, restName: r.restaurantName })
  }

  /** 客户签完字才算送达。签名与签名人一并写进该站点，服务端补时间戳 */
  async function confirmDelivery() {
    if (!trip || !signModal) return
    if (!signData) { toast.error(isEn ? 'Please get the customer to sign first' : '请先请客户签名'); return }
    if (!signerName.trim()) { toast.error(isEn ? 'Please enter the recipient name' : '请填写签收人姓名'); return }

    setSigning(true)
    try {
      const updated = cloneTrip()
      const ur = updated.restaurants.find(r => r.restaurantId === signModal.restId)
      if (ur) {
        ur.delivered = true
        ur.signature = signData
        ur.signerName = signerName.trim()
        ur.signedAt = new Date().toISOString()
      }
      updated.totalPayment = updated.restaurants.reduce((s, r) => s + (r.payment ?? 0), 0)
      await saveTrip(updated)
      setExpandedRest(null)
      setSignModal(null)
      toast.success(isEn ? `${signModal.restName} signed for` : `${signModal.restName} 已签收`)
    } finally {
      setSigning(false)
    }
  }

  async function endTrip() {
    if (!trip) return
    const unprocessed = trip.restaurants.filter(r => !r.delivered && r.returns.length === 0)
    if (unprocessed.length > 0) {
      const names = unprocessed.map(r => r.restaurantName).join(isEn ? ', ' : '、')
      toast.error(isEn ? `Please complete these stops first (deliver or report exception): ${names}` : `请先完成以下站点（送达或报告异常）：${names}`)
      return
    }
    const updated = cloneTrip()
    updated.status = 'completed'
    updated.totalPayment = updated.restaurants.reduce((s, r) => s + (r.payment ?? 0), 0)
    await saveTrip(updated)
    toast.success(isEn ? 'Trip ended, orders updated to completed' : '行程已结束，订单已更新为完成')
    router.push(`${prefix}/classic/driver`)
  }

  if (!trip) return <div className="text-center py-16 text-gray-400">{isEn ? 'Trip not found' : '行程不存在'}</div>

  const allVerified = trip.restaurants.every(r => r.cargoVerified)
  const processedCount = trip.restaurants.filter(r => r.delivered || r.returns.length > 0).length
  const allProcessed = processedCount === trip.restaurants.length
  const tripStatus = trip.status.toLowerCase()

  const routeMarkers: MapMarker[] = trip.restaurants
    .map((r, i): MapMarker | null => {
      const c = coords[r.restaurantId]
      if (!c) return null
      return { lat: c.lat, lng: c.lng, label: r.restaurantName, color: PURPLE, markerNumber: i + 1 }
    })
    .filter((m): m is MapMarker => m !== null)
  const missingCoordsCount = trip.restaurants.length - routeMarkers.length

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <button
              onClick={() => router.push(`${prefix}/classic/driver`)}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              {isEn ? '← Back to task list' : '← 返回任务列表'}
            </button>
          </div>
          <h1 className="text-xl font-bold text-gray-900">{isEn ? 'Delivery Execution' : '配送执行'}</h1>
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
            {isEn ? `End Trip (${processedCount}/${trip.restaurants.length})` : `结束行程 (${processedCount}/${trip.restaurants.length})`}
          </Button>
        )}
      </div>

      {/* 路线总览图 */}
      {routeMarkers.length > 0 && (
        <div className="mb-5">
          <BatchMap markers={routeMarkers} height="200px" />
          {missingCoordsCount > 0 && (
            <p className="text-xs text-gray-400 mt-1">
              {isEn ? `${missingCoordsCount} stops have no location set, not shown on map` : `${missingCoordsCount} 个站点未标定位置，暂不显示在地图上`}
            </p>
          )}
        </div>
      )}

      {/* 核货阶段 */}
      {tripStatus === 'pending' && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 mb-5">
          <p className="font-medium text-yellow-800 mb-3">{isEn ? '📦 Cargo Check Before Departure' : '📦 出发前货物核查'}</p>
          <div className="space-y-2 mb-4">
            {trip.restaurants.map(r => (
              <div key={r.restaurantId} className="flex items-center justify-between text-sm">
                <span className="text-gray-700">🏪 {r.restaurantName}</span>
                <div className="flex items-center gap-2">
                  <span className="text-gray-500">{isEn ? `${r.items.length} SKUs` : `${r.items.length} 种商品`}</span>
                  {r.cargoVerified
                    ? <span className="text-green-600 font-medium">{isEn ? '✓ Verified' : '✓ 已核'}</span>
                    : <span className="text-gray-400">{isEn ? 'Pending' : '待核'}</span>
                  }
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={verifyAllCargo} className="flex-1">
              {isEn ? 'Verify All' : '一键核货完成'}
            </Button>
            <Button
              onClick={startDelivery}
              style={{ background: PURPLE, borderColor: PURPLE }}
              className="flex-1 text-white hover:opacity-90"
              disabled={!allVerified}
            >
              {isEn ? 'Confirm Departure 🚛' : '确认出发 🚛'}
            </Button>
          </div>
        </div>
      )}

      {tripStatus === 'verifying' && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 mb-5">
          <p className="font-medium text-yellow-800 mb-2">{isEn ? '✅ Cargo verified, ready to depart' : '✅ 货物核查完成，可以出发'}</p>
          <Button
            onClick={startDelivery}
            style={{ background: PURPLE, borderColor: PURPLE }}
            className="w-full text-white hover:opacity-90"
          >
            {isEn ? 'Confirm Departure 🚛' : '确认出发 🚛'}
          </Button>
        </div>
      )}

      {/* 总收款信息 */}
      {(tripStatus === 'in_progress' || tripStatus === 'completed') && (
        <div className="rounded-xl p-4 mb-5 flex justify-between items-center" style={{ background: '#f3eff5', border: '1px solid #d4c0d4' }}>
          <span className="font-medium" style={{ color: PURPLE }}>{isEn ? '💰 Total Collected' : '💰 累计实收'}</span>
          <span className="text-2xl font-bold" style={{ color: PURPLE }}>€{trip.totalPayment.toFixed(2)}</span>
        </div>
      )}

      {/* 餐馆列表 */}
      <div className="space-y-3">
        {trip.restaurants.map((r, i) => {
          const hasException = r.returns.length > 0
          const isProcessed = r.delivered || hasException
          const borderColor = r.delivered ? 'border-green-300' : hasException ? 'border-orange-300' : 'border-gray-200'
          const headerBg = r.delivered ? 'bg-green-50' : hasException ? 'bg-orange-50' : 'bg-gray-50'
          const navUrl = buildNavUrl(r.restaurantId, r.address)

          return (
            <div key={r.restaurantId} className={`bg-white rounded-xl border overflow-hidden ${borderColor}`}>
              <div className={`px-4 py-3 flex items-center justify-between ${headerBg}`}>
                {/* 左侧：餐馆名 + 状态 + 报告异常按钮 */}
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  <span
                    className="shrink-0 w-5 h-5 rounded-full text-white text-[10px] font-bold flex items-center justify-center"
                    style={{ background: PURPLE }}
                  >
                    {i + 1}
                  </span>
                  <button
                    className="font-medium text-gray-900 text-left"
                    onClick={() => setExpandedRest(expandedRest === r.restaurantId ? null : r.restaurantId)}
                  >
                    🏪 {r.restaurantName}
                  </button>
                  {r.delivered && <span className="text-xs text-green-600 font-medium">{isEn ? '✓ Delivered' : '✓ 已送达'}</span>}
                  {!r.delivered && hasException && (
                    <span className="text-xs text-orange-600 font-medium">{isEn ? '⚠ Exception' : '⚠ 有异常'}</span>
                  )}
                  {navUrl && (
                    <button
                      className="text-xs px-2 py-0.5 rounded border border-blue-300 text-blue-600 bg-blue-50 hover:bg-blue-100 whitespace-nowrap"
                      onClick={e => { e.stopPropagation(); window.open(navUrl, '_blank') }}
                    >
                      {isEn ? '🧭 Navigate' : '🧭 导航'}
                    </button>
                  )}
                  {!isProcessed && (tripStatus === 'in_progress' || tripStatus === 'verifying') && (
                    <button
                      className="text-xs px-2 py-0.5 rounded border border-orange-300 text-orange-600 bg-orange-50 hover:bg-orange-100 whitespace-nowrap"
                      onClick={e => { e.stopPropagation(); openExceptionModal(r.restaurantId) }}
                    >
                      {isEn ? 'Report Exception' : '报告异常'}
                    </button>
                  )}
                </div>
                {/* 右侧：金额 + 折叠箭头 */}
                <button
                  className="flex items-center gap-3 text-sm text-gray-500 shrink-0 ml-2"
                  onClick={() => setExpandedRest(expandedRest === r.restaurantId ? null : r.restaurantId)}
                >
                  <span>{isEn ? 'Due' : '应收'} €{r.items.reduce((s, i) => s + i.subtotal, 0).toFixed(2)}</span>
                  {r.payment !== undefined && <span className="font-medium" style={{ color: PURPLE }}>{isEn ? 'Collected' : '实收'} €{r.payment.toFixed(2)}</span>}
                  <span className="text-gray-400">{expandedRest === r.restaurantId ? '▲' : '▼'}</span>
                </button>
              </div>

              {expandedRest === r.restaurantId && (
                <div className="p-4 space-y-4">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-500">
                        <th className="pb-2 font-medium">{isEn ? 'Product' : '商品'}</th>
                        <th className="pb-2 font-medium">{isEn ? 'Spec' : '规格'}</th>
                        <th className="pb-2 text-right font-medium">{isEn ? 'Qty' : '数量'}</th>
                        <th className="pb-2 text-right font-medium">{isEn ? 'Subtotal' : '小计'}</th>
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
                        <td colSpan={3} className="pt-2 text-right font-medium text-gray-700">{isEn ? 'Total Due' : '应收合计'}</td>
                        <td className="pt-2 text-right font-bold" style={{ color: PURPLE }}>
                          €{r.items.reduce((s, i) => s + i.subtotal, 0).toFixed(2)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>

                  {!r.delivered && (tripStatus === 'in_progress' || tripStatus === 'verifying') && (
                    <div className="border-t pt-4">
                      <label className="block text-sm font-medium text-gray-700 mb-1">{isEn ? '💰 Amount Collected (€)' : '💰 实收货款（元）'}</label>
                      <NumericInput
                        step="0.01"
                        placeholder={isEn ? 'Enter amount collected' : '输入实收金额'}
                        defaultValue={r.payment ?? ''}
                        onBlur={e => setPayment(r.restaurantId, parseFloat(e.target.value) || 0)}
                        className="w-48"
                      />
                    </div>
                  )}

                  {r.returns.length > 0 && (
                    <div className="border-t pt-4">
                      <p className="text-sm font-medium text-gray-700 mb-2">{isEn ? '📦 Returns/Exchanges' : '📦 退换货记录'}</p>
                      <div className="space-y-2">
                        {r.returns.map((ret, i) => (
                          <div key={i} className="flex items-center gap-3 text-sm text-gray-600 flex-wrap">
                            <span className="font-medium">{ret.productName}</span>
                            <span className="text-red-500">×{ret.quantity}</span>
                            {ret.actionType && (
                              <span className={`text-xs px-1.5 py-0.5 rounded ${ret.actionType === 'exchange' ? 'bg-blue-50 text-blue-600' : 'bg-red-50 text-red-600'}`}>
                                {ret.actionType === 'exchange' ? (isEn ? 'Exchange' : '换货') : (isEn ? 'Return' : '退货')}
                              </span>
                            )}
                            {ret.reason && <span className="text-gray-400 text-xs">{ret.reason}</span>}
                            {ret.photo && (
                              <img src={ret.photo} alt={isEn ? 'Return photo' : '退货图'} className="w-10 h-10 rounded object-cover border" />
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {r.signature && (
                    <div className="border-t pt-4">
                      <p className="text-sm font-medium text-gray-700 mb-2">{isEn ? '✍️ Customer Signature' : '✍️ 客户签收'}</p>
                      <div className="inline-block rounded border bg-white p-2">
                        <img src={r.signature} alt={isEn ? 'Customer signature' : '客户签名'} className="h-20 object-contain" />
                      </div>
                      <p className="text-xs text-gray-500 mt-1">
                        {isEn ? 'Signed by' : '签收人'}：{r.signerName ?? '—'}
                        {r.signedAt && ` · ${new Date(r.signedAt).toLocaleString(isEn ? 'en-GB' : 'zh-CN')}`}
                      </p>
                    </div>
                  )}

                  {r.pods.length > 0 && (
                    <div className="border-t pt-4">
                      <p className="text-sm font-medium text-gray-700 mb-2">{isEn ? '📷 POD Photos' : '📷 POD 签收照片'}</p>
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
                        {isEn ? '⚠ Report Exception' : '⚠ 报告异常'}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setPodRestId(r.restaurantId)
                          podInputRef.current?.click()
                        }}
                      >
                        {isEn ? '📷 Upload POD' : '📷 上传 POD'}
                      </Button>
                      <Button
                        size="sm"
                        className="bg-green-600 hover:bg-green-700 ml-auto"
                        onClick={() => openSignModal(r.restaurantId)}
                      >
                        {isEn ? '✍️ Customer Sign-off' : '✍️ 客户签收'}
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
      {/* Sign on Glass —— 客户手写签收。合同第四条把「司机电子签收」写进验收闭环 */}
      {signModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl p-5 w-full max-w-md space-y-4 max-h-[90vh] overflow-y-auto">
            <div>
              <h3 className="font-bold text-gray-900">{isEn ? `Customer Sign-off — ${signModal.restName}` : `客户签收 — ${signModal.restName}`}</h3>
              <p className="text-xs text-gray-500 mt-0.5">{isEn ? 'Hand the phone to the customer to sign below and confirm receipt' : '请把手机递给客户，由客户本人在下方签名确认收货'}</p>
            </div>

            <SignaturePad onChange={setSignData} disabled={signing} />

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{isEn ? 'Recipient Name' : '签收人姓名'}</label>
              <input
                className="w-full border rounded px-3 py-2 text-sm"
                placeholder={isEn ? "Customer's name, or driver fills in" : '请客户写下或司机代填姓名'}
                value={signerName}
                onChange={e => setSignerName(e.target.value)}
                disabled={signing}
                maxLength={40}
              />
              <p className="text-xs text-gray-400 mt-1">{isEn ? "The signature image alone can't identify the signer, so the name is recorded separately for accountability" : '签名图像认不出是谁签的，姓名要单独记，日后追责才有依据'}</p>
            </div>

            <div className="flex gap-2 justify-end pt-1">
              <Button variant="outline" size="sm" onClick={() => setSignModal(null)} disabled={signing}>
                {isEn ? 'Cancel' : '取消'}
              </Button>
              <Button
                size="sm"
                className="bg-green-600 hover:bg-green-700"
                onClick={confirmDelivery}
                disabled={signing || !signData || !signerName.trim()}
              >
                {signing ? (isEn ? 'Submitting…' : '提交中…') : (isEn ? '✓ Confirm' : '✓ 确认签收')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {exceptionModal && (() => {
        const rest = trip.restaurants.find(r => r.restaurantId === exceptionModal.restId)
        if (!rest) return null
        return (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl p-5 w-full max-w-md space-y-4 max-h-[90vh] overflow-y-auto">
              <h3 className="font-bold text-gray-900">{isEn ? `Report Exception — ${rest.restaurantName}` : `报告异常 — ${rest.restaurantName}`}</h3>

              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">{isEn ? 'Select affected products (multiple allowed)' : '选择有异常的商品（可多选）'}</p>
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
                        <span className="text-gray-400 ml-2">{isEn ? `Allocated ${p.quantity}` : `已配 ${p.quantity}`}</span>
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
                <p className="text-sm font-medium text-gray-700 mb-2">{isEn ? 'Reason (multiple allowed)' : '异常原因（可多选）'}</p>
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
                  placeholder={isEn ? 'Or enter a custom reason' : '或输入自定义原因'}
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
                <p className="text-sm font-medium text-gray-700 mb-2">{isEn ? 'Action' : '处理方式'}</p>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={exceptionAction === 'return'}
                      onChange={() => setExceptionAction('return')}
                      style={{ accentColor: PURPLE }}
                    />
                    <span className="text-sm text-gray-700">{isEn ? 'Return' : '退货'}</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={exceptionAction === 'exchange'}
                      onChange={() => setExceptionAction('exchange')}
                      style={{ accentColor: PURPLE }}
                    />
                    <span className="text-sm text-gray-700">{isEn ? 'Exchange' : '换货'}</span>
                  </label>
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <Button variant="outline" className="flex-1" onClick={() => setExceptionModal(null)}>{isEn ? 'Cancel' : '取消'}</Button>
                <Button
                  className="flex-1 text-white"
                  style={{ background: '#ea580c' }}
                  onClick={submitException}
                >
                  {isEn ? 'Confirm Exception' : '确认报告异常'}
                </Button>
              </div>
            </div>
          </div>
        )
      })()}

    </div>
  )
}
