/**
 * 采购质检（台账 F4）
 * ============================================================================
 * 需求要的是最小 MVP：收货时能填**重量 / 新鲜度 / 农残**三项，能查，不合格能拒收。
 * 明确「整合进收货界面，不单开模块」，所以这里只有纯函数 —— 判定口径收在一处，
 * 收货接口、收货界面、采购单详情、批次追溯四个地方共用同一份，不各写一遍。
 * （司机 slot 分叉、税率量纲、打印筛选，栽的都是「两边各写一遍」。）
 *
 * ⛔ 刻意不新建 QualityCheck 表：质检是**在收货那一刻对某一行货**做的判断，
 * 它的宿主就是收货行。另起一张表就会有第二处真相 —— 收货行说收了 60，
 * 质检表说判了 100，谁对？现在质检记录随 `GoodsReceipt.lines` 一起写、一起读，
 * 采购单详情本来就带 receipts，批次追溯按 `Lot.sourceId` 反查收货单，两处都是派生。
 *
 * ⛔ 结论（PASS/FAIL）也刻意**不让人另填一个字段**，而是由三项体检值派生（`qcVerdict`）。
 * 让人手选结论，就会出现「农残 FAIL 但结论勾了 PASS」这种自相矛盾的记录，
 * 而这恰恰是食品安全上最不能含糊的一格。
 */

/** 新鲜度评级：A 优 / B 良 / C 合格 / D 不合格 */
export const FRESHNESS_GRADES = ['A', 'B', 'C', 'D'] as const
export type FreshnessGrade = (typeof FRESHNESS_GRADES)[number]

/** 农残检测结果 */
export const PESTICIDE_RESULTS = ['PASS', 'FAIL', 'NOT_TESTED'] as const
export type PesticideResult = (typeof PESTICIDE_RESULTS)[number]

/** 拒收原因（必填，无默认值 —— 与 lib/shortage-reason 同一取舍） */
export const QC_REJECT_REASONS = [
  'WEIGHT_SHORT',
  'FRESHNESS',
  'PESTICIDE',
  'DAMAGED',
  'WRONG_ITEM',
  'EXPIRED',
  'OTHER',
] as const
export type QcRejectReason = (typeof QC_REJECT_REASONS)[number]

export const FRESHNESS_LABELS: Record<FreshnessGrade, { zh: string; en: string }> = {
  A: { zh: 'A 优', en: 'A Excellent' },
  B: { zh: 'B 良', en: 'B Good' },
  C: { zh: 'C 合格', en: 'C Acceptable' },
  D: { zh: 'D 不合格', en: 'D Rejected' },
}

export const PESTICIDE_LABELS: Record<PesticideResult, { zh: string; en: string }> = {
  PASS: { zh: '合格', en: 'Pass' },
  FAIL: { zh: '超标', en: 'Exceeded' },
  NOT_TESTED: { zh: '未检测', en: 'Not tested' },
}

export const QC_REJECT_REASON_LABELS: Record<QcRejectReason, { zh: string; en: string }> = {
  WEIGHT_SHORT: { zh: '重量不足', en: 'Underweight' },
  FRESHNESS: { zh: '新鲜度不合格', en: 'Freshness rejected' },
  PESTICIDE: { zh: '农残超标', en: 'Pesticide exceeded' },
  DAMAGED: { zh: '破损', en: 'Damaged' },
  WRONG_ITEM: { zh: '错发/规格不符', en: 'Wrong item' },
  EXPIRED: { zh: '临期/过期', en: 'Expired' },
  OTHER: { zh: '其他', en: 'Other' },
}

/** 落在 `GoodsReceipt.lines[].qc` 里的形状 */
export interface QcRecord {
  /** 实测重量（kg）。留空表示没称 —— 不是 0 */
  weightKg?: number | null
  freshness?: FreshnessGrade | null
  pesticide?: PesticideResult | null
  note?: string | null
  /** 服务端盖章，不接受客户端传值 */
  checkedBy?: string | null
  checkedAt?: string | null
}

export type QcVerdict = 'PASS' | 'FAIL'

export const isFreshnessGrade = (v: unknown): v is FreshnessGrade =>
  typeof v === 'string' && (FRESHNESS_GRADES as readonly string[]).includes(v)
export const isPesticideResult = (v: unknown): v is PesticideResult =>
  typeof v === 'string' && (PESTICIDE_RESULTS as readonly string[]).includes(v)
export const isQcRejectReason = (v: unknown): v is QcRejectReason =>
  typeof v === 'string' && (QC_REJECT_REASONS as readonly string[]).includes(v)

export class QcInputError extends Error {}

/**
 * 解析客户端提交的质检信息。
 * · **全部留空返回 null** —— 不写 `qc: {}`。空对象会让「这行没做质检」和
 *   「做了质检但什么都没填」在库里长得一模一样，日后没法区分。
 * · 非法枚举值**抛错**而不是静默丢弃：悄悄丢掉等于界面上填了、库里没有，
 *   而操作员看到的是提交成功。
 */
