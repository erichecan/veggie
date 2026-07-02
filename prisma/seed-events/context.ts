/**
 * 种子运行上下文 + 标记常量（所有事件函数共享）
 */
import type { PrismaClient } from '../../lib/generated/prisma/client'
import type { Rng } from './rng'

/** 仅清理「带这些标记」的数据，主数据永不触碰 */
export const MARK = {
  orderRef: 'seed-evt', // Order.externalRef
  tenant: 'seed-evt', // PurchaseSuggestion/Notification/Statement.tenantId
  vendorExternalId: 'seed-evt-vendor', // 种子创建的供应商 Customer.externalId
  lotPrefix: 'EVT-LOT-',
  poPrefix: 'EVT-PO-',
  grPrefix: 'EVT-GR-',
  vbPrefix: 'EVT-VB-',
  invPrefix: 'EVT-INV-',
  cnPrefix: 'EVT-CN-',
  discPrefix: 'EVT-DISC-',
  wavePrefix: '[EVT] ',
  tripPrefix: '[EVT] ',
  stockNote: '[seed-evt]', // 每条 StockMove.note 含此串
  jeMarker: 'EVT-', // JournalEntry.narration 含此串
}

/** 单调递增的业务编号发号器（避免 N+1 count 查询） */
export class Counter {
  private n: number
  constructor(start = 0) {
    this.n = start
  }
  next(prefix: string, pad = 5): string {
    this.n += 1
    return `${prefix}${String(this.n).padStart(pad, '0')}`
  }
}

export type Scale = 'small' | 'medium' | 'large'

export interface ScaleConfig {
  customers: number // 参与的客户数上限
  monthsBack: number // 时间跨度（月）
  maxOrdersPerCustomer: number // 每客户半年订单上限（再按层级缩放）
}

export const SCALE_CONFIG: Record<Scale, ScaleConfig> = {
  small: { customers: 15, monthsBack: 4, maxOrdersPerCustomer: 18 },
  medium: { customers: 35, monthsBack: 6, maxOrdersPerCustomer: 30 },
  large: { customers: 80, monthsBack: 6, maxOrdersPerCustomer: 40 },
}

export interface ProductInfo {
  id: string
  name: string
  categoryId: string | null
  uomId: string | null
  uomName: string | null
  sellPrice: number // 含义：不含税牌价（OrderLine.unitPrice）
  cost: number // standardPrice（采购成本）
  taxRate: number // 0 / 0.135 等
  supplierId: string // 指派的供应商
}

export type Tier = 'large' | 'medium' | 'small'

export interface Persona {
  id: string
  name: string
  tier: Tier
  paymentTerm: 'monthly' | 'weekly' | 'cash'
  salesman: string
  driverSlotId: string | null
  driverName: string | null
  commissionRate: number // 司机佣金率
  basket: ProductInfo[] // 稳定常买清单
  ordersPerMonth: number
  linesPerOrder: [number, number] // [min,max]
}

export interface Ctx {
  prisma: PrismaClient
  rng: Rng
  now: Date
  scale: ScaleConfig
  operatorId: string
  operatorName: string
  financeId: string
  driverUserId: string | null
  /** 业务员姓名 → User.id（种子内造的 SALES 账号，Order/Customer.salesUserId 用） */
  salesUserIdByName: Record<string, string>
  /** 订单流水号自增（生成唯一 EVT-SO-NNNNNN code） */
  _orderSeq: number
  // 发号器
  lot: Counter
  po: Counter
  gr: Counter
  vb: Counter
  inv: Counter
  cn: Counter
  disc: Counter
  // 派生
  products: ProductInfo[]
  personas: Persona[]
  salesmen: string[]
  driverSlots: Array<{ id: string; driverName: string }>
  supplierIds: string[]
}

export const DAY = 86_400_000
