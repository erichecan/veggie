'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut, apiPatch, authHeaders } from '@/lib/api'
import { computeFreightAllocationForConfirm, computeLandedUnitCost } from '@/lib/purchase-landed-cost'
import { formatDateOnly } from '@/lib/format-date'
import { parseStoredQc, lineVerdict, formatQcSummary, QC_REJECT_REASON_LABELS, type QcRejectReason } from '@/lib/purchase/qc'
import { lineDescription } from '@/lib/order-line-description'
import { defaultPurchaseTaxRate } from '@/lib/purchase/tax-rates'
import OrderLineEditor from '@/components/classic/OrderLineEditor'
import { lineFieldKeyHandler } from '@/lib/order-line-keys'
import SimilarProductAlert from '@/components/shared/similar-product-alert'
import { DatePicker } from '@/components/ui/date-picker'
import { SearchableDropdown } from '@/components/shared/searchable-dropdown'
import { getSession, type UserSession } from '@/lib/session'
import { useRefetchOnFocus } from '@/lib/hooks/use-refetch-on-focus'
import { useDraftAutosave } from '@/lib/hooks/use-draft-autosave'
import DraftRestoreBanner from '@/components/shared/DraftRestoreBanner'
import { readPurchaseNavParams, DEFAULT_PURCHASE_NAV_PARAMS } from '@/lib/purchase-nav-list'
import StockMovesTable from '@/components/classic/StockMovesTable'

async function openPurchaseOrderPdf(poId: string, isEn: boolean) {
  // JWT 存在 localStorage，直接 window.open API 路由不会带 Authorization 头会 401，
  // 必须先用带鉴权的 fetch 取回 HTML 文本，再开新窗口写入。
  const win = window.open('', '_blank')
  try {
    const res = await fetch(`/api/purchase-orders/${poId}/pdf`, { headers: authHeaders() })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    if (win) {
      win.document.open()
      win.document.write(html)
      win.document.close()
    }
  } catch (e) {
    win?.close()
    toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to generate PDF' : 'PDF 生成失败'))
  }
}

const PURPLE = '#875A7B'
const DARK = '#1f2d3d'

type POStatus = 'DRAFT' | 'SENT' | 'CONFIRMED' | 'RECEIVED' | 'INVOICED' | 'LOCKED' | 'TO_APPROVE' | 'CANCELLED'

interface POLine {
  id: string
  sequence: number
  productId?: string | null
  productName: string
  spec?: string | null
  description?: string | null
  productSpec?: string | null
  uomId?: string | null
  uomName?: string | null
  orderedQty: number
  receivedQty?: number
  unitCost: number
  taxRate: number
  bestBefore?: string | null
  subtotalExTax: number
  taxAmount: number
  subtotalIncTax: number
  /// 本行分摊运费手动覆盖值（20261017）：null=未手动指定，确认时按数量比例自动算；
  /// 已确认的单子这里是服务端写入的真实分摊结果
  allocatedFreightEur?: number | null
  /// 落地成本（确认时写入，取消时用作回滚依据的来源字段），未确认之前恒为 null
  landedUnitCostEur?: number | null
}

interface POBill {
  id: string
  name: string
  status: string
  totalIncTax: number
  createdAt: string
}

interface ActivityLogEntry {
  id: string
  action: string
  detail: string | null
  userName: string
  createdAt: string
}

interface GoodsReceiptRow {
  id: string
  name: string
  arrivedAt: string
  receivedBy?: string | null
  notes?: string | null
  photos?: string[]
  lines: Array<{
    productId: string; productName: string; qty: number
    condition?: 'ok' | 'damaged' | 'rejected'
    /** 收货质检（台账 F4）：随收货行落库，这里是**读取派生**，不另存一份 */
    qc?: unknown
    rejectReason?: QcRejectReason | null
  }>
}

interface PurchaseOrder {
  id: string
  name: string
  status: POStatus
  supplierId: string
  supplierName?: string
  orderDate: string
  expectedDate?: string | null
  firstArrivedAt?: string | null
  lastArrivedAt?: string | null
  notes?: string | null
  vendorReference?: string | null
  lockedAt?: string | null
  editApprovalRequired?: boolean
  currency: string
  exchangeRate?: number | null
  exchangeRatePending?: boolean
  subtotalExTax: number
  totalTax: number
  totalIncTax: number
  totalIncTaxEur?: number | null
  freightAmount?: number | null
  createdAt: string
  lines: POLine[]
  bills?: POBill[]
  receipts?: GoodsReceiptRow[]
  activityLog?: ActivityLogEntry[]
}

interface Supplier {
  id: string
  name: string
  supplierPaymentTerm?: string | null
  /// 供应商档案的 Vendor Tax(小数)；商品没设 Vendor Taxes 时用它兜底(lib/purchase/tax-rates.ts)
  vendorTaxRate?: number | string | null
}

interface PurchaseProduct {
  id: string
  name: string
  internalRef?: string | null
  category?: string | null
  spec?: string | null
  saleDescription?: string | null
  uomId?: string | null
  uomName?: string | null
  standardPrice?: number | null
  price?: number | null
  /// 商品详情页"Vendor Taxes"——存的是小数(0/0.135/0.23)，采购单行 taxRate 存百分数(0/13.5/23)
  vendorTaxRate?: number | string | null
  /// 按采购单位区分的规格（如 10KG/20KG 两袋同名商品）——来自 ProductSaleUom.spec，
  /// 跟上面的 spec（Product.spec）是两张不同的表，Product.spec 早就清空了
  purchaseUomSpec?: string | null
  purchaseUomId?: string | null
  purchaseUomName?: string | null
  /// SERVICE 类商品不参与运费分摊（20261017 客户需求）
  type?: string | null
  /// 按采购单位换算到基础单位的系数（ProductSaleUom.factor）；运费分摊按基础单位换算要用。
  /// ⛔ 不能用全局 Uom.factor —— 同名 CASE 在不同商品里箱规不同（见 schema 注释）
  saleUoms?: { uomId: string; factor?: number | string | null }[]
}

/** 采购单加行的默认税率：读商品详情页设置的 Vendor Taxes，不再恒为 0（客户 20260904 反馈） */
function purchaseTaxRateOf(prod: PurchaseProduct, supplierVendorTax?: unknown): number {
  // 商品优先、供应商兜底、都没有为 0 —— 与服务端 createPurchaseOrder 的默认值同一个口径
  return defaultPurchaseTaxRate(prod.vendorTaxRate, supplierVendorTax)
}

function productDescription(prod: PurchaseProduct): string | null {
  return prod.saleDescription?.trim() || prod.spec?.trim() || null
}

interface Category {
  id: string
  name: string
  nameZh?: string | null
}

interface Uom {
  id: string
  name: string
  nameZh?: string | null
}

function toInputDate(iso?: string | null) {
  if (!iso) return ''
  try { return new Date(iso).toISOString().slice(0, 10) } catch { return '' }
}

/**
 * 把「确认收货 / 采购退货」这两类 ActionLog 的 detail 拆回结构化的品项。
 * 两条路都不建单据表，唯一的记录就是这条日志，格式由服务端固定写出：
 *   确认收货 PO PO-00057：Carrot ×100、Celery ×5           （lib/purchase/receive-purchase-order.ts）
 *   采购退货 PO-00057：Carrot ×2，应退金额 €11 - 坏了（…）  （api/purchase-orders/[id]/return）
 * 解析不出品项（如「本次无入库数量」）时 items 为空，原文落到 note 里照样展示，不丢信息。
 */
function parseMovementLog(detail: string | null): { items: Array<{ name: string; qty: string }>; note: string } {
  // 去掉「确认收货 PO PO-00057：」/「采购退货 PO-00057：」这段前缀（两边写法不一样，按第一个全角冒号切）
  const text = (detail ?? '').replace(/^[^：（]*?(：|(?=（))/, '')
  const comma = text.indexOf('，')
  const itemsPart = comma >= 0 ? text.slice(0, comma) : text
  const items = itemsPart.split('、').map(seg => {
    const at = seg.lastIndexOf(' ×')
    return at > 0 ? { name: seg.slice(0, at), qty: seg.slice(at + 2) } : null
  })
  if (items.length === 0 || items.some(x => x === null)) return { items: [], note: text }
  return { items: items as Array<{ name: string; qty: string }>, note: comma >= 0 ? text.slice(comma + 1) : '' }
}