export function parseQc(raw: unknown): QcRecord | null {
  if (raw == null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>

  let weightKg: number | null = null
  if (o.weightKg != null && o.weightKg !== '') {
    const n = Number(o.weightKg)
    if (!Number.isFinite(n) || n < 0) throw new QcInputError('实测重量必须是非负数字')
    weightKg = n
  }

  let freshness: FreshnessGrade | null = null
  if (o.freshness != null && o.freshness !== '') {
    if (!isFreshnessGrade(o.freshness)) throw new QcInputError(`新鲜度评级非法：${String(o.freshness)}`)
    freshness = o.freshness
  }

  let pesticide: PesticideResult | null = null
  if (o.pesticide != null && o.pesticide !== '') {
    if (!isPesticideResult(o.pesticide)) throw new QcInputError(`农残检测结果非法：${String(o.pesticide)}`)
    pesticide = o.pesticide
  }

  const note = typeof o.note === 'string' ? o.note.trim().slice(0, 300) : ''

  if (weightKg == null && freshness == null && pesticide == null && !note) return null
  return { weightKg, freshness, pesticide, note: note || null }
}

/**
 * 读取库里已存的质检记录。与 `parseQc` 的区别是**读端宽松、写端严格**：
 * 写入时非法值必须报错（否则填了等于没填），读取时非法值只能忽略 ——
 * 一条脏记录不该把整个批次追溯页打成 500。
 */
export function parseStoredQc(raw: unknown): QcRecord | null {
  if (raw == null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const n = Number(o.weightKg)
  const weightKg = o.weightKg != null && o.weightKg !== '' && Number.isFinite(n) ? n : null
  const freshness = isFreshnessGrade(o.freshness) ? o.freshness : null
  const pesticide = isPesticideResult(o.pesticide) ? o.pesticide : null
  const note = typeof o.note === 'string' && o.note.trim() ? o.note.trim() : null
  if (weightKg == null && !freshness && !pesticide && !note) return null
  return {
    weightKg, freshness, pesticide, note,
    checkedBy: typeof o.checkedBy === 'string' ? o.checkedBy : null,
    checkedAt: typeof o.checkedAt === 'string' ? o.checkedAt : null,
  }
}

/** 是否填过体检值（note 单独存在不算做过质检 —— 备注可能只是「司机换人了」） */
export function hasQcMeasurements(qc: QcRecord | null | undefined): boolean {
  return !!qc && (qc.weightKg != null || qc.freshness != null || qc.pesticide != null)
}

/**
 * 质检结论 —— 派生，不存。
 * 农残超标或新鲜度 D 即为不合格；三项一个都没填则返回 null（「未质检」≠「合格」）。
 */
export function qcVerdict(qc: QcRecord | null | undefined): QcVerdict | null {
  if (!hasQcMeasurements(qc)) return null
  if (qc!.pesticide === 'FAIL' || qc!.freshness === 'D') return 'FAIL'
  return 'PASS'
}

/** 收货行的最终结论：拒收本身就是不合格，哪怕体检值一格没填 */
export function lineVerdict(qc: QcRecord | null | undefined, rejectedQty: number): QcVerdict | null {
  if (rejectedQty > 0) return 'FAIL'
  return qcVerdict(qc)
}

export function formatQcSummary(qc: QcRecord | null | undefined, lang: 'zh' | 'en' = 'zh'): string {
  if (!qc) return ''
  const parts: string[] = []
  if (qc.weightKg != null) parts.push(lang === 'zh' ? `实测 ${qc.weightKg}kg` : `${qc.weightKg}kg measured`)
  if (qc.freshness) parts.push(`${lang === 'zh' ? '新鲜度 ' : 'Freshness '}${FRESHNESS_LABELS[qc.freshness][lang]}`)
  if (qc.pesticide) parts.push(`${lang === 'zh' ? '农残 ' : 'Pesticide '}${PESTICIDE_LABELS[qc.pesticide][lang]}`)
  if (qc.note) parts.push(qc.note)
  return parts.join(' · ')
}

export interface QcLineInput {
  productId: string
  productName?: string
  qty: number
  condition?: string
  qc?: QcRecord | null
  /** 校验的输入是不可信的（下拉框给的是自由字符串），所以这里收 unknown，
   *  由 `isQcRejectReason` 白名单判定 —— 别在类型上假装它已经合法 */
  rejectReason?: unknown
}

/**
 * 提交前的一致性校验。返回错误文案，null 表示通过。
 *
 * 两条规则，都是「不让记录自相矛盾」：
 *   ① 拒收必须给原因 —— 否则事后没人知道货为什么被退回，也没法找供应商算账；
 *   ② 农残超标却一件都没拒收，必须写明让步接收的理由 —— 这不是拦截（现实中
 *      确实可能先收下再复检），而是逼这个决定留下署名和说法。
 */
export function validateQcLines(lines: QcLineInput[]): string | null {
  const rejectedQtyByProduct = new Map<string, number>()
  for (const l of lines) {
    if (l.condition !== 'rejected') continue
    const qty = Number(l.qty) || 0
    if (qty <= 0) continue
    rejectedQtyByProduct.set(l.productId, (rejectedQtyByProduct.get(l.productId) ?? 0) + qty)
    if (!isQcRejectReason(l.rejectReason)) {
      return `${l.productName || l.productId}：拒收必须选择原因`
    }
  }
  for (const l of lines) {
    if (l.condition === 'rejected') continue
    if (l.qc?.pesticide !== 'FAIL') continue
    if ((rejectedQtyByProduct.get(l.productId) ?? 0) > 0) continue
    if (!l.qc?.note) {
      return `${l.productName || l.productId}：农残超标但未拒收，请在质检备注里写明让步接收的理由`
    }
  }
  return null
}
