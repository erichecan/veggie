'use client'
import { useState, useEffect, use, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import { useRefetchOnFocus } from '@/lib/hooks/use-refetch-on-focus'
import type { Trip, ReturnItem } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { NumericInput } from '@/components/ui/numeric-input'
import { TripStatusBadge } from '@/components/shared/status-badge'
import BatchMap, { type MapMarker } from '@/components/shared/BatchMap'
import SignaturePad from '@/components/driver/SignaturePad'
import { orderIncTaxTotal } from '@/lib/order-items'
import { calculateReturnAdjustment } from '@/lib/trip-collection'
import { formatDateTime } from '@/lib/format-date'

const PURPLE = '#875A7B'

const EXCEPTION_REASONS_ZH = ['品质问题', '数量错误', '客户拒收', '配送延误', '包装破损', '其他']
const EXCEPTION_REASONS_EN = ['Quality issue', 'Wrong quantity', 'Customer refused', 'Delivery delay', 'Damaged packaging', 'Other']

interface ExceptionProduct {
  productId: string
  productName: string
  quantity: number
  allocatedQuantity: number
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
  const [orderTimingBusy, setOrderTimingBusy] = useState<string | null>(null)
  const [paymentSavingRestId, setPaymentSavingRestId] = useState<string | null>(null)
  const [startingDelivery, setStartingDelivery] = useState(false)
  const [showEndTripConfirm, setShowEndTripConfirm] = useState(false)
  const [endingTrip, setEndingTrip] = useState(false)

  // 报告异常 modal
  const [exceptionModal, setExceptionModal] = useState<{ restId: string } | null>(null)
  const [exceptionProducts, setExceptionProducts] = useState<ExceptionProduct[]>([])
  const [exceptionReasons, setExceptionReasons] = useState<string[]>([])
  const [exceptionAction, setExceptionAction] = useState<'return' | 'exchange'>('return')
  /** 现场照片（20260922）：证明退换货商品的实际状态 */
  const [exceptionPhoto, setExceptionPhoto] = useState<string | null>(null)
  /** 补报备注（20261028，退换货补全 M3）：补报几天前的退换货时，说明"为什么现在才报"，
   * 跟 reasonText（退换货本身的原因）彻底分开，不混在一起 */
  const [exceptionLateNote, setExceptionLateNote] = useState('')
  const [submittingException, setSubmittingException] = useState(false)
  const exceptionPhotoInputRef = useRef<HTMLInputElement>(null)

  // 电子签收 modal（Sign on Glass）
  const [signModal, setSignModal] = useState<{ restId: string; restName: string } | null>(null)
  const [signData, setSignData] = useState<string | null>(null)
  const [signerName, setSignerName] = useState('')
  const [signing, setSigning] = useState(false)

  const podInputRef = useRef<HTMLInputElement>(null)
  const [podRestId, setPodRestId] = useState<string | null>(null)
  const [uploadingPodRestId, setUploadingPodRestId] = useState<string | null>(null)

  // 站点坐标（只读，独立于 trip state：绝不随 saveTrip 原样 PUT 回去，
  // 否则 Prisma 会因 Trip.restaurants 里混入未知字段而报错）
  const [coords, setCoords] = useState<Record<string, { lat: number; lng: number }>>({})

  async function load() {
    try {
      const t = await apiGet<Trip>(`/api/trips/${id}`)
      const normalized = {
        ...t,
        restaurants: (t.restaurants ?? []).map(r => ({ ...r, pods: Array.isArray(r.pods) ? r.pods : [] })),
      }
      setTrip(normalized)
      return normalized
    } catch {
      setTrip(null)
      return null
    }
  }

  useEffect(() => { load() }, [id])

  // 行程在别的 tab 改了之后，切回这个已打开的页面希望看到最新结果；
  // 不接 M2——异常上报/签收都是弹窗打开即填即提交，load() 只换 trip，
  // 不碰 exceptionModal/signModal 等弹窗 state，不会被背景刷新冲掉
  useRefetchOnFocus([load])

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

  // 唯一落库出口：verifyAllCargo/startDelivery/setPayment/endTrip/confirmDelivery/
  // handlePodUpload 全部经过这里却都没包 try/catch，PUT 失败（蜂窝网络差/后端 409）时
  // 异常直接从 onClick 里飞出去，司机看到的是点了按钮毫无反应——跟没点一样，还可能
  // 误以为已经送达/收款成功。统一在这里兜底报错，调用方原有的"成功后才执行"的代码
  // （toast.success/router.push/关弹窗）天然不会跑，不用逐个改调用方。
  async function saveTrip(updated: Trip) {
    let saved: Trip | undefined
    try {
      saved = await apiPut<Trip>(`/api/trips/${updated.id}`, updated)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed, please try again' : '保存失败，请重试'))
      throw e
    }
    if (saved) {
      const localOrderCodes = new Map(updated.restaurants.map(r => [r.restaurantId, r.orderCodes]))
      setTrip({
        ...saved,
        restaurants: saved.restaurants.map(r => ({ ...r, orderCodes: localOrderCodes.get(r.restaurantId) })),
      })
    } else {
      setTrip(updated)
    }
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
    if (!trip || startingDelivery) return
    setStartingDelivery(true)
    try {
      const updated = cloneTrip()
      updated.status = 'in_progress'
      await saveTrip(updated)
      toast.success(isEn ? 'Departure confirmed, delivery started' : '已确认出发，开始配送')
    } catch {
      // saveTrip displays the server conflict, including the currently active trip name.
    } finally {
      setStartingDelivery(false)
    }
  }

  async function changeOrderTiming(orderId: string, action: 'start' | 'end') {
    if (!trip || orderTimingBusy) return
    setOrderTimingBusy(orderId)
    try {
      const updated = await apiPost<Trip>(`/api/trips/${trip.id}/order-timing`, { orderId, action })
      setTrip(updated)
      toast.success(action === 'start'
        ? (isEn ? 'Order timer started' : '订单已开始计时')
        : (isEn ? 'Order timer ended' : '订单已结束计时'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Could not update order timer' : '订单计时更新失败'))
      load()
    } finally {
      setOrderTimingBusy(null)
    }
  }

  /**
   * 实收金额允许为 0 或客户实际支付的任意金额，保存到分。
   */
  async function setPayment(restId: string, amount: number) {
    if (!trip) return
    const currentRestaurant = trip.restaurants.find(r => r.restaurantId === restId)
    const paymentLocked = !!currentRestaurant && (
      currentRestaurant.delivered
      || (currentRestaurant.orderIds ?? []).some(orderId => !!orderTimingById[orderId]?.endedAt)
    )
    if (paymentLocked) {
      toast.error(isEn ? 'Collected amount cannot be changed after the order is completed' : '订单完成后，实收金额不可修改')
      return
    }
    if (!Number.isFinite(amount) || amount < 0) {
      toast.error(isEn ? 'Enter an amount collected of €0 or more' : '请输入大于或等于 €0 的实收金额')
      return
    }
    const clean = Math.round(amount * 100) / 100
    const updated = cloneTrip()
    const r = updated.restaurants.find(r => r.restaurantId === restId)
    if (r) r.payment = clean
    setPaymentSavingRestId(restId)
    try {
      await saveTrip(updated)
    } catch {
      // saveTrip already reports the error; keep sign-off and order end disabled until retry.
    } finally {
      setPaymentSavingRestId(null)
    }
  }

  function openExceptionModal(restId: string) {
    if (!trip) return
    const rest = trip.restaurants.find(r => r.restaurantId === restId)
    if (!rest) return
    setExceptionProducts(rest.items.map(item => ({
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity,
      allocatedQuantity: item.quantity,
      selected: false,
    })))
    setExceptionReasons([])
    setExceptionAction('return')
    setExceptionPhoto(null)
    setExceptionLateNote('')
    setExceptionModal({ restId })
  }

  function handleExceptionPhotoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setExceptionPhoto(reader.result as string)
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  /**
   * 提交走专用接口 `POST /api/trips/:id/returns`（20260922 改），不再本地拼
   * `Trip.restaurants[].returns` 再整份 `PUT` ——那条野路子没有写 `unitPrice`
   * 快照，导致审核时按比例退款算成 0（除非审核人手动切到"固定金额"手输）。
   * 专用接口会自动从订单行取单价快照，并把初始状态落成 `WAREHOUSE_PENDING`
   * （先过仓库核实，再进销售审核队列）。
   */
  async function submitException() {
    if (!trip || !exceptionModal) return
    const selected = exceptionProducts.filter(p => p.selected)
    if (selected.length === 0) { toast.error(isEn ? 'Please select the affected products' : '请勾选有异常的商品'); return }
    const invalidQuantity = selected.find(p => !Number.isFinite(p.quantity) || p.quantity <= 0 || p.quantity > p.allocatedQuantity)
    if (invalidQuantity) {
      toast.error(isEn
        ? `Enter a quantity greater than 0 and no more than ${invalidQuantity.allocatedQuantity} for ${invalidQuantity.productName}`
        : `${invalidQuantity.productName} 的数量必须大于 0，且不能超过已分配数量 ${invalidQuantity.allocatedQuantity}`)
      return
    }
    const reasonText = exceptionReasons.join(isEn ? ', ' : '、')
    if (!reasonText.trim()) { toast.error(isEn ? 'Please enter a reason' : '请填写异常原因'); return }
    if (!exceptionPhoto) { toast.error(isEn ? 'Please take a photo as evidence' : '请拍照留存现场证据'); return }
    const isLateReport = tripStatus === 'completed'
    if (isLateReport && !exceptionLateNote.trim()) {
      toast.error(isEn ? 'Please explain why this is being reported late' : '请填写为什么现在才补报'); return
    }

    setSubmittingException(true)
    let returnRecorded = false
    try {
      await apiPost<{ returns: ReturnItem[] }>(`/api/trips/${trip.id}/returns`, {
        restaurantId: exceptionModal.restId,
        returns: selected.map(p => ({
          productId: p.productId,
          productName: p.productName,
          quantity: p.quantity,
          reason: reasonText,
          actionType: exceptionAction,
          photo: exceptionPhoto ?? undefined,
          lateReportNote: isLateReport ? exceptionLateNote.trim() : undefined,
        })),
      })
      returnRecorded = true
      // Re-read after the dedicated return endpoint writes the return records. If a
      // previous amount was already saved, replace it with the new recommended amount.
      const latestTrip = await apiGet<Trip>(`/api/trips/${trip.id}`)
      const updatedTrip = JSON.parse(JSON.stringify(latestTrip)) as Trip
      const restaurant = updatedTrip.restaurants.find(r => r.restaurantId === exceptionModal.restId)
      if (restaurant) {
        const returnAdjustment = calculateReturnAdjustment(restaurant.items, restaurant.returns ?? [])
        const grossDue = orderIncTaxTotal(restaurant.items)
        restaurant.payment = Math.max(0, Math.round((grossDue - returnAdjustment.incTax) * 100) / 100)
      }
      updatedTrip.totalPayment = updatedTrip.restaurants.reduce((sum, r) => sum + (r.payment ?? 0), 0)
      await apiPut(`/api/trips/${updatedTrip.id}`, updatedTrip)
      setTrip(updatedTrip)
      setExceptionModal(null)
      toast.success(isEn
        ? 'Exception recorded — collection amount recalculated'
        : '异常已记录，实收金额已按退货重新计算')
    } catch (e) {
      if (returnRecorded) {
        await load()
        toast.error(isEn
          ? 'Return was recorded, but the collection amount could not be refreshed. Please check the amount before sign-off.'
          : '退货已记录，但实收金额未能刷新；请签收前核对金额。')
      } else {
        toast.error(e instanceof Error ? e.message : (isEn ? 'Submit failed' : '提交失败'))
      }
    } finally {
      setSubmittingException(false)
    }
  }

  async function compressPodPhoto(file: File): Promise<string> {
    const objectUrl = URL.createObjectURL(file)
    try {
      const image = new Image()
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error(isEn ? 'Could not read this image' : '无法读取这张图片'))
        image.src = objectUrl
      })

      const maxEdge = 1800
      const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error(isEn ? 'Image processing is unavailable' : '当前浏览器无法处理图片')
      context.drawImage(image, 0, 0, canvas.width, canvas.height)

      // iPhone 原图可能很大。压缩为 JPEG，避免把数 MB 的原图塞进整条行程 JSON。
      let quality = 0.78
      let blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
      while (blob && blob.size > 900 * 1024 && quality > 0.48) {
        quality -= 0.1
        blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
      }
      if (!blob) throw new Error(isEn ? 'Could not prepare this image' : '图片处理失败')
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Image conversion failed'))
        reader.onerror = () => reject(new Error(isEn ? 'Could not read this image' : '无法读取这张图片'))
        reader.readAsDataURL(blob)
      })
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }

  async function handlePodUpload(e: React.ChangeEvent<HTMLInputElement>, restId: string) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error(isEn ? 'Please select an image' : '请选择图片文件')
      e.target.value = ''
      return
    }
    setUploadingPodRestId(restId)
    let saveStarted = false
    try {
      const photo = await compressPodPhoto(file)
      const updated = cloneTrip()
      const r = updated.restaurants.find(r => r.restaurantId === restId)
      if (!r) throw new Error(isEn ? 'Customer stop was not found' : '找不到对应的配送客户')
      r.pods = Array.isArray(r.pods) ? r.pods : []
      r.pods.push(photo)
      saveStarted = true
      await saveTrip(updated)
      toast.success(isEn ? 'POD photo uploaded' : 'POD 图片已上传')
    } catch (error) {
      // saveTrip 已经会显示 API 错误；图片处理阶段的异常在这里提示。
      if (!saveStarted) toast.error(error instanceof Error ? error.message : (isEn ? 'POD upload failed. Please try again.' : 'POD 上传失败，请重试'))
    } finally {
      setUploadingPodRestId(null)
      e.target.value = ''
    }
  }

  /** 打开电子签收面板。签收是送达的唯一入口——合同要求客户电子签名 */
  function openSignModal(restId: string) {
    if (!trip) return
    const r = trip.restaurants.find(r => r.restaurantId === restId)
    if (!r) return
    if (typeof r.payment !== 'number' || !Number.isFinite(r.payment) || r.payment < 0) {
      toast.error(isEn
        ? 'Enter and save the amount collected (0 is allowed) first'
        : '请先输入并保存实收金额（可以填写 0）')
      return
    }
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
      setSignModal(null)
      toast.success(isEn ? `${signModal.restName} signed for` : `${signModal.restName} 已签收`)
    } finally {
      setSigning(false)
    }
  }

  function requestEndTrip() {
    if (!trip) return
    const unprocessed = trip.restaurants.filter(r => !r.delivered && r.returns.length === 0)
    if (unprocessed.length > 0) {
      const names = unprocessed.map(r => r.restaurantName).join(isEn ? ', ' : '、')
      toast.error(isEn ? `Please complete these stops first (deliver or report exception): ${names}` : `请先完成以下站点（送达或报告异常）：${names}`)
      return
    }
    setShowEndTripConfirm(true)
  }

  async function endTrip() {
    if (!trip || endingTrip) return
    setEndingTrip(true)
    try {
      const updated = cloneTrip()
      updated.status = 'completed'
      updated.totalPayment = updated.restaurants.reduce((s, r) => s + (r.payment ?? 0), 0)
      await saveTrip(updated)
      toast.success(isEn ? 'Trip ended, orders updated to completed' : '行程已结束，订单已更新为完成')
      setShowEndTripConfirm(false)
      router.push(`${prefix}/classic/driver`)
    } catch {
      // saveTrip already displays the server error.
    } finally {
      setEndingTrip(false)
    }
  }

  if (!trip) return <div className="text-center py-16 text-gray-400">{isEn ? 'Trip not found' : '行程不存在'}</div>

  const allVerified = trip.restaurants.every(r => r.cargoVerified)
  const processedCount = trip.restaurants.filter(r => r.delivered || r.returns.length > 0).length
  const allProcessed = processedCount === trip.restaurants.length
  const tripStatus = trip.status.toLowerCase()
  const orderTimingById: Record<string, { startedAt?: string; endedAt?: string }> = Object.assign({}, ...trip.restaurants.map(r => r.orderTimings ?? {}))
  const activeOrderId = Object.entries(orderTimingById).find(([, timing]) => timing.startedAt && !timing.endedAt)?.[0] ?? null
  const allOrderTimersEnded = trip.restaurants
    .flatMap(r => r.orderIds ?? [])
    .every(orderId => !!orderTimingById[orderId]?.endedAt)

  const routeMarkers: MapMarker[] = trip.restaurants
    .map((r, i): MapMarker | null => {
      const c = coords[r.restaurantId]
      if (!c) return null
      return { lat: c.lat, lng: c.lng, label: r.restaurantName, color: PURPLE, markerNumber: i + 1 }
    })
    .filter((m): m is MapMarker => m !== null)
  const missingCoordsCount = trip.restaurants.length - routeMarkers.length

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-0 pb-8 pt-2 sm:px-2 sm:pt-3">
      <div className="mb-4 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <button
              onClick={() => router.push(`${prefix}/classic/driver`)}
              className="min-h-11 rounded-lg px-2 text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            >
              {isEn ? '← Back to task list' : '← 返回任务列表'}
            </button>
          </div>
          <h1 className="text-xl font-bold text-gray-900">{isEn ? 'Delivery Execution' : '配送执行'}</h1>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 break-words text-sm font-medium leading-snug text-gray-600">{trip.name || `Trip · ${trip.id.slice(-6).toUpperCase()}`}</span>
            <span className="shrink-0 font-mono text-[10px] text-gray-400" title={trip.id}>{trip.id.slice(0, 8)}…</span>
            <TripStatusBadge status={trip.status} />
          </div>
        </div>
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
              <div key={r.restaurantId} className="flex flex-wrap items-start justify-between gap-2 text-sm">
                <span className="min-w-0 flex-1 break-words leading-snug text-gray-700">🏪 {r.restaurantName}{r.orderCodes?.length ? <span className="ml-2 break-words text-xs text-purple-700">{isEn ? 'SO' : 'SO单号'}: {r.orderCodes.join(', ')}</span> : null}</span>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-xs text-gray-600 sm:text-sm">{isEn ? `${r.items.length} SKUs` : `${r.items.length} 种商品`}</span>
                  {r.cargoVerified
                    ? <span className="text-green-600 font-medium">{isEn ? '✓ Verified' : '✓ 已核'}</span>
                    : <span className="text-gray-400">{isEn ? 'Pending' : '待核'}</span>
                  }
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button variant="outline" onClick={verifyAllCargo} className="min-h-14 w-full text-base font-semibold sm:flex-1">
              {isEn ? 'Verify All' : '一键核货完成'}
            </Button>
            <Button
              onClick={startDelivery}
              style={{ background: PURPLE, borderColor: PURPLE }}
              className="min-h-14 w-full text-base font-bold text-white hover:opacity-90 sm:flex-1"
              disabled={!allVerified || startingDelivery}
            >
              {startingDelivery ? (isEn ? 'Checking active trips…' : '正在检查进行中的行程…') : (isEn ? 'Confirm Departure 🚛' : '确认出发 🚛')}
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
            className="min-h-14 w-full text-base font-bold text-white hover:opacity-90 disabled:opacity-60"
            disabled={startingDelivery}
          >
            {startingDelivery ? (isEn ? 'Checking active trips…' : '正在检查进行中的行程…') : (isEn ? 'Confirm Departure 🚛' : '确认出发 🚛')}
          </Button>
        </div>
      )}

      {/* 总收款信息 */}
      {(tripStatus === 'in_progress' || tripStatus === 'completed') && (
        <div className="rounded-xl p-4 mb-5 flex justify-between items-center" style={{ background: '#f3eff5', border: '1px solid #d4c0d4' }}>
          <span className="min-w-0 break-words font-medium" style={{ color: PURPLE }}>{isEn ? '💰 Total Collected' : '💰 累计实收'}</span>
          {/* 直接按各站已填实收求和，而不是读 trip.totalPayment：后者建行程时预填的是**税前**计划金额
              （lib/trip-from-wave.ts），司机还没收任何钱时这里就显示一个不含税的数，标签却是「累计实收」。
              各站填完实收后两者本来就相等（markDelivered / complete 时同样按 payment 求和回写） */}
          <span className="shrink-0 text-xl font-bold sm:text-2xl" style={{ color: PURPLE }}>€{trip.restaurants.reduce((s, r) => s + (r.payment ?? 0), 0).toFixed(2)}</span>
        </div>
      )}

      {/* 餐馆列表 */}
      <div className="space-y-3">
        {trip.restaurants.map((r, i) => {
          const hasException = r.returns.length > 0
          // 应收必须是**含税**金额：item.subtotal 是税前（SSOT），之前直接求和当「应收」，
          // 司机照着少收了税（20261028 客户反馈：司机端 €29.37、客户门户 €30.95）。
          // 与会计核销司机现金（lib/accounting/driver-cash.ts）、销售单打印同一个 orderIncTaxTotal
          const grossDueExTax = Math.round(r.items.reduce((s, i) => s + i.subtotal, 0) * 100) / 100
          const grossDueIncTax = orderIncTaxTotal(r.items)
          const returnAdjustment = calculateReturnAdjustment(r.items, r.returns ?? [])
          const dueExTax = Math.max(0, Math.round((grossDueExTax - returnAdjustment.exTax) * 100) / 100)
          const dueIncTax = Math.max(0, Math.round((grossDueIncTax - returnAdjustment.incTax) * 100) / 100)
          const dueTax = Math.max(0, Math.round((dueIncTax - dueExTax) * 100) / 100)
          const hasValidPayment = typeof r.payment === 'number' && Number.isFinite(r.payment) && r.payment >= 0
          const isProcessed = r.delivered || hasException
          const orderIds = r.orderIds ?? []
          const allRestOrderTimersEnded = orderIds.length > 0 && orderIds.every(orderId => !!orderTimingById[orderId]?.endedAt)
          const hasEndedOrderAtRest = orderIds.some(orderId => !!orderTimingById[orderId]?.endedAt)
          const paymentLocked = r.delivered || hasEndedOrderAtRest
          const activeOrderAtRest = !!activeOrderId && orderIds.includes(activeOrderId)
          const canOperateRest = tripStatus === 'in_progress' && !isProcessed && (activeOrderAtRest || allRestOrderTimersEnded)
          const canContinueStopActions = tripStatus === 'in_progress'
            && (activeOrderAtRest || hasEndedOrderAtRest || allRestOrderTimersEnded || r.delivered)
          const canEditPayment = canContinueStopActions
          const canReportException = canContinueStopActions && !hasException
          const canUploadPod = canContinueStopActions
          const canSignOff = canEditPayment && !r.delivered && hasValidPayment && paymentSavingRestId !== r.restaurantId
          const navigationOrderId = (activeOrderAtRest ? activeOrderId : null)
            ?? orderIds.find(orderId => !orderTimingById[orderId]?.endedAt)
            ?? orderIds[0]
          const borderColor = r.delivered ? 'border-green-300' : hasException ? 'border-orange-300' : 'border-gray-200'
          const headerBg = r.delivered ? 'bg-green-50' : hasException ? 'bg-orange-50' : 'bg-gray-50'
          const navUrl = buildNavUrl(r.restaurantId, r.address)

          return (
            <div key={r.restaurantId} className={`bg-white rounded-xl border overflow-hidden ${borderColor}`}>
              <div className={`px-3 py-3 sm:px-4 ${headerBg}`}>
                <div className="flex min-w-0 items-start gap-2">
                  <span
                    className="shrink-0 w-5 h-5 rounded-full text-white text-[10px] font-bold flex items-center justify-center"
                    style={{ background: PURPLE }}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="min-w-0 break-words font-semibold leading-snug text-gray-900">🏪 {r.restaurantName}</span>
                      {r.delivered && <span className="text-xs font-medium text-green-700">{isEn ? '✓ Delivered' : '✓ 已送达'}</span>}
                      {!r.delivered && hasException && <span className="text-xs font-medium text-orange-700">{isEn ? '⚠ Exception' : '⚠ 有异常'}</span>}
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-4 p-3 sm:p-4">
                  {orderIds.length === 0 && (
                    <div className="grid grid-cols-1 items-stretch gap-2">
                      {navUrl ? (
                        <button
                          type="button"
                          className="min-h-14 rounded-xl border border-blue-700 bg-blue-700 px-3 text-base font-bold leading-tight text-white shadow-sm hover:bg-blue-800"
                          onClick={() => window.open(navUrl, '_blank')}
                        >{isEn ? '🧭 Navigate' : '🧭 导航'}</button>
                      ) : (
                        <button type="button" disabled className="min-h-14 rounded-xl border border-gray-200 bg-gray-100 px-3 text-base font-semibold text-gray-400">
                          {isEn ? 'No location' : '无导航地址'}
                        </button>
                      )}
                    </div>
                  )}

                  {orderIds.length > 0 && (
                    <div className="space-y-2" aria-label={isEn ? 'Order timers' : '订单计时'}>
                      {orderIds.map((orderId, orderIndex) => {
                        const timing = r.orderTimings?.[orderId] ?? {}
                        const isCurrent = activeOrderId === orderId
                        const canStart = tripStatus === 'in_progress' && !activeOrderId && !timing.startedAt && !timing.endedAt
                        const canEnd = tripStatus === 'in_progress'
                          && isCurrent
                          && !!r.delivered
                          && !!r.signature
                          && !!r.signerName?.trim()
                          && !!r.signedAt
                          && hasValidPayment
                          && paymentSavingRestId !== r.restaurantId
                        const orderLabel = r.orderCodes?.[orderIndex] ?? orderId.slice(-8).toUpperCase()
                        const buttonLabel = isCurrent
                          ? (isEn ? 'End Order' : '结束订单')
                          : timing.endedAt
                            ? (isEn ? 'Completed' : '已结束')
                            : (isEn ? 'Start Order' : '开始订单')
                        return (
                          <div key={orderId} className="grid grid-cols-1 items-center gap-2 rounded-xl border border-gray-200 bg-white p-3">
                            <div className="min-w-0">
                            <p className="break-words text-sm font-semibold leading-snug text-gray-800">{isEn ? 'Order' : '订单'} · {orderLabel}</p>
                              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
                                {timing.startedAt && <span>{isEn ? 'Start' : '开始'}: {formatDateTime(timing.startedAt)}</span>}
                                {timing.endedAt && <span>{isEn ? 'End' : '结束'}: {formatDateTime(timing.endedAt)}</span>}
                                {!timing.startedAt && <span>{isEn ? 'Waiting to start' : '待开始'}</span>}
                              </div>
                            </div>
                            <div className={`grid gap-2 ${navigationOrderId === orderId ? 'grid-cols-2' : 'grid-cols-1'}`}>
                              <button
                                type="button"
                                disabled={(!canStart && !canEnd) || orderTimingBusy !== null}
                                onClick={() => changeOrderTiming(orderId, isCurrent ? 'end' : 'start')}
                                className={`min-h-14 min-w-0 rounded-lg px-2 text-sm font-bold leading-tight text-white shadow-sm disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-600 disabled:shadow-none ${isCurrent ? 'bg-red-600 hover:bg-red-700' : 'bg-green-700 hover:bg-green-800'}`}
                              >{orderTimingBusy === orderId ? '…' : buttonLabel}</button>
                              {navigationOrderId === orderId && (
                                <button
                                  type="button"
                                  disabled={!navUrl}
                                  onClick={() => navUrl && window.open(navUrl, '_blank')}
                                  className="min-h-14 min-w-0 rounded-lg border border-blue-700 bg-blue-700 px-2 text-sm font-bold leading-tight text-white shadow-sm hover:bg-blue-800 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                                >{navUrl ? (isEn ? '🧭 Navigate' : '🧭 导航') : (isEn ? 'No location' : '无导航地址')}</button>
                              )}
                            </div>
                            {isCurrent && !canEnd && (
                              <p className="text-xs leading-relaxed text-amber-800">
                                {paymentSavingRestId === r.restaurantId
                                  ? (isEn ? 'Saving collected amount…' : '正在保存实收金额…')
                                  : !hasValidPayment
                                    ? (isEn ? 'Enter and save the amount collected (0 is allowed) before ending.' : '请先输入并保存实收金额（可以填写 0），再结束订单。')
                                    : (isEn ? 'Get the customer signature before ending this order.' : '请先完成顾客签名，才能结束订单。')}
                              </p>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  <details className="rounded-xl border border-gray-200 bg-gray-50">
                    <summary className="min-h-12 cursor-pointer list-none px-4 py-3 text-sm font-semibold text-gray-800">
                      <span className="flex items-center justify-between gap-3">
                        <span>{isEn ? `Order Items (${r.items.length})` : `订单商品（${r.items.length}）`}</span>
                        <span className="text-xs font-normal text-gray-500">{isEn ? 'Tap to expand' : '点击展开'}</span>
                      </span>
                    </summary>
                    <div className="space-y-2 border-t border-gray-200 p-3">
                      {r.items.map((item, itemIndex) => (
                        <div key={`${item.productId}-${itemIndex}`} className="rounded-lg border border-gray-100 bg-white p-3">
                          <div className="break-words font-semibold leading-snug text-gray-900">{item.productName}</div>
                          {item.spec && <div className="mt-1 break-words text-sm leading-relaxed text-gray-500">{item.spec}</div>}
                          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                            <div><div className="text-xs text-gray-500">{isEn ? 'Qty' : '数量'}</div><div className="mt-1 font-semibold">{item.quantity}</div></div>
                            <div className="text-right"><div className="text-xs text-gray-500">{isEn ? 'Subtotal' : '小计'}</div><div className="mt-1 font-semibold" style={{ color: PURPLE }}>€{item.subtotal.toFixed(2)}</div></div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>

                  <div className="space-y-1 border-t border-gray-200 pt-3">
                    {returnAdjustment.incTax > 0 && (
                      <div className="flex items-center justify-between text-sm text-red-600">
                        <span>{isEn ? 'Reported returns' : '已报退货抵扣'}</span>
                        <span>−€{returnAdjustment.incTax.toFixed(2)}</span>
                      </div>
                    )}
                    {dueTax > 0 && (
                      <>
                        <div className="flex items-center justify-between text-sm text-gray-500">
                          <span>{isEn ? 'Subtotal (excl. tax)' : '合计（不含税）'}</span>
                          <span>€{dueExTax.toFixed(2)}</span>
                        </div>
                        <div className="flex items-center justify-between text-sm text-gray-500">
                          <span>{isEn ? 'Tax' : '税额'}</span>
                          <span>€{dueTax.toFixed(2)}</span>
                        </div>
                      </>
                    )}
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-sm font-medium text-gray-700">
                        {returnAdjustment.incTax > 0
                          ? (isEn ? 'Amount to Collect After Returns' : '退货后应收合计')
                          : dueTax > 0
                            ? (isEn ? 'Total Due (incl. tax)' : '应收合计（含税）')
                            : (isEn ? 'Total Due' : '应收合计')}
                      </span>
                      <span className="text-xl font-bold" style={{ color: PURPLE }}>€{dueIncTax.toFixed(2)}</span>
                    </div>
                  </div>

                  {(tripStatus === 'in_progress' || tripStatus === 'verifying') && (
                    <div className="rounded-xl border border-gray-200 bg-white p-3">
                      <label className="mb-2 block text-sm font-semibold text-gray-700">{isEn ? 'Amount Collected (€)' : '实收金额 (€)'}</label>
                      <NumericInput
                        min="0"
                        step="0.01"
                        placeholder={isEn ? 'Enter amount collected' : '输入实收金额'}
                        value={r.payment ?? ''}
                        onBlur={e => {
                          const value = e.target.value.trim()
                          if (!value) {
                            toast.error(isEn ? 'Enter an amount collected (0 is allowed)' : '请输入实收金额（可以填写 0）')
                            return
                          }
                          void setPayment(r.restaurantId, Number(value))
                        }}
                        disabled={tripStatus === 'in_progress'
                          ? !canEditPayment || paymentLocked || paymentSavingRestId === r.restaurantId
                          : !canOperateRest || paymentLocked || paymentSavingRestId === r.restaurantId}
                        className="min-h-14 w-full rounded-lg border-2 border-purple-400 bg-white px-4 py-3 text-xl font-semibold text-gray-900 shadow-sm outline-none transition focus:border-purple-700 focus:ring-4 focus:ring-purple-100 disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                      />
                    </div>
                  )}

                  {r.returns.length > 0 && (
                    <div className="border-t pt-4">
                      <p className="mb-2 text-sm font-medium text-gray-700">{isEn ? '📦 Returns/Exchanges' : '📦 退换货记录'}</p>
                      <div className="space-y-2">
                        {r.returns.map((ret, i) => (
                          <div key={i} className="flex flex-wrap items-center gap-3 text-sm text-gray-600">
                            <span className="font-medium">{ret.productName}</span>
                            <span className="text-red-500">×{ret.quantity}</span>
                            {ret.actionType && <span className={`rounded px-1.5 py-0.5 text-xs ${ret.actionType === 'exchange' ? 'bg-blue-50 text-blue-600' : 'bg-red-50 text-red-600'}`}>{ret.actionType === 'exchange' ? (isEn ? 'Exchange' : '换货') : (isEn ? 'Return' : '退货')}</span>}
                            {ret.reason && <span className="text-xs text-gray-400">{ret.reason}</span>}
                            {ret.photo && <img src={ret.photo} alt={isEn ? 'Return photo' : '退货图'} className="h-10 w-10 rounded border object-cover" />}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {r.signature && (
                    <div className="border-t pt-4">
                      <p className="mb-2 text-sm font-medium text-gray-700">{isEn ? '✍️ Customer Signature' : '✍️ 客户签收'}</p>
                      <div className="inline-block rounded border bg-white p-2"><img src={r.signature} alt={isEn ? 'Customer signature' : '客户签名'} className="h-20 object-contain" /></div>
                      <p className="mt-1 text-xs text-gray-500">{isEn ? 'Signed by' : '签收人'}：{r.signerName ?? '—'}{r.signedAt && ` · ${new Date(r.signedAt).toLocaleString(isEn ? 'en-GB' : 'zh-CN')}`}</p>
                    </div>
                  )}

                  {(r.pods ?? []).length > 0 && (
                    <div className="border-t pt-4">
                      <p className="mb-2 text-sm font-medium text-gray-700">{isEn ? '📷 POD Photos' : '📷 POD 签收照片'}</p>
                      <div className="flex flex-wrap gap-2">{(r.pods ?? []).map((pod, podIndex) => <img key={podIndex} src={pod} alt={`POD ${podIndex + 1}`} className="h-20 w-20 rounded border object-cover" />)}</div>
                    </div>
                  )}

                  {tripStatus === 'in_progress' && (
                    <div className="grid grid-cols-2 gap-2 border-t pt-4 sm:grid-cols-3">
                      <Button
                        variant="outline"
                        disabled={!canReportException}
                        className="min-h-12 min-w-0 whitespace-normal border-2 border-amber-300 bg-amber-50 px-2 text-center text-sm font-semibold leading-tight text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                        onClick={() => openExceptionModal(r.restaurantId)}
                      >{isEn ? 'Report Exception' : '报告异常'}</Button>
                      <Button
                        variant="outline"
                        disabled={!canUploadPod || uploadingPodRestId === r.restaurantId}
                        className="min-h-12 min-w-0 whitespace-normal border-2 px-2 text-center text-sm font-semibold leading-tight disabled:bg-gray-100 disabled:text-gray-400"
                        onClick={() => { setPodRestId(r.restaurantId); podInputRef.current?.click() }}
                      >{uploadingPodRestId === r.restaurantId ? (isEn ? 'Uploading…' : '上传中…') : (isEn ? 'Upload POD' : '上传 POD')}</Button>
                      {!r.delivered && (
                        <Button
                          disabled={!canSignOff}
                          className="col-span-2 min-h-14 min-w-0 whitespace-normal px-2 text-center text-base font-bold leading-tight text-white bg-green-700 hover:bg-green-800 disabled:bg-gray-300 disabled:text-gray-600 sm:col-span-1"
                          onClick={() => openSignModal(r.restaurantId)}
                        >{isEn ? 'Customer Sign-off' : '客户签收'}</Button>
                      )}
                    </div>
                  )}

                  {tripStatus === 'completed' && (
                    <div className="border-t pt-4">
                      <Button variant="outline" className="min-h-11 whitespace-normal text-center" onClick={() => openExceptionModal(r.restaurantId)}>
                        {isEn ? 'Report Late Return/Exchange' : '补报退换货'}
                      </Button>
                    </div>
                  )}
              </div>
            </div>
          )
        })}
      </div>

      {tripStatus !== 'completed' && (
        <div className="border-t border-gray-200 pt-4">
          <Button
            onClick={requestEndTrip}
            style={allProcessed ? { background: PURPLE, borderColor: PURPLE } : {}}
            className={`min-h-14 w-full whitespace-normal px-3 text-base font-semibold leading-tight sm:w-full ${allProcessed ? 'text-white hover:opacity-90' : ''}`}
            variant={allProcessed ? 'default' : 'outline'}
            disabled={tripStatus === 'pending' || tripStatus === 'verifying' || !allProcessed || !allOrderTimersEnded}
          >
            {isEn ? `End Trip (${processedCount}/${trip.restaurants.length})` : `结束行程 (${processedCount}/${trip.restaurants.length})`}
          </Button>
        </div>
      )}

      <input
        ref={podInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={e => { if (podRestId) handlePodUpload(e, podRestId) }}
      />

      {showEndTripConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 sm:p-4">
          <div className="w-full max-w-md space-y-4 rounded-xl bg-white p-4 shadow-xl sm:p-5">
            <div>
              <h3 className="text-lg font-bold text-gray-900">{isEn ? 'End this trip?' : '确认结束行程？'}</h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-600">
                {isEn
                  ? 'All stops are complete. Ending the trip will mark this trip and its orders as completed.'
                  : '所有站点已完成。确认后，本行程及相关订单将更新为已完成。'}
              </p>
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="outline"
                className="min-h-12 sm:min-w-24"
                onClick={() => setShowEndTripConfirm(false)}
                disabled={endingTrip}
              >{isEn ? 'Cancel' : '取消'}</Button>
              <Button
                className="min-h-12 bg-green-700 text-base font-semibold text-white hover:bg-green-800 sm:min-w-36"
                onClick={endTrip}
                disabled={endingTrip}
              >{endingTrip ? (isEn ? 'Ending…' : '正在结束…') : (isEn ? 'Confirm End Trip' : '确认结束行程')}</Button>
            </div>
          </div>
        </div>
      )}

      {/* 报告异常 Modal */}
      {/* Sign on Glass —— 客户手写签收。合同第四条把「司机电子签收」写进验收闭环 */}
      {signModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 sm:p-4">
          <div className="max-h-[90dvh] w-full max-w-md space-y-4 overflow-y-auto overscroll-contain rounded-xl bg-white p-4 sm:p-5">
            <div>
              <h3 className="break-words font-bold leading-snug text-gray-900">{isEn ? `Customer Sign-off — ${signModal.restName}` : `客户签收 — ${signModal.restName}`}</h3>
              <p className="text-xs text-gray-500 mt-0.5">{isEn ? 'Hand the phone to the customer to sign below and confirm receipt' : '请把手机递给客户，由客户本人在下方签名确认收货'}</p>
            </div>

            <SignaturePad onChange={setSignData} disabled={signing} />

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{isEn ? 'Recipient Name' : '签收人姓名'}</label>
              <input
                className="min-h-12 w-full rounded-lg border-2 border-purple-300 px-3 py-2 text-base focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-100"
                placeholder={isEn ? "Customer's name, or driver fills in" : '请客户写下或司机代填姓名'}
                value={signerName}
                onChange={e => setSignerName(e.target.value)}
                disabled={signing}
                maxLength={40}
              />
              <p className="text-xs text-gray-400 mt-1">{isEn ? "The signature image alone can't identify the signer, so the name is recorded separately for accountability" : '签名图像认不出是谁签的，姓名要单独记，日后追责才有依据'}</p>
            </div>

            <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
              <Button variant="outline" className="min-h-12 sm:min-w-24" onClick={() => setSignModal(null)} disabled={signing}>
                {isEn ? 'Cancel' : '取消'}
              </Button>
              <Button
                className="min-h-12 bg-green-600 text-base font-semibold hover:bg-green-700 sm:min-w-36"
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
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 sm:p-4">
            <div className="max-h-[90dvh] w-full max-w-md space-y-4 overflow-y-auto overscroll-contain rounded-xl bg-white p-4 sm:p-5">
              <h3 className="break-words font-bold leading-snug text-gray-900">{isEn ? `Report Exception — ${rest.restaurantName}` : `报告异常 — ${rest.restaurantName}`}</h3>

              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">{isEn ? 'Select affected products (multiple allowed)' : '选择有异常的商品（可多选）'}</p>
                <div className="space-y-2 border rounded-lg divide-y">
                  {exceptionProducts.map((p, i) => (
                    <div key={`${p.productId}-${i}`} className="flex items-start gap-3 px-3 py-3">
                      <input
                        type="checkbox"
                        id={`exc-${i}`}
                        checked={p.selected}
                        onChange={e => {
                          setExceptionProducts(prev => prev.map((x, j) => j === i ? { ...x, selected: e.target.checked } : x))
                        }}
                        className="mt-1 h-5 w-5 shrink-0 cursor-pointer"
                        style={{ accentColor: PURPLE }}
                      />
                      <label htmlFor={`exc-${i}`} className="min-w-0 flex-1 cursor-pointer text-sm leading-snug">
                        <span className="break-words font-medium text-gray-800">{p.productName}</span>
                        <span className="ml-2 break-words text-gray-500">{isEn ? `Allocated ${p.allocatedQuantity}` : `已配 ${p.allocatedQuantity}`}</span>
                      </label>
                      {p.selected && (
                        <div className="shrink-0">
                          <NumericInput
                            min={0.001}
                            max={p.allocatedQuantity}
                            step="0.001"
                            value={p.quantity}
                            aria-label={isEn ? `Return quantity for ${p.productName}` : `${p.productName}退货数量`}
                            aria-invalid={p.quantity <= 0 || p.quantity > p.allocatedQuantity}
                            onChange={e => {
                              const qty = Number(e.target.value) || 0
                              setExceptionProducts(prev => prev.map((x, j) => j === i ? { ...x, quantity: qty } : x))
                            }}
                            className={`min-h-11 w-20 rounded-md border-2 bg-white px-2 py-2 text-right text-base font-semibold shadow-sm outline-none focus:ring-2 ${p.quantity <= 0 || p.quantity > p.allocatedQuantity ? 'border-red-500 text-red-700 focus:border-red-500 focus:ring-red-100' : 'border-purple-300 text-gray-900 focus:border-purple-500 focus:ring-purple-100'}`}
                          />
                          {(p.quantity <= 0 || p.quantity > p.allocatedQuantity) && (
                            <p className="mt-1 text-right text-[11px] text-red-600">
                              {isEn ? `Max ${p.allocatedQuantity}` : `最多 ${p.allocatedQuantity}`}
                            </p>
                          )}
                        </div>
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
                        className="min-h-10 rounded-full border px-3 py-2 text-sm leading-tight transition-colors"
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
                  className="min-h-12 w-full rounded-lg border-2 border-purple-300 px-3 py-2 text-base focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-100"
                  style={{ focusRingColor: PURPLE } as React.CSSProperties}
                />
              </div>

              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">{isEn ? 'Action' : '处理方式'}</p>
                <div className="flex flex-wrap gap-2">
                  <label className="flex min-h-11 flex-1 items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={exceptionAction === 'return'}
                      onChange={() => setExceptionAction('return')}
                      style={{ accentColor: PURPLE }}
                    />
                    <span className="text-sm text-gray-700">{isEn ? 'Return' : '退货'}</span>
                  </label>
                  <label className="flex min-h-11 flex-1 items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 cursor-pointer">
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

              <div>
                <p className="text-sm font-medium text-gray-700 mb-2">{isEn ? 'Photo Evidence' : '现场照片'}</p>
                {exceptionPhoto ? (
                  <div className="flex items-center gap-3">
                    <img src={exceptionPhoto} alt="exception" className="w-16 h-16 rounded object-cover border" />
                    <Button variant="outline" className="min-h-11" onClick={() => exceptionPhotoInputRef.current?.click()}>
                      {isEn ? 'Retake' : '重新拍照'}
                    </Button>
                  </div>
                ) : (
                  <Button variant="outline" className="min-h-11" onClick={() => exceptionPhotoInputRef.current?.click()}>
                    {isEn ? '📷 Take Photo' : '📷 拍照'}
                  </Button>
                )}
                <input
                  ref={exceptionPhotoInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={handleExceptionPhotoUpload}
                />
              </div>

              {tripStatus === 'completed' && (
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-2">
                    {isEn ? 'Why report this late?' : '为什么现在才补报'} <span className="text-red-500">*</span>
                  </p>
                  <p className="text-xs text-gray-400 mb-2">
                    {isEn ? 'This trip is already completed — explain the delay separately from the return reason above' : '这单已完成签收，补报原因跟上面的退换货原因分开记，方便核实时追溯'}
                  </p>
                  <textarea
                    value={exceptionLateNote}
                    onChange={e => setExceptionLateNote(e.target.value)}
                    placeholder={isEn ? 'e.g. customer only reported this 3 days later' : '例如：客户 3 天后才反馈，今天补录'}
                    className="min-h-20 w-full rounded-lg border-2 border-purple-300 px-3 py-2 text-base focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-100"
                    rows={2}
                    maxLength={500}
                  />
                </div>
              )}

              <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row">
                <Button variant="outline" className="min-h-12 flex-1" onClick={() => setExceptionModal(null)} disabled={submittingException}>{isEn ? 'Cancel' : '取消'}</Button>
                <Button
                  className="min-h-12 flex-1 text-base font-semibold text-white"
                  style={{ background: '#ea580c' }}
                  onClick={submitException}
                  disabled={
                    submittingException ||
                    !exceptionPhoto ||
                    (tripStatus === 'completed' && !exceptionLateNote.trim())
                  }
                >
                  {submittingException ? (isEn ? 'Submitting…' : '提交中…') : (isEn ? 'Confirm Exception' : '确认报告异常')}
                </Button>
              </div>
            </div>
          </div>
        )
      })()}

    </div>
  )
}