/** 一次入库 / 退货动作的卡片（数据来自 ActionLog，见 parseMovementLog） */
function MovementLogCard({ log, kind, isEn }: { log: ActivityLogEntry; kind: 'in' | 'return'; isEn: boolean }) {
  const { items, note } = parseMovementLog(log.detail)
  const isReturn = kind === 'return'
  return (
    <div className={`border rounded p-3 text-sm ${isReturn ? 'border-red-100 bg-red-50/40' : 'border-gray-200'}`}>
      <div className="flex items-center justify-between">
        <span className={`font-medium ${isReturn ? 'text-red-700' : 'text-gray-800'}`}>
          {isReturn ? (isEn ? 'Return to vendor' : '退货给供应商') : (isEn ? 'Received into stock' : '确认入库')}
        </span>
        <span className="text-gray-500 text-xs">
          {new Date(log.createdAt).toLocaleString(isEn ? 'en-GB' : 'zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
          {log.userName ? ` · ${log.userName}` : ''}
        </span>
      </div>
      {items.length > 0 && (
        <table className="w-full mt-2 text-xs">
          <tbody>
            {items.map((it, i) => (
              <tr key={i} className="border-t border-gray-100">
                <td className="py-1 text-gray-700">{it.name}</td>
                <td className={`py-1 text-right tabular-nums w-24 ${isReturn ? 'text-red-700' : 'text-gray-800'}`}>
                  {isReturn ? '−' : ''}{it.qty}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {note && <div className="text-xs text-gray-500 mt-1">{note}</div>}
    </div>
  )
}

/** 一张收货单（GoodsReceipt）的卡片：「其他信息」tab 与收货/退货快捷弹窗共用。
 *  showLines=true 时额外列出每行商品与数量——弹窗是专门来看"到底收了什么"的
 *  onUpdated：订正到货日期成功后通知父级重新拉取 PO（firstArrivedAt/lastArrivedAt 要跟着重算） */
function ReceiptCard({ gr, isEn, showLines = false, onUpdated }: { gr: GoodsReceiptRow; isEn: boolean; showLines?: boolean; onUpdated?: () => void }) {
  const [editing, setEditing] = useState(false)
  const [editDate, setEditDate] = useState('')
  const [saving, setSaving] = useState(false)
  const damaged = gr.lines.filter(l => l.condition === 'damaged')
  const rejected = gr.lines.filter(l => l.condition === 'rejected')
  // 质检信息在采购单上可见（台账 F4 验收第二条）：只列**填过**的行，
  // 没做质检的收货一个字都不多印
  const checked = gr.lines
    .map(l => ({ line: l, qc: parseStoredQc(l.qc) }))
    .filter(x => x.qc || x.line.condition === 'rejected')

  function startEdit() {
    setEditDate(gr.arrivedAt ? new Date(gr.arrivedAt).toISOString().slice(0, 10) : '')
    setEditing(true)
  }

  async function saveEdit() {
    if (!editDate) {
      toast.error(isEn ? 'Arrived date is required' : '到货日期不能为空')
      return
    }
    setSaving(true)
    try {
      await apiPut(`/api/goods-receipts/${gr.id}`, { arrivedAt: editDate })
      toast.success(isEn ? 'Arrived date corrected' : '到货日期已订正')
      setEditing(false)
      onUpdated?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to save' : '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border border-gray-200 rounded p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium text-gray-800">{gr.name}</span>
        {editing ? (
          <span className="flex items-center gap-1.5">
            <DatePicker value={editDate} onChange={setEditDate} className="border border-gray-300 rounded px-1.5 py-0.5 text-xs" style={{ width: '120px' }} />
            <button type="button" onClick={saveEdit} disabled={saving} className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50">
              {isEn ? 'Save' : '保存'}
            </button>
            <button type="button" onClick={() => setEditing(false)} disabled={saving} className="text-xs text-gray-400 hover:text-gray-600">
              {isEn ? 'Cancel' : '取消'}
            </button>
          </span>
        ) : (
          <span className="text-gray-500">
            {isEn ? 'Arrived' : '到货'} {formatDateOnly(gr.arrivedAt)}{gr.receivedBy ? ` · ${gr.receivedBy}` : ''}
            <button type="button" onClick={startEdit} className="ml-1.5 text-xs text-gray-400 hover:text-blue-600 underline">
              {isEn ? 'Edit' : '订正'}
            </button>
          </span>
        )}
      </div>
      <div className="text-xs text-gray-500 mt-1">
        {isEn ? `${gr.lines.length} item(s)` : `${gr.lines.length} 个品项`}
        {damaged.length > 0 && (
          <span className="text-red-600 ml-1">{isEn ? `· ${damaged.length} damaged` : `· ${damaged.length} 项有损坏`}</span>
        )}
        {rejected.length > 0 && (
          <span className="text-red-700 ml-1 font-medium">{isEn ? `· ${rejected.length} rejected` : `· ${rejected.length} 项拒收`}</span>
        )}
      </div>
      {showLines && gr.lines.length > 0 && (
        <table className="w-full mt-2 text-xs">
          <tbody>
            {gr.lines.map((l, i) => (
              <tr key={`${l.productId}-${i}`} className="border-t border-gray-100">
                <td className="py-1 text-gray-700">{l.productName}</td>
                <td className="py-1 text-right text-gray-800 tabular-nums w-24">{Number(l.qty).toFixed(3)}</td>
                <td className="py-1 text-right w-16">
                  {l.condition === 'damaged' && <span className="text-red-600">{isEn ? 'Damaged' : '损坏'}</span>}
                  {l.condition === 'rejected' && <span className="text-red-700">{isEn ? 'Rejected' : '拒收'}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {checked.length > 0 && (
        <div className="mt-2 rounded bg-gray-50 border border-gray-100 p-2 space-y-1">
          <div className="text-xs font-medium text-gray-600">{isEn ? 'Quality check' : '质检记录'}</div>
          {checked.map(({ line, qc }, i) => {
            const isRejected = line.condition === 'rejected'
            const verdict = lineVerdict(qc, isRejected ? Number(line.qty) : 0)
            return (
              <div key={`${line.productId}-${i}`} className="text-xs text-gray-600 flex items-start gap-1.5 flex-wrap">
                <span className="text-gray-800">{line.productName}</span>
                {verdict && (
                  <span className={`px-1.5 py-0.5 rounded ${verdict === 'FAIL' ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'}`}>
                    {verdict === 'FAIL' ? (isEn ? 'Failed' : '不合格') : (isEn ? 'Passed' : '合格')}
                  </span>
                )}
                {isRejected && (
                  <span className="text-red-700">
                    {isEn ? `Rejected ${Number(line.qty)}` : `拒收 ${Number(line.qty)}`}
                    {line.rejectReason ? `（${isEn ? QC_REJECT_REASON_LABELS[line.rejectReason].en : QC_REJECT_REASON_LABELS[line.rejectReason].zh}）` : ''}
                  </span>
                )}
                <span className="text-gray-500">{formatQcSummary(qc, isEn ? 'en' : 'zh')}</span>
              </div>
            )
          })}
          {rejected.length > 0 && (
            <div className="text-xs text-red-700">
              {isEn
                ? 'Rejected quantities are not counted as received — this PO stays open until the supplier replaces or credits them.'
                : '拒收数量不计入已收 —— 本采购单会保持未收齐，直到供应商补货或退款。'}
            </div>
          )}
        </div>
      )}
      {gr.notes && <div className="text-xs text-gray-500 mt-1">{gr.notes}</div>}
      {(gr.photos?.length ?? 0) > 0 && (
        <div className="flex gap-1.5 mt-2 flex-wrap">
          {(gr.photos ?? []).map((src, i) => (
            <img key={i} src={src} alt={isEn ? `${gr.name} photo ${i + 1}` : `${gr.name} 照片 ${i + 1}`} className="w-12 h-12 rounded object-cover border border-gray-200" />
          ))}
        </div>
      )}
    </div>
  )
}

function OdooStatusBar({ status, isEn }: { status: POStatus; isEn: boolean }) {
  const steps = [
    { label: isEn ? 'Request for Quotation' : '询价单', statuses: ['DRAFT'] as POStatus[] },
    { label: isEn ? 'RFQ Sent' : '询价单已发送', statuses: ['SENT', 'TO_APPROVE'] as POStatus[] },
    { label: isEn ? 'Purchase Order' : '采购订单', statuses: ['CONFIRMED', 'RECEIVED', 'INVOICED'] as POStatus[] },
    { label: isEn ? 'Locked' : '已锁定', statuses: ['LOCKED'] as POStatus[] },
  ]
  const activeIdx = steps.findIndex(s => s.statuses.includes(status))

  if (status === 'CANCELLED') {
    return (
      <span className="px-4 py-1 text-sm font-medium rounded-full" style={{ background: '#fef2f2', color: '#dc2626' }}>
        {isEn ? 'Cancelled' : '已取消'}
      </span>
    )
  }

  return (
    <div className="flex items-center gap-2">
      {status === 'TO_APPROVE' && (
        <span className="px-3 py-1 text-xs font-medium rounded-full" style={{ background: '#fef3cd', color: '#856404' }}>
          {isEn ? 'Pending Approval' : '待审批'}
        </span>
      )}
      <div className="flex items-stretch gap-0" style={{ height: '28px' }}>
        {steps.map((step, i) => {
          const isActive = i === activeIdx
          const isPast = i < activeIdx
          const bg = isActive ? PURPLE : isPast ? '#c8b0d0' : '#ede7f0'
          const color = isActive ? 'white' : isPast ? '#5a3060' : '#9d7ab0'
          const paddingLeft = i === 0 ? 'pl-5' : 'pl-8'

          return (
            <div
              key={step.label}
              className={`relative flex items-center ${paddingLeft} pr-5 text-xs font-medium select-none`}
              style={{
                background: bg,
                color,
                clipPath: i === 0
                  ? 'polygon(0 0, calc(100% - 11px) 0, 100% 50%, calc(100% - 11px) 100%, 0 100%)'
                  : i === steps.length - 1
                  ? 'polygon(0 0, 100% 0, 100% 100%, 0 100%, 11px 50%)'
                  : 'polygon(0 0, calc(100% - 11px) 0, 100% 50%, calc(100% - 11px) 100%, 0 100%, 11px 50%)',
                marginLeft: i > 0 ? '-1px' : '0',
              }}
            >
              {isActive && <span className="mr-1.5 text-xs">●</span>}
              {step.label}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function PurchaseDetailPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale
  const params = useParams<{ id: string }>()
  const id = params.id

  const [session, setSession] = useState<UserSession | null>(null)
  useEffect(() => { setSession(getSession()) }, [])

  // 上一张/下一张(20261013 客户反馈：这两个按钮以前是摆设，点了没反应)：
  // 按列表当时的筛选+排序取整个结果集的 id 顺序；当前单不在其中(直接打开链接、或筛选后
  // 单子状态变了)就退回默认口径(全部采购单，按创建时间倒序)
  const [navIds, setNavIds] = useState<string[]>([])
  useEffect(() => {
    if (!id || id === 'new') return
    let cancelled = false
    const fetchIds = (q: string) => apiGet<{ ids: string[] }>(`/api/purchase-orders?${q}&idsOnly=1`).then(r => r.ids ?? [])
    ;(async () => {
      try {
        const saved = readPurchaseNavParams()
        let ids = saved ? await fetchIds(saved) : []
        if (!ids.includes(id)) ids = await fetchIds(DEFAULT_PURCHASE_NAV_PARAMS)
        if (!cancelled) setNavIds(ids.includes(id) ? ids : [])
      } catch { if (!cancelled) setNavIds([]) }
    })()
    return () => { cancelled = true }
  }, [id])
  const navIdx = navIds.indexOf(id)

  const [po, setPo] = useState<PurchaseOrder | null>(null)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [acting, setActing] = useState(false)
  const [savingExpectedDate, setSavingExpectedDate] = useState(false)
  const [activeTab, setActiveTab] = useState<'products' | 'other'>('products')

  const [editNotes, setEditNotes] = useState('')
  const [editVendorReference, setEditVendorReference] = useState('')
  const [editOrderDate, setEditOrderDate] = useState('')
  const [editExpectedDate, setEditExpectedDate] = useState('')
  const [editFreightAmount, setEditFreightAmount] = useState(0)
  const [editSupplierId, setEditSupplierId] = useState('')
  const [editLines, setEditLines] = useState<POLine[]>([])

  // 汇率待确认时的独立补录输入(不进整单编辑态，DRAFT/SENT 都能直接补)
  const [fixRateInput, setFixRateInput] = useState('')
  const [fixingRate, setFixingRate] = useState(false)

  // 确认收货弹窗（真正改库存的动作，20260823 从库存收货台搬来）
  const [showReceiveModal, setShowReceiveModal] = useState(false)
  const [receiveQtys, setReceiveQtys] = useState<Record<string, string>>({})
  const [receiving, setReceiving] = useState(false)

  // 退货/修正数量弹窗
  const [showReturnModal, setShowReturnModal] = useState(false)
  /** 收货/退货记录快捷查看（Odoo 式 smart button「N Receipt」） */
  const [showReceiptsModal, setShowReceiptsModal] = useState(false)
  const [returnQtys, setReturnQtys] = useState<Record<string, string>>({})
  const [returnReason, setReturnReason] = useState('')
  const [returning, setReturning] = useState(false)

  // ── 选品 / 快速建档 ──
  const [purchaseProducts, setPurchaseProducts] = useState<PurchaseProduct[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [uoms, setUoms] = useState<Uom[]>([])
  const [showQuickCreate, setShowQuickCreate] = useState(false)
  const [qcName, setQcName] = useState('')
  const [qcCategoryId, setQcCategoryId] = useState('')
  const [qcUomId, setQcUomId] = useState('')
  const [qcUnitCost, setQcUnitCost] = useState('')
  const [qcSubmitting, setQcSubmitting] = useState(false)
  const newLineSeq = useRef(0)
  const productsLoaded = useRef(false)
  // 插完空行要让那一行立刻进搜索态 —— 与新建采购单页/quotation/sale order 同一套交互
  const activatePickerRef = useRef<(lineId: string) => void>(() => {})
  const handleEditorReady = useCallback(
    (api: { focusSearch: () => void; activateProductPicker: (lineId: string) => void }) => {
      activatePickerRef.current = api.activateProductPicker
    },
    [],
  )

  function loadPurchaseProducts() {
    // status=ACTIVE：已归档商品不该出现在采购单选品里，与下单/报价页同一套过滤（客户 20260904 反馈）
    apiGet<PurchaseProduct[]>('/api/products?purchasable=1&slim=1&status=ACTIVE').then(setPurchaseProducts).catch(() => {})
  }

  function loadUoms() {
    apiGet<Uom[]>('/api/uoms').then(setUoms).catch(() => {})
  }

  async function loadPickerData() {
    if (productsLoaded.current) return
    productsLoaded.current = true
    loadPurchaseProducts()
    apiGet<Category[]>('/api/product-categories').then(setCategories).catch(() => {})
    loadUoms()
  }

  function addProductLine(prod: PurchaseProduct) {
    newLineSeq.current += 1
    const unitCost = Number(prod.standardPrice ?? prod.price ?? 0)
    const taxRate = purchaseTaxRateOf(prod, suppliers.find(s => s.id === editSupplierId)?.vendorTaxRate)
    const taxAmount = unitCost * taxRate / 100
    setEditLines(prev => [
      ...prev,
      {
        id: `new-${newLineSeq.current}`,
        sequence: (prev[prev.length - 1]?.sequence ?? 0) + 10,
        productId: prod.id,
        productName: prod.name,
        spec: lineDescription(prod, prod.purchaseUomSpec) || null,
        description: productDescription(prod),
        productSpec: prod.purchaseUomSpec?.trim() || null,
        uomId: prod.purchaseUomId ?? prod.uomId ?? null,
        uomName: prod.purchaseUomName ?? prod.uomName ?? null,
        orderedQty: 1,
        unitCost,
        taxRate,
        bestBefore: null,
        subtotalExTax: unitCost,
        taxAmount,
        subtotalIncTax: unitCost + taxAmount,
      },
    ])
  }

  function deleteProductLine(lineId: string) {
    setEditLines(prev => prev.filter(l => l.id !== lineId))
  }

  /**
   * 点「+ Add a product」/ 就地选品搜索框回车连续录入：插一个空草稿行并让它进入搜索态。
   * 与新建采购单页/quotation/sale order 编辑页同一套模型；草稿行 id 沿用本页原有的
   * `new-<seq>` 约定（后端 PUT 路由靠这个前缀判定"新增行"，见 route.ts isNewLine）。
   */
  function addBlankLine(opts?: { force?: boolean }) {
    // force 只给「Enter 连续录入」用：那一刻 setEditLines 还没落地，闭包里的末行仍是刚
    // 填好的那个草稿行，走守卫会把它再激活一次而不是开新行。
    const last = editLines[editLines.length - 1]
    if (!opts?.force && last && !last.productId) {
      activatePickerRef.current(last.id)
      return
    }
    newLineSeq.current += 1
    const draftId = `new-${newLineSeq.current}`
    setEditLines(prev => [
      ...prev,
      {
        id: draftId,
        sequence: (prev[prev.length - 1]?.sequence ?? 0) + 10,
        productId: '',
        productName: '',
        spec: null,
        description: null,
        productSpec: null,
        uomName: null,
        orderedQty: 1,
        unitCost: 0,
        taxRate: 0,
        bestBefore: null,
        subtotalExTax: 0,
        taxAmount: 0,
        subtotalIncTax: 0,
      },
    ])
    activatePickerRef.current(draftId)
  }

  /** 就地选品：把选中的商品填进已经插好的那一行（草稿行由 addBlankLine 建好） */
  function fillLineWithProduct(lineId: string, prod: PurchaseProduct) {
    const unitCost = Number(prod.standardPrice ?? prod.price ?? 0)
    const taxRate = purchaseTaxRateOf(prod, suppliers.find(s => s.id === editSupplierId)?.vendorTaxRate)
    setEditLines(prev => prev.map(l => {
      if (l.id !== lineId) return l
      const qty = Number(l.orderedQty) || 1
      const subtotalExTax = qty * unitCost
      const taxAmount = subtotalExTax * taxRate / 100
      return {
        ...l,
        productId: prod.id,
        productName: prod.name,
        spec: lineDescription(prod, prod.purchaseUomSpec) || null,
        description: productDescription(prod),
        productSpec: prod.purchaseUomSpec?.trim() || null,
        uomId: prod.purchaseUomId ?? prod.uomId ?? null,
        uomName: prod.purchaseUomName ?? prod.uomName ?? null,
        orderedQty: qty,
        unitCost,
        taxRate,
        subtotalExTax,
        taxAmount,
        subtotalIncTax: subtotalExTax + taxAmount,
      }
    }))
  }

  function openQuickCreate() {
    setQcName('')
    setQcCategoryId('')
    setQcUomId('')
    setQcUnitCost('')
    setShowQuickCreate(true)
  }

  async function submitQuickCreate() {
    if (!qcName.trim()) { toast.error(isEn ? 'Product name is required' : '商品名称不能为空'); return }
    setQcSubmitting(true)
    try {
      const created = await apiPost<PurchaseProduct>('/api/products/quick-create', {
        name: qcName.trim(),
        categoryId: qcCategoryId || undefined,
        purchaseUomId: qcUomId || undefined,
        unitCost: qcUnitCost ? Number(qcUnitCost) : undefined,
      })
      const uomRecord = uoms.find(u => u.id === qcUomId)
      const uomName = isEn ? (uomRecord?.name || uomRecord?.nameZh) : (uomRecord?.nameZh || uomRecord?.name)
      const withUom = { ...created, uomName: uomName ?? null, standardPrice: qcUnitCost ? Number(qcUnitCost) : 0 }
      setPurchaseProducts(prev => [withUom, ...prev])
      addProductLine(withUom)
      setShowQuickCreate(false)
      toast.success(isEn ? `Created "${created.name}" and added to purchase lines` : `已创建「${created.name}」并加入采购行`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to create product' : '创建商品失败'))
    } finally {
      setQcSubmitting(false)
    }
  }

  /**
   * 「新建商品」弹窗里发现相似商品，点「使用此商品」直接绑定这次采购到已有商品，
   * 跳过 quick-create（不产生重复商品）。
   */
  async function bindExistingProduct(candidate: { id: string; name: string }) {
    let product = purchaseProducts.find(p => p.id === candidate.id)
    if (!product) {
      try {
        product = await apiGet<PurchaseProduct>(`/api/products/${candidate.id}`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load product' : '加载商品失败'))
        return
      }
    }
    addProductLine(product)
    setShowQuickCreate(false)
    toast.success(isEn ? `Bound to existing product "${product.name}"` : `已绑定到已有商品「${product.name}」`)
  }

  async function load() {
    setLoading(true)
    try {
      const data = await apiGet<PurchaseOrder>(`/api/purchase-orders/${id}`)
      setPo(data)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to load' : '加载失败'))
    } finally {
      setLoading(false)
    }
  }

  const fetchSuppliers = useCallback(() => {
    return apiGet<{ items: Supplier[] }>('/api/customers?isVendor=true&limit=200')
      .then(d => setSuppliers(d.items ?? (d as unknown as Supplier[])))
      .catch(() => {})
  }, [])

  useEffect(() => { load() }, [id])
  useEffect(() => { fetchSuppliers() }, [fetchSuppliers])
  // ⓘ 参考成本列 + 运费分摊按基础单位换算（系数挂在 ProductSaleUom，随 purchaseProducts 一起来），
  // 查看态也要显示（不只编辑态），否则光看单不点编辑的人永远看到空白 —— 20261017 客户反馈
  useEffect(() => { loadPurchaseProducts() }, [])

  // 商品/供应商在别的 tab 改了数据后，希望回到这个已打开的页面时能看到最新数据；
  // 被编辑的采购单本身（load）不进这个刷新集合，避免冲掉正在编辑的内容，跟
  // orders/[id] 的做法一致（见 lib/hooks/use-refetch-on-focus.ts）。
  useRefetchOnFocus([loadPurchaseProducts, fetchSuppliers])

  // 编辑态内容防抖存本地：切去别的 tab 被上面的 hook 自动刷新参考数据时，
  // 不至于把正在填的内容也冲掉——保存成功/放弃编辑后清掉，不是永久草稿。
  type PurchaseOrderDraft = {
    editVendorReference?: string; editNotes: string; editOrderDate?: string; editExpectedDate: string; editFreightAmount: number; editSupplierId: string; editLines: POLine[]
  }
  const draft = useDraftAutosave<PurchaseOrderDraft>({
    userId: session?.userId,
    entity: 'purchase-order',
    recordKey: po?.id ?? id,
    enabled: editing,
    data: { editVendorReference, editNotes, editOrderDate, editExpectedDate, editFreightAmount, editSupplierId, editLines },
  })
  function restoreDraft() {
    const d = draft.restore()
    if (!d) return
    setEditNotes(d.editNotes)
    setEditVendorReference(d.editVendorReference ?? '')
    setEditOrderDate(d.editOrderDate ?? '')
    setEditExpectedDate(d.editExpectedDate)
    setEditFreightAmount(d.editFreightAmount ?? 0)
    setEditSupplierId(d.editSupplierId)
    setEditLines(d.editLines)
  }

  function startEdit() {
    if (!po) return
    loadPickerData()
    setEditNotes(po.notes ?? '')
    setEditVendorReference(po.vendorReference ?? '')
    setEditOrderDate(toInputDate(po.orderDate ?? po.createdAt))
    setEditExpectedDate(toInputDate(po.expectedDate))
    setEditFreightAmount(Number(po.freightAmount ?? 0))
    setEditSupplierId(po.supplierId)
    setEditLines(po.lines.map(l => ({ ...l })))
    setEditing(true)
  }

  function discardEdit() {
    setEditing(false)
    setEditLines([])
    draft.clearDraft()
  }

  function updateLine(idx: number, field: 'orderedQty' | 'unitCost' | 'taxRate', value: number) {
    setEditLines(prev => {
      const next = [...prev]
      const l = { ...next[idx], [field]: value }
      const qty = field === 'orderedQty' ? value : Number(next[idx].orderedQty)
      const cost = field === 'unitCost' ? value : Number(next[idx].unitCost)
      const tax = field === 'taxRate' ? value : Number(next[idx].taxRate)
      l.subtotalExTax = qty * cost
      l.taxAmount = l.subtotalExTax * tax / 100
      l.subtotalIncTax = l.subtotalExTax + l.taxAmount
      next[idx] = l
      return next
    })
  }

  async function handleSave() {
    if (!po) return
    setSaving(true)
    try {
      // 误按 Enter / 点「+ Add a product」多出的空行（还没选商品）不该提交——
      // 同新建采购单页/quotation/sale order 编辑页的处理
      const linesToSave = editLines.filter(l => l.productId)
      const updated = await apiPut<PurchaseOrder>(`/api/purchase-orders/${id}`, {
        notes: editNotes || null,
        vendorReference: editVendorReference.trim() || null,
        orderDate: editOrderDate || null,
        expectedDate: editExpectedDate || null,
        freightAmount: editFreightAmount,
        supplierId: editSupplierId,
        lines: linesToSave.map(l => ({
          id: l.id,
          ...(l.id.startsWith('new-') && { productId: l.productId, productName: l.productName }),
          orderedQty: Number(l.orderedQty),
          unitCost: Number(l.unitCost),
          taxRate: Number(l.taxRate),
          bestBefore: l.bestBefore || null,
          allocatedFreightEur: l.allocatedFreightEur ?? null,
        })),
      })
      setPo(updated)
      setEditing(false)
      setEditLines([])
      draft.clearDraft()
      toast.success(isEn ? 'Saved successfully' : '保存成功')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  // 汇率待确认时补录：直接 PUT exchangeRate，后端会连带把行/表头的欧元折算字段一起重算(20260713)
  async function handleFixRate() {
    if (!po) return
    const rate = Number(fixRateInput)
    if (!Number.isFinite(rate) || rate <= 0) {
      toast.error(isEn ? 'Please enter a valid rate' : '请输入有效的汇率'); return
    }
    setFixingRate(true)
    try {
      const updated = await apiPut<PurchaseOrder>(`/api/purchase-orders/${id}`, { exchangeRate: rate })
      setPo(updated)
      setFixRateInput('')
      toast.success(isEn ? 'Exchange rate confirmed' : '汇率已确认')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to save' : '保存失败'))
    } finally {
      setFixingRate(false)
    }
  }

  // 确认采购之后整单锁死，但预期到货日还需要在等货/已收货/已开票阶段随时补录或修正——
  // 单独走一次最小 PUT，不进整单编辑态（后端 PO_CONFIRMED_SAFE_FIELDS 放行此字段，20261015）
  async function handleUpdateExpectedDate(value: string) {
    if (!po) return
    setSavingExpectedDate(true)
    try {
      const updated = await apiPut<PurchaseOrder>(`/api/purchase-orders/${id}`, { expectedDate: value || null })
      setPo(updated)
      toast.success(isEn ? 'Expected arrival updated' : '预期到货日期已更新')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to save' : '保存失败'))
    } finally {
      setSavingExpectedDate(false)
    }
  }

  const ACTION_LABELS: Record<string, { zh: string; en: string }> = {
    send: { zh: '发送', en: 'Send' },
    confirm: { zh: '确认采购', en: 'Confirm Purchase' },
    cancel: { zh: '取消', en: 'Cancel' },
    invoice: { zh: '创建账单', en: 'Create Bill' },
    lock: { zh: '锁定', en: 'Lock' },
    approve: { zh: '审批通过', en: 'Approve' },
    reset_to_draft: { zh: '重置为草稿', en: 'Reset to Draft' },
  }

  async function handleAction(action: string) {
    if (!po || acting) return
    const label = isEn ? (ACTION_LABELS[action]?.en ?? action) : (ACTION_LABELS[action]?.zh ?? action)
    setActing(true)
    try {
      await apiPatch<PurchaseOrder>(`/api/purchase-orders/${id}`, { action })
      await load()
      toast.success(isEn ? `${label} succeeded` : `${label}成功`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? `${label} failed` : `${label}失败`))
    } finally {
      setActing(false)
    }
  }

  // 确认收货：默认按下单数量入库，可按行改成实收数量（DEV-PLAN 决策#2）
  function openReceiveModal() {
    if (!po) return
    const init: Record<string, string> = {}
    for (const l of po.lines) init[l.id] = String(Number(l.orderedQty))
    setReceiveQtys(init)
    setShowReceiveModal(true)
  }

  async function submitReceive() {
    if (!po) return
    setReceiving(true)
    try {
      const lines = po.lines.map(l => ({ lineId: l.id, qty: Number(receiveQtys[l.id] ?? 0) }))
      await apiPatch<PurchaseOrder>(`/api/purchase-orders/${id}`, { action: 'receive', lines })
      await load()
      setShowReceiveModal(false)
      toast.success(isEn ? 'Receipt confirmed' : '确认收货成功')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to confirm receipt' : '确认收货失败'))
    } finally {
      setReceiving(false)
    }
  }

  // 退货/修正数量：默认全部填 0，采购员按实际退货量填写
  function openReturnModal() {
    if (!po) return
    const init: Record<string, string> = {}
    for (const l of po.lines) init[l.id] = ''
    setReturnQtys(init)
    setReturnReason('')
    setShowReturnModal(true)
  }

  async function submitReturn() {
    if (!po) return
    const lines = po.lines
      .map(l => ({ productId: l.productId, qty: Number(returnQtys[l.id] ?? 0) }))
      .filter(l => l.productId && l.qty > 0)
    if (lines.length === 0) {
      toast.error(isEn ? 'Please enter a return quantity for at least one line' : '请至少填写一行退货数量')
      return
    }
    setReturning(true)
    try {
      await apiPost(`/api/purchase-orders/${id}/return`, { lines, reason: returnReason || undefined })
      await load()
      setShowReturnModal(false)
      toast.success(isEn ? 'Return recorded' : '退货已记录')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed to record return' : '退货失败'))
    } finally {
      setReturning(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-400">
        <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: PURPLE }} />
        {isEn ? 'Loading...' : '加载中...'}
      </div>
    )
  }

  if (!po) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-400 mb-4">{isEn ? 'Purchase order not found' : '采购单不存在'}</p>
        <button onClick={() => router.push(`${prefix}/classic/operator/purchases`)}
          className="px-4 py-2 border border-gray-300 rounded text-sm text-gray-600 hover:bg-gray-50">
          {isEn ? 'Back to list' : '返回列表'}
        </button>
      </div>
    )
  }

  const isEditable = po.status === 'DRAFT' || po.status === 'SENT'
  const isLocked = po.status === 'LOCKED'
  const isCancelled = po.status === 'CANCELLED'
  const displayLines = editing ? editLines : po.lines

  const lineSubtotalExTax = displayLines.reduce((s, l) => s + Number(l.subtotalExTax), 0)
  const lineSubtotalIncTax = displayLines.reduce((s, l) => s + Number(l.subtotalIncTax), 0)
  const totalOrderedQty = displayLines.reduce((s, l) => s + Number(l.orderedQty), 0)
  const freightAmount = editing ? editFreightAmount : Number(po.freightAmount ?? 0)
  // ⛔ 运费不计入「合计」——这个数字要跟供应商报价单的合计核对，加了运费就对不上了(20261018)
  const subtotalExTax = lineSubtotalExTax
  const totalTax = displayLines.reduce((s, l) => s + Number(l.taxAmount), 0)
  const totalIncTax = lineSubtotalIncTax
  // 分摊运费预览：跟服务端 confirm 分支用同一套算法（排除 SERVICE 行、尊重手动覆盖、
  // 按数量比例分给剩余行），让页面上看到的数字跟点 Confirm 之后真正落库的数字一致（20261017）。
  // 分摊/落库字段（allocatedFreightEur 等）全是欧元口径，非欧元供应商单必须先把 freightAmount
  // 折成欧元再喂给同一套算法，否则跟服务端（po.freightAmountEur ?? po.freightAmount）各算各的，
  // 两边都「自洽」但数字不一致，手动覆盖还会被按错误汇率曲解（code-review 发现，20261017 补）。
  const freightAmountEur = Math.round(freightAmount * Number(po.exchangeRate ?? 1) * 100) / 100
  const freightAllocationPreview = computeFreightAllocationForConfirm(
    freightAmountEur,
    displayLines.map((l) => {
      const prod = purchaseProducts.find(p => p.id === l.productId)
      return {
        id: l.id,
        orderedQty: l.orderedQty,
        // ⛔ 不能用全局 Uom.factor —— 换算系数挂在 ProductSaleUom 上，同名 CASE 不同商品箱规不同
        uomFactor: l.uomId ? prod?.saleUoms?.find(su => su.uomId === l.uomId)?.factor ?? 1 : 1,
        isService: prod?.type === 'SERVICE',
        manualAllocatedFreightEur: l.allocatedFreightEur,
      }
    }),
  )
  const allocatedFreightById = new Map(freightAllocationPreview.map(a => [a.id, a.allocatedFreightEur]))
  const allocatedFreightTotal = Math.round(freightAllocationPreview.reduce((s, a) => s + a.allocatedFreightEur, 0) * 100) / 100
  const freightAllocationDiff = Math.round((allocatedFreightTotal - freightAmountEur) * 100) / 100
  const freightAllocationMismatch = freightAmountEur > 0 && Math.abs(freightAllocationDiff) > 0.01

  // Confirm 按钮点击前的客户端同款校验（20261017）：服务端仍是最终把关，这里只是让用户不用
  // 点了才被 409 弹回来——分摊合计对不上就直接提示，不发请求
  function confirmFreightAllocationOk(): boolean {
    if (!freightAllocationMismatch) return true
    toast.error(isEn
      ? `Allocated freight total (€${allocatedFreightTotal.toFixed(2)}) does not match freight amount (€${freightAmountEur.toFixed(2)}), diff €${freightAllocationDiff.toFixed(2)}`
      : `分摊运费合计（€${allocatedFreightTotal.toFixed(2)}）与运费总额（€${freightAmountEur.toFixed(2)}）不一致，差额 €${freightAllocationDiff.toFixed(2)}，请检查手动调整的分摊金额后再确认`)
    return false
  }

  const supplier = suppliers.find(s => s.id === (editing ? editSupplierId : po.supplierId))
  const supplierName = supplier?.name ?? po.supplierName ?? po.supplierId

  const latestBill = [...(po.bills ?? [])].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]

  // 收货/退货快捷查看（smart button）的三类数据：
  //   入库   —— 本页「确认收货」动作：真正加库存的那一步，不建单据表，只留一条 ActionLog（「确认收货 」开头）
  //   退货   —— 「退货/修正数量」动作：同样只留一条 ActionLog（「采购退货 」开头）
  //   到货登记 —— 库存「收货」工作台建的 GoodsReceipt：记到货时间/质检，本身不动库存
  // 按钮上的数字是「入库」次数（对应 Odoo 的 Receipt），到货登记与退货在弹窗里一并列出
  const newestFirst = (a: ActivityLogEntry, b: ActivityLogEntry) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  const stockInLogs = (po.activityLog ?? []).filter(l => l.detail?.startsWith('确认收货 ')).sort(newestFirst)
  const returnLogs = (po.activityLog ?? []).filter(l => l.detail?.startsWith('采购退货 ')).sort(newestFirst)
  const goodsReceiptCount = po.receipts?.length ?? 0
  // 下单确认之后才会有收货；草稿/询价/取消阶段没东西可看，就不摆这个入口
  const showReceiptsButton = stockInLogs.length > 0 || goodsReceiptCount > 0 || returnLogs.length > 0
    || ['CONFIRMED', 'RECEIVED', 'INVOICED', 'LOCKED'].includes(po.status)

  const timeline = [
    ...(po.activityLog ?? []).map(l => ({ id: l.id, text: l.detail || l.action, at: l.createdAt })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())

  const inputCls = 'border border-gray-300 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100'
  const numInputCls = 'border border-gray-300 rounded px-1.5 py-0.5 text-sm bg-white text-right focus:outline-none focus:border-blue-400 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'

  return (
    <div className="flex flex-col h-full overflow-auto" style={{ background: '#f3f4f5' }}>

      {/* ── Top control bar ─────────────────────────────── */}
      <div className="bg-white border-b border-gray-200 flex-shrink-0">

        {/* Row 1: breadcrumb */}
        <div className="px-6 pt-3 pb-1 text-xs text-gray-500">
          <button
            onClick={() => router.push(`${prefix}/classic/operator/purchases`)}
            className="hover:underline"
            style={{ color: PURPLE }}
          >
            {isEn ? 'Request for Quotation' : '询价单'}
          </button>
          <span className="mx-1 text-gray-400">/</span>
          <span className="text-gray-900 font-bold text-sm">{po.name}</span>
        </div>

        {/* Row 2: action buttons + pagination */}
        <div className="px-6 py-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            {!editing ? (
              <>
                <button
                  onClick={startEdit}
                  disabled={!isEditable || isCancelled || isLocked}
                  className="h-7 px-3 text-sm rounded border disabled:opacity-40 font-medium"
                  style={{ borderColor: '#d0d5dd', color: DARK, background: 'white' }}
                  onMouseEnter={e => { if (isEditable && !isCancelled && !isLocked) (e.currentTarget as HTMLElement).style.background = '#f5f5f5' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'white' }}
                >
                  {isEn ? 'Edit' : '编辑'}
                </button>
                <button
                  onClick={() => { router.push(`${prefix}/classic/operator/purchases/new`) }}
                  className="h-7 px-3 text-sm rounded border font-medium hover:bg-gray-50"
                  style={{ borderColor: '#d0d5dd', color: DARK }}
                >
                  {isEn ? 'New' : '新建'}
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="h-7 px-3 text-sm rounded border disabled:opacity-40 font-medium"
                  style={{ borderColor: PURPLE, color: PURPLE, background: 'white' }}
                >
                  {saving ? (isEn ? 'Saving…' : '保存中…') : (isEn ? 'Save' : '手动保存')}
                </button>
                <button
                  onClick={discardEdit}
                  className="h-7 px-3 text-sm rounded border font-medium hover:bg-gray-50"
                  style={{ borderColor: '#d0d5dd', color: DARK }}
                >
                  {isEn ? 'Discard' : '放弃'}
                </button>
              </>
            )}
            <div className="w-px h-4 bg-gray-300 mx-1" />
            <button onClick={() => openPurchaseOrderPdf(po.id, isEn)}
              className="h-7 px-3 text-sm rounded border font-medium hover:bg-gray-50 flex items-center gap-1"
              style={{ borderColor: '#d0d5dd', color: DARK }}>
              {isEn ? 'Print' : '打印'}
            </button>
            <button onClick={async () => {
              if (!confirm(isEn ? 'Duplicate this purchase order as a draft?' : '复制此采购单为新草稿？')) return
              try {
                const created = await apiPost<PurchaseOrder>('/api/purchase-orders', {
                  supplierId: po.supplierId, currency: po.currency, exchangeRate: po.exchangeRate,
                  freightAmount: po.freightAmount ?? 0, expectedDate: po.expectedDate,
                  notes: po.notes, lines: po.lines.map(l => ({ productId: l.productId, productName: l.productName,
                    uomId: (l as POLine & { uomId?: string | null }).uomId, uomName: l.uomName,
                    orderedQty: l.orderedQty, unitCost: l.unitCost, taxRate: l.taxRate, bestBefore: l.bestBefore }))
                })
                router.push(`${prefix}/classic/operator/purchases/${created.id}`)
              } catch (e) { toast.error(e instanceof Error ? e.message : (isEn ? 'Duplicate failed' : '复制失败')) }
            }} className="h-7 px-3 text-sm rounded border font-medium hover:bg-gray-50" style={{ borderColor: '#d0d5dd', color: DARK }}>
              {isEn ? 'Duplicate' : '复制'}
            </button>
            <button onClick={async () => {
              if (!confirm(isEn ? 'Delete this purchase order permanently?' : '确定永久删除此采购单？')) return
              try {
                const res = await fetch(`/api/purchase-orders/${po.id}`, { method: 'DELETE', headers: authHeaders() })
                if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error || `HTTP ${res.status}`) }
                router.push(`${prefix}/classic/operator/purchases`)
              }
              catch (e) { toast.error(e instanceof Error ? e.message : (isEn ? 'Delete failed' : '删除失败')) }
            }} className="h-7 px-3 text-sm rounded border font-medium text-red-600 hover:bg-red-50" style={{ borderColor: '#fecaca' }}>
              {isEn ? 'Delete' : '删除'}
            </button>
          </div>

          {/* 上一张 / 下一张：顺序与列表一致；编辑中不允许跳走(未保存的改动会丢) */}
          <div className="flex items-center gap-1">
            {navIdx >= 0 && (
              <span className="text-xs text-gray-500 mr-1 tabular-nums">{navIdx + 1} / {navIds.length}</span>
            )}
            {[
              { label: '‹', target: navIdx > 0 ? navIds[navIdx - 1] : null, title: isEn ? 'Previous' : '上一张' },
              { label: '›', target: navIdx >= 0 && navIdx < navIds.length - 1 ? navIds[navIdx + 1] : null, title: isEn ? 'Next' : '下一张' },
            ].map(b => (
              <button
                key={b.label}
                title={editing ? (isEn ? 'Save or discard your changes first' : '请先保存或放弃修改') : b.title}
                disabled={!b.target || editing}
                onClick={() => { if (b.target && !editing) router.push(`${prefix}/classic/operator/purchases/${b.target}`) }}
                className="w-6 h-6 rounded border border-gray-200 hover:bg-gray-50 flex items-center justify-center text-gray-500 text-xs disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>

        {/* Row 3: status action buttons */}
        {!editing && (
          <div className="px-6 py-2.5 border-t border-gray-100 flex items-center gap-2">
            {po.status === 'DRAFT' && (
              <>
                <button onClick={() => handleAction('send')} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: PURPLE }}>
                  {isEn ? 'Send by Email' : '发送邮件'}
                </button>
                <button onClick={() => openPurchaseOrderPdf(po.id, isEn)}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
                  {isEn ? 'Print RFQ' : '打印询价单'}
                </button>
                <button onClick={() => { if (confirmFreightAllocationOk()) handleAction('confirm') }} disabled={acting || po.exchangeRatePending}
                  title={po.exchangeRatePending ? (isEn ? 'Exchange rate pending, please fill it in below first' : '汇率待确认，请先在下方补充汇率') : undefined}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                  {isEn ? 'Confirm Purchase' : '确认采购'}
                </button>
                <button onClick={() => { if (confirm(isEn ? 'Cancel this purchase order?' : '确定取消此采购单？')) handleAction('cancel') }} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50">
                  {isEn ? 'Cancel' : '取消'}
                </button>
              </>
            )}
            {po.status === 'SENT' && (
              <>
                <button onClick={() => { if (confirmFreightAllocationOk()) handleAction('confirm') }} disabled={acting || po.exchangeRatePending}
                  title={po.exchangeRatePending ? (isEn ? 'Exchange rate pending, please fill it in below first' : '汇率待确认，请先在下方补充汇率') : undefined}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: PURPLE }}>
                  {isEn ? 'Confirm Purchase' : '确认采购'}
                </button>
                <button onClick={() => { if (confirm(isEn ? 'Cancel this purchase order?' : '确定取消此采购单？')) handleAction('cancel') }} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50">
                  {isEn ? 'Cancel' : '取消'}
                </button>
              </>
            )}
            {po.status === 'CONFIRMED' && (
              <>
                <button
                  onClick={openReceiveModal}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: PURPLE }}>
                  {isEn ? 'Confirm Receipt' : '确认收货'}
                </button>
                <button onClick={() => { if (confirm(isEn ? 'Cancel this purchase order?' : '确定取消此采购单？')) handleAction('cancel') }} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50">
                  {isEn ? 'Cancel' : '取消'}
                </button>
              </>
            )}
            {po.status === 'RECEIVED' && (
              <>
                <button onClick={() => handleAction('invoice')} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: PURPLE }}>
                  {isEn ? 'Create Bill' : '创建账单'}
                </button>
                {/* 已收货/已开票的单也可能是重复单/录错单，后端 ALLOWED_TRANSITIONS 本就允许
                    RECEIVED/INVOICED → CANCELLED，之前两个状态分支只是没放按钮，导致这种情况下
                    用户点 Delete 被拒后无路可走(20261018 客户反馈)。收过货的单取消不回滚成本，
                    详见下方 PATCH 路由里 po.status === 'CONFIRMED' 才回滚那段注释。 */}
                <button onClick={() => { if (confirm(isEn ? 'Cancel this purchase order?' : '确定取消此采购单？')) handleAction('cancel') }} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50">
                  {isEn ? 'Cancel' : '取消'}
                </button>
              </>
            )}
            {po.status === 'INVOICED' && (
              <>
                <button onClick={() => handleAction('lock')} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: PURPLE }}>
                  🔒 {isEn ? 'Lock' : '锁定'}
                </button>
                <button onClick={() => { if (confirm(isEn ? 'Cancel this purchase order?' : '确定取消此采购单？')) handleAction('cancel') }} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50">
                  {isEn ? 'Cancel' : '取消'}
                </button>
              </>
            )}
            {po.status === 'TO_APPROVE' && (
              <>
                <button onClick={() => { if (confirmFreightAllocationOk()) handleAction('approve') }} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: '#16a34a' }}>
                  ✓ {isEn ? 'Approve' : '审批通过'}
                </button>
                <button onClick={() => { if (confirm(isEn ? 'Cancel this purchase order?' : '确定取消此采购单？')) handleAction('cancel') }} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50">
                  {isEn ? 'Cancel' : '取消'}
                </button>
              </>
            )}
            {['CONFIRMED', 'RECEIVED', 'INVOICED'].includes(po.status) && (
              <button onClick={openReturnModal} disabled={acting}
                className="h-8 px-4 text-sm font-medium rounded border border-orange-300 bg-white text-orange-700 hover:bg-orange-50 disabled:opacity-50">
                {isEn ? 'Return / Adjust Qty' : '退货/修正数量'}
              </button>
            )}
            {isLocked && (
              <span className="text-sm font-medium px-3 py-1 rounded flex items-center gap-1.5" style={{ background: '#f0fdf4', color: '#166534' }}>
                🔒 {isEn ? 'Locked — no changes allowed' : '已锁定 — 不可变更'}
              </span>
            )}
            {isCancelled && (
              <>
                <button onClick={() => handleAction('reset_to_draft')} disabled={acting}
                  className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
                  style={{ background: PURPLE }}>
                  {isEn ? 'Reset to Draft' : '重置为草稿'}
                </button>
                <span className="text-sm font-medium px-3 py-1 rounded" style={{ background: '#fef2f2', color: '#dc2626' }}>
                  {isEn ? 'This purchase order has been cancelled' : '此采购单已取消'}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Status progress bar ──────────────────────────── */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-end flex-shrink-0">
        <OdooStatusBar status={po.status} isEn={isEn} />
      </div>

      {/* ── Main form card ───────────────────────────────── */}
      <div className="flex-1 p-6 overflow-auto">
        {editing && draft.pendingDraft && (
          <DraftRestoreBanner onRestore={restoreDraft} onDiscard={draft.discard} />
        )}
        {(latestBill || showReceiptsButton) && (
          <div className="mb-4 flex items-stretch gap-2">
            {latestBill ? (
              <div
                className="flex-1 flex items-center gap-2 px-4 py-2.5 rounded text-sm"
                style={{ background: '#e5f1e9', color: '#2e7d4f' }}
              >
                {(() => {
                  // 账单号做成超链接：点进供应商账单页并直接打开这张账单（?bill= 深链）
                  const billLink = (
                    <Link href={`${prefix}/classic/finance/vendor-bills?bill=${latestBill.id}`}
                      className="font-bold underline underline-offset-2 hover:opacity-80">
                      {latestBill.name}
                    </Link>
                  )
                  return isEn
                    ? <>✓ Vendor bill {billLink} generated ({latestBill.totalIncTax.toFixed(2)}) · Finance role notified</>
                    : <>✓ 已生成供应商账单 {billLink}（{latestBill.totalIncTax.toFixed(2)}）· 已通知财务角色</>
                })()}
              </div>
            ) : <div className="flex-1" />}
            {showReceiptsButton && (
              <button
                onClick={() => setShowReceiptsModal(true)}
                className="flex items-center gap-2.5 px-4 py-1.5 rounded border border-gray-200 bg-white hover:bg-gray-50 text-left"
                title={isEn ? 'View receipts & returns' : '查看收货/退货记录'}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="#4b5563" aria-hidden="true">
                  <path d="M3 5h11v9H3zM14 8h4l3 3.5V14h-7zM6.5 18.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6zM17.5 18.5a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6zM3 14h18v1.5H3z" />
                </svg>
                <span className="flex flex-col leading-tight">
                  <span className="text-sm font-semibold text-gray-800 tabular-nums">{stockInLogs.length}</span>
                  <span className="text-xs text-gray-600">
                    {isEn ? (stockInLogs.length === 1 ? 'Receipt' : 'Receipts') : '收货'}
                    {returnLogs.length > 0 && (
                      <span className="text-red-600">{isEn ? ` · ${returnLogs.length} return${returnLogs.length === 1 ? '' : 's'}` : ` · ${returnLogs.length} 退货`}</span>
                    )}
                  </span>
                </span>
              </button>
            )}
          </div>
        )}
        <div className="bg-white rounded border border-gray-200 shadow-sm">

          {/* Form header */}
          <div className="px-6 pt-5 pb-4">
            <div className="grid grid-cols-2 gap-10">

              {/* Left column */}
              <div className="space-y-3">
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Vendor' : '供应商'}</label>
                  {editing ? (
                    <SearchableDropdown
                      className="flex-1"
                      options={suppliers.map(s => ({ value: s.id, label: s.name }))}
                      value={editSupplierId}
                      onChange={setEditSupplierId}
                      searchPlaceholder={isEn ? 'Search vendor…' : '搜索供应商…'}
                    />
                  ) : (
                    <span className="text-sm font-medium" style={{ color: PURPLE }}>{supplierName}</span>
                  )}
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Vendor Reference' : '供应商参考'}</label>
                  {editing ? (
                    <input type="text" value={editVendorReference} onChange={e => setEditVendorReference(e.target.value)} placeholder={isEn ? "Vendor's order reference" : '供应商的订单参考号'} className={`flex-1 ${inputCls}`} />
                  ) : (
                    <span className="text-sm text-gray-700">{po.vendorReference || '—'}</span>
                  )}
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Payment Terms' : '付款条款'}</label>
                  <span className="text-sm text-gray-700">{supplier?.supplierPaymentTerm || '—'}</span>
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Currency' : '货币'}</label>
                  <span className="text-sm text-gray-700">{po.currency}</span>
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Freight' : '运费'}</label>
                  {editing ? <input type="number" min="0" step="0.01" value={editFreightAmount} onChange={e => setEditFreightAmount(Number(e.target.value))} className={`${numInputCls} w-32`} /> : <span className="text-sm text-gray-700">{po.currency} {Number(po.freightAmount ?? 0).toFixed(2)}</span>}
                </div>
              </div>

              {/* Right column */}
              <div className="space-y-3">
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Order Date' : '订单日期'}</label>
                  {editing ? (
                    <DatePicker value={editOrderDate} onChange={setEditOrderDate} className={inputCls} style={{ width: '180px' }} />
                  ) : (
                    <span className="text-sm text-gray-800">{formatDateOnly(po.orderDate ?? po.createdAt)}</span>
                  )}
                </div>
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Expected Arrival' : '预期到货日期'}</label>
                  {editing ? (
                    <DatePicker
                      value={editExpectedDate}
                      onChange={setEditExpectedDate}
                      className={inputCls}
                      style={{ width: '180px' }}
                    />
                  ) : ['CONFIRMED', 'RECEIVED', 'INVOICED'].includes(po.status) ? (
                    <DatePicker
                      value={toInputDate(po.expectedDate)}
                      onChange={handleUpdateExpectedDate}
                      disabled={savingExpectedDate}
                      className={inputCls}
                      style={{ width: '180px' }}
                    />
                  ) : (
                    <span className="text-sm text-gray-800">{formatDateOnly(po.expectedDate) || '—'}</span>
                  )}
                </div>
                {['CONFIRMED', 'RECEIVED', 'INVOICED', 'LOCKED'].includes(po.status) && (
                  <div className="flex items-center min-h-[32px]">
                    <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Arrived Date' : '到货日期'}</label>
                    <span className="text-sm text-gray-800">
                      {formatDateOnly(po.lastArrivedAt) || (isEn ? 'Not yet arrived' : '尚未到货')}
                    </span>
                    {/* 分批到货：首批与最近一批不是同一天时额外标出，方便看出"拖了多久收齐" */}
                    {po.firstArrivedAt && po.lastArrivedAt && po.firstArrivedAt !== po.lastArrivedAt && (
                      <span className="text-xs text-gray-400 ml-2">
                        {isEn ? `first ${formatDateOnly(po.firstArrivedAt)}` : `首批 ${formatDateOnly(po.firstArrivedAt)}`}
                      </span>
                    )}
                  </div>
                )}
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Purchase Rep' : '采购代表'}</label>
                  <span className="text-sm text-gray-400">—</span>
                </div>
              </div>
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex border-t border-b border-gray-200 px-6 bg-gray-50">
            {(['products', 'other'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className="px-5 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px"
                style={{
                  borderBottomColor: activeTab === tab ? PURPLE : 'transparent',
                  color: activeTab === tab ? PURPLE : '#6b7280',
                  background: 'transparent',
                }}
              >
                {tab === 'products' ? (isEn ? 'Products' : '产品') : (isEn ? 'Other Info' : '其他信息')}
              </button>
            ))}
          </div>

          {/* ── Products tab ── */}
          {activeTab === 'products' && (
            <div>
              {/* 分摊运费校验横幅（20261017）：确认前就能看出"分摊运费合计"跟"运费总额"是否对得上，
                  不用等点 Confirm 被服务端 409 弹回来才知道 */}
              {freightAmountEur > 0 && !isLocked && !isCancelled && po.status !== 'RECEIVED' && po.status !== 'INVOICED' && (
                <div
                  className="mb-2 px-3 py-2 rounded text-xs flex items-center justify-between"
                  style={freightAllocationMismatch
                    ? { background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca' }
                    : { background: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0' }}
                >
                  <span>
                    {/* 分摊字段全是欧元口径，这里恒显示 €，不跟 po.currency 走（非欧元单两边
                        都标本币符号会让人误以为单位一致，实际是两个不同的数）*/}
                    {isEn ? 'Allocated freight total: ' : '分摊运费合计：'}
                    <strong>€{allocatedFreightTotal.toFixed(2)}</strong>
                    {isEn ? ' / Freight amount: ' : ' / 运费总额：'}
                    <strong>€{freightAmountEur.toFixed(2)}</strong>
                  </span>
                  {freightAllocationMismatch && (
                    <span>
                      {isEn ? `Diff ${freightAllocationDiff.toFixed(2)} — adjust manual overrides before confirming` : `差额 ${freightAllocationDiff.toFixed(2)} — 请调整手动分摊金额后再确认`}
                    </span>
                  )}
                </div>
              )}
              {/* 就地选品 + Tab/Enter 走位与新建采购单页/quotation/sale order 共用同一套
                  （OrderLineEditor + useInlineProductPicker + lineFieldKeyHandler）——此前编辑页
                  是独立手写表格，Tab/Enter 行为对不上新建页，客户报过后收口到这里 */}
              <OrderLineEditor
                lines={displayLines}
                editing={editing}
                products={purchaseProducts}
                onDeleteLine={lineId => deleteProductLine(lineId)}
                onPickProduct={fillLineWithProduct}
                onPickByEnter={() => addBlankLine({ force: true })}
                onPickByTab={lineId => {
                  // 没有可编辑的描述框，Tab 选完商品后把焦点交给数量——本行第一个该填的字段
                  setTimeout(() => {
                    document.querySelector<HTMLInputElement>(`[data-qty-line="${lineId}"]`)?.focus()
                  }, 50)
                }}
                onAddBlankLine={editing ? addBlankLine : undefined}
                addBlankLineText={isEn ? '+ Add a product' : '+ 添加商品'}
                pickerTexts={{
                  empty: isEn ? 'No matching products' : '没有匹配商品',
                  placeholder: isEn ? 'Click to select product…' : '点击选择商品…',
                  search: isEn ? 'Search product…' : '搜索商品…',
                }}
                onReady={handleEditorReady}
                emptyColSpan={13}
                emptyMessage={isEn ? 'No lines yet' : '暂无明细行'}
                tableClassName="w-full text-sm border-collapse"
                renderHeaders={() => (
                  <tr style={{ background: '#f8f8f8', borderBottom: '1px solid #e8e8e8' }}>
                    <th className="w-8 px-2 py-2.5" />
                    <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">{isEn ? 'Product' : '商品'}</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">{isEn ? 'Description' : '描述'}</th>
                    <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">{isEn ? 'Qty' : '数量'}</th>
                    <th className="px-4 py-2.5 text-left font-medium text-gray-600 text-xs">{isEn ? 'UoM' : '单位'}</th>
                    <th className="w-8 px-2 py-2.5 text-center font-medium text-gray-600 text-xs" title={isEn ? 'Reference cost — last known cost price, not saved on this order' : '参考成本价——上次收货成本，仅供对比，不写入本单'}>
                      ⓘ
                    </th>
                    <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs" title={isEn ? 'Freight per ordered unit for this line. Defaults to freight amount ÷ total ordered qty; type to override.' : '本行每单位（箱）运费，默认是运费总额 ÷ 总箱数，可手动改成别的数'}>
                      {isEn ? 'Per Case Freight' : '每箱运费'}
                    </th>
                    <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs" title={isEn ? 'Allocated freight = per case freight × ordered qty' : '分摊运费 = 每箱运费 × 数量，由左边一栏算出，不可直接编辑'}>
                      {isEn ? 'Alloc. Freight' : '分摊运费'}
                    </th>
                    <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">{isEn ? 'Unit Price' : '单价'}</th>
                    <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">{isEn ? 'Tax %' : '税率%'}</th>
                    <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs">Best Before</th>
                    <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs" title={isEn ? 'Quantity × unit price, ex tax' : '数量 × 单价（不含税）'}>{isEn ? 'Untaxed Total' : '税前小计'}</th>
                    <th className="px-4 py-2.5 text-right font-medium text-gray-600 text-xs" title={isEn ? 'Untaxed total incl. tax' : '税前小计含税后的金额'}>{isEn ? 'Subtotal' : '小计'}</th>
                  </tr>
                )}
                defaultRowCls="border-b border-gray-100 hover:bg-blue-50/30 transition-colors"
                renderRow={(l, i, { deleteButton, focusSearch, productCell }) => {
                  const isLast = i === displayLines.length - 1
                  const isServiceLine = purchaseProducts.find(p => p.id === l.productId)?.type === 'SERVICE'
                  const allocatedFreight = allocatedFreightById.get(l.id) ?? 0
                  const lineQty = Number(l.orderedQty) || 0
                  // 每箱运费 = 分摊运费 / 数量；手动覆盖过 alloc freight 时同样按当前数量反推显示，
                  // 编辑这一栏改的还是底层的 allocatedFreightEur（20261017 客户要求把编辑单元换成"每箱运费"）
                  const perCaseFreight = lineQty > 0 ? allocatedFreight / lineQty : 0
                  const perCaseFreightOverride = l.allocatedFreightEur != null && lineQty > 0
                    ? Number(l.allocatedFreightEur) / lineQty
                    : null
                  return (
                    <>
                      <td className="px-2 py-2.5 text-center">{deleteButton}</td>
                      <td className="px-4 py-2.5 font-medium" style={{ color: PURPLE }}>
                        {editing
                          ? productCell({ lineId: l.id, productName: l.productName, readOnly: !l.id.startsWith('new-') })
                          : l.productName}
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 text-xs max-w-[180px] truncate">{l.spec || ''}</td>
                      <td className="px-4 py-2.5 text-right">
                        {editing ? (
                          <input type="number" step="0.001" min="0"
                            data-qty-line={l.id}
                            className={numInputCls} style={{ width: '80px' }}
                            value={Number(l.orderedQty)}
                            onChange={e => updateLine(i, 'orderedQty', Number(e.target.value))}
                            onFocus={e => e.target.select()}
                            onKeyDown={lineFieldKeyHandler({ onNextRow: focusSearch })} />
                        ) : (
                          <span className="text-gray-800">{Number(l.orderedQty).toFixed(3)}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 text-xs">{l.uomName || '—'}</td>
                      <td className="px-2 py-2.5 text-center">
                        {(() => {
                          const refCost = purchaseProducts.find(p => p.id === l.productId)?.standardPrice
                          if (refCost == null) return <span className="text-gray-300 text-xs">—</span>
                          return (
                            <span
                              className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] text-gray-400 border border-gray-300 cursor-help"
                              title={isEn ? `Reference cost: ${Number(refCost).toFixed(2)}` : `历史参考成本：${Number(refCost).toFixed(2)}`}
                            >
                              ⓘ
                            </span>
                          )
                        })()}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {isServiceLine ? (
                          <span className="text-gray-400 text-xs">—</span>
                        ) : editing ? (
                          <input type="number" step="0.01"
                            className={numInputCls} style={{ width: '80px' }}
                            placeholder={perCaseFreight.toFixed(2)}
                            value={perCaseFreightOverride ?? ''}
                            onChange={e => {
                              const raw = e.target.value
                              setEditLines(prev => {
                                const next = [...prev]
                                const qty = Number(next[i].orderedQty) || 0
                                next[i] = {
                                  ...next[i],
                                  allocatedFreightEur: raw === '' ? null : Math.round(Number(raw) * qty * 100) / 100,
                                }
                                return next
                              })
                            }}
                            onFocus={e => e.target.select()}
                            onKeyDown={lineFieldKeyHandler({ onNextRow: focusSearch })} />
                        ) : (
                          <span className="text-gray-800">{perCaseFreight.toFixed(2)}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {isServiceLine ? (
                          <span className="text-gray-400 text-xs">—</span>
                        ) : (
                          <span className="text-gray-800">{allocatedFreight.toFixed(2)}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {editing ? (
                          <input type="number" step="0.01" min="0"
                            className={numInputCls} style={{ width: '90px' }}
                            value={Number(l.unitCost)}
                            onChange={e => updateLine(i, 'unitCost', Number(e.target.value))}
                            onFocus={e => e.target.select()}
                            onKeyDown={lineFieldKeyHandler({ onNextRow: focusSearch })} />
                        ) : (
                          <span className="text-gray-800">{Number(l.unitCost).toFixed(2)}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {editing ? (
                          <input type="number" step="0.1" min="0"
                            className={numInputCls} style={{ width: '60px' }}
                            value={Number(l.taxRate ?? 0)}
                            onChange={e => updateLine(i, 'taxRate', Number(e.target.value))}
                            onKeyDown={lineFieldKeyHandler({ onNextRow: focusSearch })} />
                        ) : (
                          <span className="text-gray-600 text-xs">{Number(l.taxRate ?? 0).toFixed(1)}%</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {editing ? (
                          <DatePicker
                            className={`${numInputCls} text-xs`} style={{ width: '120px' }}
                            clearable={false}
                            value={toInputDate(l.bestBefore)}
                            onChange={v => {
                              setEditLines(prev => {
                                const next = [...prev]
                                next[i] = { ...next[i], bestBefore: v || null }
                                return next
                              })
                            }}
                            onKeyDown={lineFieldKeyHandler({ onNextRow: focusSearch, isLastFieldOfLastRow: isLast })} />
                        ) : (
                          <span className="text-gray-600 text-xs">{formatDateOnly(l.bestBefore) || '—'}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right text-gray-700">
                        {Number(l.subtotalExTax).toFixed(2)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-gray-800">
                        {Number(l.subtotalIncTax).toFixed(2)}
                      </td>
                    </>
                  )
                }}
                footerRow={
                  <tr style={{ background: '#fafafa', borderTop: '2px solid #e5e5e5' }}>
                    <td colSpan={3} />
                    <td className="px-4 py-2 text-right font-semibold text-gray-700 text-xs">{totalOrderedQty.toFixed(3)}</td>
                    <td colSpan={2} />
                    <td />
                    <td className="px-4 py-2 text-right font-semibold text-gray-700 text-xs">{allocatedFreightTotal.toFixed(2)}</td>
                    <td colSpan={2} />
                    <td />
                    <td className="px-4 py-2 text-right font-semibold text-gray-700 text-xs">{lineSubtotalExTax.toFixed(2)}</td>
                    <td className="px-4 py-2 text-right font-semibold text-gray-700 text-xs">{lineSubtotalIncTax.toFixed(2)}</td>
                  </tr>
                }
                footer={
                  editing ? (
                    <div className="px-4 py-2 border-t border-gray-100">
                      <button
                        onClick={openQuickCreate}
                        className="text-xs whitespace-nowrap hover:underline"
                        style={{ color: PURPLE }}
                      >
                        {isEn ? "Can't find it? Create product" : '找不到？新建商品'}
                      </button>
                    </div>
                  ) : undefined
                }
              />

              {/* Totals */}
              <div className="border-t border-gray-200 px-6 py-5 flex justify-end">
                <div style={{ minWidth: '280px' }}>
                  <div className="flex justify-between py-1 text-sm">
                    <span className="text-gray-500">{isEn ? 'Untaxed Amount' : '税前金额'}</span>
                    <span className="text-gray-800 font-medium">{subtotalExTax.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between py-1 text-sm">
                    <span className="text-gray-500">{isEn ? 'Tax' : '税额'}</span>
                    <span className="text-gray-800">{totalTax.toFixed(2)}</span>
                  </div>
                  <div className="border-t border-gray-300 mt-1 pt-2 flex justify-between">
                    <span className="text-sm font-semibold" style={{ color: DARK }}>{isEn ? 'Total' : '合计'}</span>
                    <span className="text-base font-bold" style={{ color: DARK }}>{po.currency} {totalIncTax.toFixed(2)}</span>
                  </div>
                  {po.currency !== 'EUR' && (
                    <div className="flex justify-between py-1 text-sm">
                      <span className="text-gray-400">{isEn ? `≈ EUR (rate ${po.exchangeRate ?? '—'})` : `≈ 折合欧元（汇率 ${po.exchangeRate ?? '—'}）`}</span>
                      <span className={po.exchangeRatePending ? 'text-red-500 font-medium' : 'text-gray-500'}>
                        {po.exchangeRatePending ? (isEn ? '🔴 pending' : '🔴 待确认') : `€${Number(po.totalIncTaxEur ?? 0).toFixed(2)}`}
                      </span>
                    </div>
                  )}
                  {po.exchangeRatePending && (po.status === 'DRAFT' || po.status === 'SENT') && (
                    <div className="mt-2 flex items-center gap-1.5 bg-red-50 border border-red-200 rounded px-2.5 py-2">
                      <span className="text-xs text-red-700 flex-shrink-0">{isEn ? `Rate ${po.currency}→EUR` : `汇率 ${po.currency}→EUR`}</span>
                      <input
                        type="number" step="0.000001" min="0"
                        value={fixRateInput}
                        onChange={e => setFixRateInput(e.target.value)}
                        placeholder={isEn ? 'e.g. 0.92' : '例如 0.92'}
                        className="border border-gray-300 rounded px-2 py-1 text-xs w-24 text-right"
                      />
                      <button
                        onClick={handleFixRate}
                        disabled={fixingRate}
                        className="h-6 px-2.5 text-xs font-medium rounded text-white disabled:opacity-50 flex-shrink-0"
                        style={{ background: PURPLE }}
                      >{fixingRate ? '…' : (isEn ? 'Confirm' : '确认')}</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Other Information tab ── */}
          {activeTab === 'other' && (
            <div className="p-6">
              <div className="grid grid-cols-2 gap-10">
                <div className="space-y-4">
                  <div className="flex items-start gap-3">
                    <label className="w-36 text-sm text-gray-500 flex-shrink-0 pt-1">{isEn ? 'Notes' : '备注'}</label>
                    {editing ? (
                      <textarea
                        value={editNotes}
                        onChange={e => setEditNotes(e.target.value)}
                        rows={3}
                        placeholder={isEn ? 'Internal notes...' : '内部备注...'}
                        className={`flex-1 ${inputCls} resize-none`}
                      />
                    ) : (
                      <span className="text-sm text-gray-700 whitespace-pre-line">{po.notes || '—'}</span>
                    )}
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Source Document' : '来源单据'}</label>
                    <span className="text-sm text-gray-400">—</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Created On' : '创建日期'}</label>
                    <span className="text-sm text-gray-700">{formatDateOnly(po.createdAt)}</span>
                  </div>
                </div>
              </div>

              {/* 收货记录：实际到货时间以此为准（可能分批多条），来自库存管理「收货」工作台 */}
              {(po.receipts?.length ?? 0) > 0 && (
                <div className="mt-6 pt-6 border-t border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">{isEn ? 'Goods Receipts' : '收货记录'}</h3>
                  <div className="space-y-3">
                    {[...(po.receipts ?? [])]
                      .sort((a, b) => new Date(b.arrivedAt).getTime() - new Date(a.arrivedAt).getTime())
                      .map(gr => <ReceiptCard key={gr.id} gr={gr} isEn={isEn} onUpdated={load} />)}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Chatter / message area ────────────────────── */}
        <div className="mt-4 bg-white rounded border border-gray-200 shadow-sm p-5">
          {timeline.length === 0 ? (
            <div className="text-sm text-gray-400 py-4 text-center border border-dashed border-gray-200 rounded">
              {isEn ? 'No activity records yet' : '暂无操作记录'}
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {timeline.map(t => (
                <div key={t.id} className="flex items-start gap-3 text-sm">
                  <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: PURPLE }} />
                  <span className="text-gray-400 font-mono text-xs w-32 flex-shrink-0 pt-px">
                    {new Date(t.at).toLocaleString(isEn ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="text-gray-700">{t.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showReceiveModal && po && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-800">{isEn ? 'Confirm Receipt' : '确认收货'} · {po.name}</h2>
            <p className="text-xs text-gray-500">
              {isEn
                ? 'Quantities default to the ordered amount and are added to stock once confirmed. Adjust if the actual receipt differs.'
                : '数量默认按下单数量计入库存，如实收有差异可在此调整。'}
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1.5">{isEn ? 'Product' : '商品'}</th>
                  <th className="text-right py-1.5">{isEn ? 'Ordered' : '订购'}</th>
                  {po.lines.some(l => Number(l.receivedQty ?? 0) > 0) && (
                    <th className="text-right py-1.5">{isEn ? 'Already received' : '已收'}</th>
                  )}
                  <th className="text-right py-1.5">{isEn ? 'Confirm qty' : '确认数量'}</th>
                </tr>
              </thead>
              <tbody>
                {po.lines.map(l => (
                  <tr key={l.id} className="border-b border-gray-100">
                    <td className="py-2 text-gray-800">{l.productName}</td>
                    <td className="py-2 text-right text-gray-500">{Number(l.orderedQty).toFixed(3)}</td>
                    {po.lines.some(x => Number(x.receivedQty ?? 0) > 0) && (
                      <td className="py-2 text-right text-gray-500">{Number(l.receivedQty ?? 0).toFixed(3)}</td>
                    )}
                    <td className="py-2 text-right">
                      <input type="number" step="0.001" min="0"
                        value={receiveQtys[l.id] ?? ''}
                        onChange={e => setReceiveQtys(prev => ({ ...prev, [l.id]: e.target.value }))}
                        className="border border-gray-300 rounded px-2 py-1 text-sm text-right w-24" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(po.receipts?.length ?? 0) > 0 && (
              <div className="border-t border-gray-100 pt-3">
                <div className="text-xs font-medium text-gray-600 mb-1.5">{isEn ? 'Recorded arrivals (reference)' : '库存已记录的到货（供参考）'}</div>
                <div className="space-y-1.5">
                  {(po.receipts ?? []).map(gr => {
                    const good = gr.lines.filter(l => (l.condition ?? 'ok') === 'ok').length
                    const bad = gr.lines.filter(l => l.condition === 'damaged').length
                    const rejected = gr.lines.filter(l => l.condition === 'rejected').length
                    return (
                      <div key={gr.id} className="text-xs text-gray-600 bg-gray-50 rounded px-2 py-1.5">
                        <span className="font-medium text-gray-700">{gr.name}</span>
                        {' · '}{isEn ? `${good} good` : `${good} 良品`}
                        {bad > 0 && <span className="text-red-600">{isEn ? `, ${bad} damaged` : `，${bad} 损坏`}</span>}
                        {rejected > 0 && <span className="text-red-700">{isEn ? `, ${rejected} rejected` : `，${rejected} 拒收`}</span>}
                        {gr.notes && <span className="text-gray-400"> · {gr.notes}</span>}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <button onClick={() => setShowReceiveModal(false)}
                className="flex-1 py-2 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-50">
                {isEn ? 'Cancel' : '取消'}
              </button>
              <button onClick={submitReceive} disabled={receiving}
                className="flex-1 py-2 rounded text-sm text-white disabled:opacity-50" style={{ background: PURPLE }}>
                {receiving ? (isEn ? 'Confirming…' : '确认中…') : (isEn ? 'Confirm Receipt' : '确认收货')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showReceiptsModal && po && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4"
          onClick={() => setShowReceiptsModal(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[85vh] overflow-y-auto p-6 space-y-4"
            onClick={e => e.stopPropagation()} data-testid="po-receipts-modal">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-800">{isEn ? 'Receipts & Returns' : '收货/退货记录'} · {po.name}</h2>
              <button onClick={() => setShowReceiptsModal(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none"
                aria-label={isEn ? 'Close' : '关闭'}>×</button>
            </div>

            {/* 库存流水（20261014 复式改造 L3）：这张 PO 收货/退货在库存总账里的每一笔「从 → 到」 */}
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">{isEn ? 'Stock Moves' : '库存流水'}</h3>
              <StockMovesTable
                isEn={isEn}
                filter={{ sourceId: po.id, sourceTypes: ['PURCHASE_RECEIVE', 'PURCHASE_RETURN'] }}
                emptyText={isEn ? 'Nothing received into stock yet' : '尚未确认收货入库'}
              />
            </div>

            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">
                {isEn ? 'Receipts' : '入库记录'} <span className="text-gray-400 font-normal">({stockInLogs.length})</span>
              </h3>
              {stockInLogs.length === 0 ? (
                <div className="text-sm text-gray-400 py-4 text-center border border-dashed border-gray-200 rounded">
                  {isEn ? 'Nothing received into stock yet' : '尚未确认收货入库'}
                </div>
              ) : (
                <div className="space-y-2">
                  {stockInLogs.map(l => <MovementLogCard key={l.id} log={l} kind="in" isEn={isEn} />)}
                </div>
              )}
            </div>

            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">
                {isEn ? 'Returns' : '退货记录'} <span className="text-gray-400 font-normal">({returnLogs.length})</span>
              </h3>
              {returnLogs.length === 0 ? (
                <div className="text-sm text-gray-400 py-4 text-center border border-dashed border-gray-200 rounded">
                  {isEn ? 'No returns' : '暂无退货记录'}
                </div>
              ) : (
                <div className="space-y-2">
                  {returnLogs.map(l => <MovementLogCard key={l.id} log={l} kind="return" isEn={isEn} />)}
                </div>
              )}
            </div>

            {goodsReceiptCount > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">
                  {isEn ? 'Arrival & QC (warehouse)' : '到货登记/质检（仓库）'} <span className="text-gray-400 font-normal">({goodsReceiptCount})</span>
                </h3>
                <div className="space-y-3">
                  {[...(po.receipts ?? [])]
                    .sort((a, b) => new Date(b.arrivedAt).getTime() - new Date(a.arrivedAt).getTime())
                    .map(gr => <ReceiptCard key={gr.id} gr={gr} isEn={isEn} showLines onUpdated={load} />)}
                </div>
              </div>
            )}

            <div className="flex justify-end pt-1">
              <button onClick={() => setShowReceiptsModal(false)}
                className="px-5 py-2 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-50">
                {isEn ? 'Close' : '关闭'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showReturnModal && po && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-800">{isEn ? 'Return / Adjust Quantity' : '退货/修正数量'} · {po.name}</h2>
            <p className="text-xs text-gray-500">
              {isEn
                ? 'Enter the return quantity for the affected lines. Stock and received quantity are reversed immediately.'
                : '填写需要退货的行数量，库存与已收数量会立即冲减。'}
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-200">
                  <th className="text-left py-1.5">{isEn ? 'Product' : '商品'}</th>
                  <th className="text-right py-1.5">{isEn ? 'Received' : '已收'}</th>
                  <th className="text-right py-1.5">{isEn ? 'Return qty' : '退货数量'}</th>
                </tr>
              </thead>
              <tbody>
                {po.lines.filter(l => Number(l.receivedQty ?? 0) > 0).map(l => (
                  <tr key={l.id} className="border-b border-gray-100">
                    <td className="py-2 text-gray-800">{l.productName}</td>
                    <td className="py-2 text-right text-gray-500">{Number(l.receivedQty ?? 0).toFixed(3)}</td>
                    <td className="py-2 text-right">
                      <input type="number" step="0.001" min="0" max={Number(l.receivedQty ?? 0)}
                        value={returnQtys[l.id] ?? ''}
                        onChange={e => setReturnQtys(prev => ({ ...prev, [l.id]: e.target.value }))}
                        className="border border-gray-300 rounded px-2 py-1 text-sm text-right w-24" />
                    </td>
                  </tr>
                ))}
                {po.lines.every(l => Number(l.receivedQty ?? 0) <= 0) && (
                  <tr><td colSpan={3} className="py-6 text-center text-gray-400">{isEn ? 'No received quantity to return yet' : '暂无已收数量可退'}</td></tr>
                )}
              </tbody>
            </table>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Reason' : '退货原因'}</label>
              <input value={returnReason} onChange={e => setReturnReason(e.target.value)}
                placeholder={isEn ? 'e.g. quality issue found after receiving' : '例如：收货后发现质量问题'}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none" />
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={() => setShowReturnModal(false)}
                className="flex-1 py-2 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-50">
                {isEn ? 'Cancel' : '取消'}
              </button>
              <button onClick={submitReturn} disabled={returning}
                className="flex-1 py-2 rounded text-sm text-white disabled:opacity-50 bg-orange-600 hover:bg-orange-700 disabled:hover:bg-orange-600">
                {returning ? (isEn ? 'Submitting…' : '提交中…') : (isEn ? 'Submit Return' : '提交退货')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showQuickCreate && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h2 className="text-base font-semibold text-gray-800">{isEn ? 'New Product' : '新建商品'}</h2>
            <p className="text-xs text-gray-400">{isEn ? "Create minimal info for this purchase; not saleable by default. You can later fill in sale price/tax rate/image in the product catalog before listing it." : '先建最小信息用于本次采购；默认不可销售，之后可在商品库补全销售价/税率/图片再上架。'}</p>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Product Name' : '商品名称'}</label>
              <input
                value={qcName}
                onChange={e => setQcName(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
                autoFocus
              />
              <SimilarProductAlert name={qcName} onPick={bindExistingProduct} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Category' : '分类'}</label>
                <SearchableDropdown
                  options={[{ value: '', label: isEn ? 'Uncategorized' : '未分类' }, ...categories.map(c => ({ value: c.id, label: (isEn ? (c.name || c.nameZh) : (c.nameZh || c.name)) ?? '' }))]}
                  value={qcCategoryId}
                  onChange={setQcCategoryId}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Purchase UoM' : '采购单位'}</label>
                <SearchableDropdown
                  options={[{ value: '', label: isEn ? 'Unspecified' : '未指定' }, ...uoms.map(u => ({ value: u.id, label: (isEn ? (u.name || u.nameZh) : (u.nameZh || u.name)) ?? '' }))]}
                  value={qcUomId}
                  onChange={setQcUomId}
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{isEn ? 'Reference Purchase Price (optional)' : '参考采购单价（可选）'}</label>
              <input
                type="number" step="0.01" min="0"
                value={qcUnitCost}
                onChange={e => setQcUnitCost(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm outline-none"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => setShowQuickCreate(false)}
                className="flex-1 py-2 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-50"
              >
                {isEn ? 'Cancel' : '取消'}
              </button>
              <button
                onClick={submitQuickCreate}
                disabled={qcSubmitting}
                className="flex-1 py-2 rounded text-sm text-white disabled:opacity-50"
                style={{ background: PURPLE }}
              >
                {qcSubmitting ? (isEn ? 'Creating…' : '创建中…') : (isEn ? 'Create and add to lines' : '创建并加入采购行')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
