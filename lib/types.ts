// ─── 系统用户 ─────────────────────────────────────────────────────────────────
export type UserRole = 'OPERATOR' | 'RESTAURANT' | 'PICKER' | 'SORTER' | 'DRIVER' | 'BOSS' | 'FINANCE' | 'WAREHOUSE' | 'SALES' | 'EXTERNAL_SALES' | 'DISPATCH' | 'OTHER'

export interface SystemUser {
  id: string
  email: string
  name: string
  role: UserRole
  /** 全部角色。列表接口对老数据会回填成 [role]，所以这里不是可选的空数组 */
  roles?: string[]
  isActive: boolean
  customerId?: string | null
  /** 上级。数据范围为「本人及下属」的角色靠这条链决定能看到谁的单据 */
  managerId?: string | null
  manager?: { id: string; name: string } | null
  createdAt: string
  updatedAt: string
}

// ─── 商品属性（对应 Odoo product.attribute / product.attribute.value）────────
export interface ProductAttributeValue {
  id: string
  name: string        // e.g. "1kg", "5kg", "BAG", "Loose"
  sequence: number
}

export interface ProductAttribute {
  id: string
  name: string        // e.g. "Weight", "Packaging"
  sequence: number
  values: ProductAttributeValue[]
}

// ─── 商品模板（对应 Odoo product.template）────────────────────────────────────
export type ProductType = 'product' | 'consu' | 'service'
export type ProductStatus = 'draft' | 'active' | 'archived'

export interface TemplateAttributeLine {
  attributeId: string
  valueIds: string[]   // 勾选了哪些属性值 → 生成变体
}

export interface ProductTemplate {
  id: string
  name: string
  internalRef?: string
  categoryId?: string
  listPrice: number          // 默认销售单价
  standardPrice: number      // 默认成本价
  customerTaxRate: number    // 客户税率 0.135 / 0.23 / 0
  type: ProductType
  canBeSold: boolean
  canBePurchased: boolean
  description?: string       // 内部备注
  saleDescription?: string   // 销售描述（打印到报价单）
  images: string[]
  attributeLines: TemplateAttributeLine[]  // 属性配置 → 用于生成变体
  status: ProductStatus
  createdAt: string
  updatedAt?: string
  // Odoo 对齐
  externalId?: string
  sequence?: number
  weight?: number
  volume?: number
  commissionPrice?: number
  // Odoo 商品选项
  isPackaging?: boolean
  canBeExpensed?: boolean
  // 计量单位
  /** @deprecated 旧字符串字段，逐步迁移到 uomId，仅保留兼容读取 */
  unitOfMeasure?: string
  /** @deprecated 旧字符串字段，逐步迁移到 purchaseUomId，仅保留兼容读取 */
  purchaseUoM?: string
  uomId?: string
  purchaseUomId?: string
  uomName?: string
  // 库存追踪方式
  tracking?: 'none' | 'lot' | 'serial'
  // 电商
  websitePublished?: boolean
  websiteName?: string
  // Odoo 新增对齐字段
  vendorTaxRate?: number
  forecastQty?: number
  createdBy?: string
  updatedBy?: string
  barcode?: string
  /** 实时在手库存，来自 /api/product-templates 逐行附加，非模型本身字段 */
  qtyOnHand?: number
}

// ─── 商品变体（对应 Odoo product.product）────────────────────────────────────
export interface VariantAttributeValue {
  attributeId: string
  attributeName: string
  valueId: string
  valueName: string
}

export interface Product {
  id: string
  templateId: string           // 必须关联到 ProductTemplate
  name: string                 // = template.name + " " + 属性值组合，或 template.name（单变体）
  variantAttributes: VariantAttributeValue[]   // 空数组 = 单变体

  // 变体级别可覆盖模板的字段
  internalRef?: string         // 变体专属 SKU
  listPrice?: number           // 覆盖模板售价（空=用模板价）
  standardPrice?: number       // 覆盖模板成本（空=用模板成本）
  qtyOnHand: number
  active: boolean

  // 兼容旧代码的字段（通过 template 补全显示）
  categoryId?: string          // 冗余存一份，方便查询
  customerTaxRate?: number
  commissionPrice?: number
  images: string[]

  // 旧版兼容（保持订单引用正常）
  spec?: string
  price?: number
  stock?: number
  status: ProductStatus
  uomId?: string
  uomName?: string
  createdAt: string
  updatedAt?: string
  externalId?: string
  sequence?: number
}

// ─── 商品分类 ─────────────────────────────────────────────────────────────────
export interface ProductCategory {
  id: string
  name: string
  nameZh?: string
  externalId?: string
}

// ─── 客户专属特殊价格（对应 Odoo 客户专属价格列表 / 手动价格覆盖）─────────────
/**
 * 优先级：specialPrices > pricelistId 对应的价格表规则 > 商品牌价
 * 对应 Odoo 里在价格表中为特定客户设置高优先级固定价格条目的场景。
 */
export interface CustomerSpecialPrice {
  id: string
  /** 关联的商品变体 ID（Product.id） */
  productId: string
  /** 最低数量，≥ 该数量才触发（0 = 始终适用） */
  minQty: number
  /** 固定单价（EUR） */
  fixedPrice: number
  /** 有效期开始（ISO date string，可选） */
  dateStart?: string
  /** 有效期结束（ISO date string，可选） */
  dateEnd?: string
  /** 内部备注 */
  note?: string
}

// ─── 客户定价模式（对应 Odoo 的 price_type 概念）──────────────────────────────
/**
 * multi   — 价格表链 → last price → 牌价，三级回退（75.2% 客户默认值）
 * default — 价格表链 → 牌价，两级回退（不查 last price）
 * last    — 用该客户最近一次购买该商品的实际成交价，与价格表无关
 */
export type CustomerPriceType = 'multi' | 'default' | 'last'

/** 客户挂载的一张价格表 + 优先级（数字越小优先级越高） */
export interface CustomerPricelistLink {
  pricelistId: string
  sequence: number
}

// ─── 客户 ───────────────────────────────────────────────────────────────────
export interface Customer {
  id: string
  name: string
  address: string
  phone: string
  email: string
  vatNumber: string
  paymentTerm: 'cash' | 'weekly' | 'monthly'
  creditLimit?: number
  commissionRate?: number
  createdAt: string
  isActive?: boolean
  // Odoo 对齐
  externalId?: string
  street?: string
  street2?: string
  city?: string
  zip?: string
  notes?: string
  /** 客户级外部备注（客户可见，打印在报价单/送货单上）；与内部 notes 区分 */
  externalNote?: string
  /** 客户挂载的价格表列表，按 sequence 升序 = 优先级从高到低。第一张命中即用，全部未命中才继续下一级（last price / 牌价） */
  pricelists?: CustomerPricelistLink[]
  /**
   * 定价模式（Odoo price_type）
   * multi = 价格表引擎 | default = 直接牌价 | last = 最近成交价
   * @default 'multi'
   */
  priceType?: CustomerPriceType
  /** 客户专属特殊价格（优先级最高，覆盖价格表规则） */
  specialPrices?: CustomerSpecialPrice[]
  /** 关联业务员用户 ID（写入用） */
  salesUserId?: string | null
  /** 关联业务员姓名（只读展示，由 API 从 salesUserId 关联展平） */
  salesman?: string
}

// ─── 订单 ───────────────────────────────────────────────────────────────────
export type OrderStatus = 'pending' | 'confirmed' | 'wave_assigned' | 'in_delivery' | 'completed' | 'locked' | 'cancelled'
export type PaymentMethod = 'online' | 'cash'

export interface OrderItem {
  productId: string
  productName: string
  spec: string
  /** 行级备注（商品级 note，如"free"赠品/注意事项） */
  note?: string
  price: number
  quantity: number
  subtotal: number
  /** 计量单位 ID，关联 Uom 表 */
  uomId?: string
  /** 计量单位名称快照，如"kg"、"件" */
  uomName?: string
  /** 行级税率：place-order 存百分比（如 13.5），restaurant 存分数（如 0.135）；读取时用 >1 判断 */
  taxRate?: number
  commissionPrice?: number
  /** 已交货数量（Trip 标记送达后回写） */
  deliveredQty?: number
  /** 已开票数量（Invoice 生成时回写） */
  invoicedQty?: number
}

/** 订单行（OrderLine 表）— 与 Order.items JSON 双写 */
export interface OrderLine {
  id: string
  orderId: string
  productId: string
  productName: string
  spec?: string | null
  uomId?: string | null
  uomName?: string | null
  /** 行级备注（商品级 note，如"free"赠品/注意事项），客户可见，打印在明细行下 */
  note?: string | null
  unitPrice: number
  taxRate?: number | null
  orderedQty: number
  deliveredQty: number
  invoicedQty: number
  subtotal: number
  sequence: number
  /** 商品件提成单价·下单快照（不下发到下单/报价/销售单详情页，见 PRD 20260703） */
  commissionPrice?: number | null
  /** 单价来源快照：PRICELIST/DEFAULT/LAST/SPECIAL，历史订单为 null */
  priceSourceType?: string | null
  /** 来源明细：PRICELIST 时为命中的价格表名字 */
  priceSourceDetail?: string | null
  /** LAST 来源时，最近一次成交发生的时间 */
  priceSourceDate?: string | null
  createdAt: string
  updatedAt: string
}

export interface Order {
  id: string
  /** 业务编号：创建者缩写-YYMMDD-NNN（例：CJ-260424-001），历史订单可能为空 */
  code?: string | null
  /** 创建者用户 ID（历史订单可能为空） */
  createdById?: string | null
  /** 创建者姓名快照 */
  createdByName?: string | null
  restaurantId: string
  restaurantName: string
  items: OrderItem[]
  /** 税前总额（SSOT，= Σ行 subtotal，见 docs/20260701 A-2） */
  totalAmount: number
  /** 税后总额（派生，财务/对账「销售额」用；无行的历史订单退回 totalAmount，见 B-1） */
  totalAmountIncTax?: number
  status: OrderStatus
  paymentMethod: PaymentMethod
  createdAt: string
  /** 下单时快照客户的价格表 ID（对应 Odoo sale.order.pricelist_id） */
  pricelistId?: string
  /** 下单时快照客户的定价模式（multi/default/last） */
  priceType?: CustomerPriceType
  /** 内部备注（仅内部可见，不打印在客户单据上） */
  internalNote?: string
  /** 外部备注（打印在报价单/送货单上，客户可见） */
  externalNote?: string
  /** 第三方送货备注（第三方替我们送货时的具体信息，打印在送货单上） */
  deliveryNote?: string | null
  /** 报价日期 */
  quotationDate?: string
  /** 确认日期 */
  confirmationDate?: string
  /** 交货日期 */
  deliveryDate?: string
  /** 发票日期 */
  invoiceDate?: string
  /** 送货单是否已回（会计核销标记） */
  orderReturn?: boolean
  /** 配送批次+司机，格式 "1 am BAO" / "2 pm AFZAAL"（旧字段，已弃用，显示改用 deliveryBatchDisplay） */
  deliveryBatch?: string
  /** 调度归属显示（由所属 PickingWave + 实时 DriverSlot 派生，单一真相，SSOT P0-1） */
  deliveryBatchDisplay?: string | null
  /** 关联 DriverSlot ID（下单意向；实际 wave 归属见 deliveryBatchDisplay） */
  driverSlotId?: string | null
  /** 关联 DriverSlot 详情（API include 时返回） */
  driverSlot?: { id: string; batchNum: number; timeOfDay: string; driverName: string } | null
  /** OrderLine 表的关联记录（API include 时返回） */
  lines?: OrderLine[]
  /** 报价单发送时间（PENDING + sentAt → "Quotation Sent"） */
  sentAt?: string | null
  /** 锁定时间（LOCKED 状态时不空） */
  lockedAt?: string | null
  /** 最近一次打印时间（销售单打印追踪） */
  printedAt?: string | null
  /** 最近一次打印人用户 ID */
  printedById?: string | null
  /** 最近一次打印人姓名快照 */
  printedByName?: string | null
  /** 最近一次打印的单据类型：DELIVERY | SALES */
  printType?: string | null
  /** 累计打印次数 */
  printCount?: number
  /** 客户抽成率·下单快照 */
  commissionRate?: number | null
  /** 客户固定辛苦费·下单快照（EUR/单） */
  commissionFixed?: number | null
  /** 每单最终司机提成金额（EUR）——送达时按实送量冻结，结算/财务/利润分析共用此数 */
  driverCommissionTotal?: number | null
  /** 提成冻结时间 */
  commissionFrozenAt?: string | null
}

// ─── 订单审计日志 ────────────────────────────────────────────────────────────
export interface OrderAuditLog {
  id: string
  orderId: string
  userId: string
  action: string
  changedFields?: Record<string, { before: unknown; after: unknown }>
  totalBefore?: number
  totalAfter?: number
  createdAt: string
}

// ─── 送货单 ──────────────────────────────────────────────────────────────────
export interface DeliverySlip {
  id: string
  orderId: string
  customerId: string
  customerName: string
  deliveryDate?: string
  createdAt: string
}

// ─── 拣货波次 ────────────────────────────────────────────────────────────────
export type WaveStatus = 'pending' | 'picking' | 'picked' | 'sorting' | 'sorted'

export interface PickingItem {
  productId: string
  productName: string
  spec: string
  /** 行级备注（如"15个正常价+5个打折处理"），拣货时需要醒目提示 */
  note?: string
  image: string
  requiredQty: number
  pickedQty: number
  restaurants: string[]
  done: boolean
  /** 计量单位名称快照，如 "kg"、"件"、"箱" */
  uomName?: string
}

export interface PickingZone {
  name: string
  items: PickingItem[]
}

export interface PickingWave {
  id: string
  name?: string
  orderIds: string[]
  zones: PickingZone[]
  status: WaveStatus
  createdAt: string
  waveDate?: string
  waveNumber?: number
  waveType?: string
  driverSlotId?: string
  driverName?: string
}

// ─── 配送行程 ────────────────────────────────────────────────────────────────
export type TripStatus = 'pending' | 'pending_assignment' | 'verifying' | 'in_progress' | 'completed'

export interface ReturnItem {
  productId: string
  productName: string
  quantity: number
  photo?: string
  unitPrice?: number
  refundMode?: 'pct' | 'fixed'
  refundPct?: number
  refundAmount?: number
  refundNote?: string
  status?: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'SETTLED'
  restaurantId?: string
  restaurantName?: string
  tripId?: string
  createdAt?: string
  approvedAt?: string
  settledAt?: string
  reason?: string
  actionType?: 'return' | 'exchange'
  /// 审批通过时必填：货物去向。SELLABLE=可再售(回补库存)，SCRAP=报废(计入损耗)。审批前为空
  disposition?: 'SELLABLE' | 'SCRAP'
  /// 报废去向对应的批次消耗，便于批次追溯反查
  scrapLotId?: string
}

export interface TripRestaurant {
  restaurantId: string
  restaurantName: string
  address?: string
  orderIds: string[]
  items: OrderItem[]
  delivered: boolean
  payment?: number
  returns: ReturnItem[]
  pods: string[]
  cargoVerified: boolean
  /**
   * 客户手写电子签名（Sign on Glass），PNG data URI。
   * 与 pods（拍照存证）互补：照片证明货送到了，签名证明客户认可收货。
   * 合同第二条点名此能力，第四条把「司机电子签收」写进验收闭环。
   */
  signature?: string
  /** 签名人姓名，司机现场填写——签名图像本身认不出是谁签的 */
  signerName?: string
  /** 签名时间（ISO 字符串），由服务端在收到签名时打戳，不信客户端时间 */
  signedAt?: string
  /**
   * 签名纠错历史。现场签错（签错人、签错站）时由主管走纠错接口更正，
   * **旧签名归档到这里而不是被覆盖掉**——凭证一旦销毁就没法举证了。
   */
  signatureCorrections?: SignatureCorrection[]
}

/** 一次签名更正的完整留痕 */
export interface SignatureCorrection {
  /** 被替换掉的旧签名（PNG data URI）。作废时同样保留 */
  previousSignature: string
  previousSignerName: string | null
  previousSignedAt: string | null
  /** 更正原因，必填 */
  reason: string
  /** 操作人 */
  correctedBy: string
  correctedByName: string
  /** 服务端时间 */
  correctedAt: string
  /** void = 作废签名回到未签收；replace = 换成新签名 */
  action: 'void' | 'replace'
}

export interface Trip {
  id: string
  /** 关联拣货波次（手动创建的行程可为空） */
  waveId?: string
  /** 行程名称，如"上午 · 王师傅 · 4家餐馆" */
  name?: string
  /** 配送时段：AM（上午）或 PM（下午） */
  timeSlot?: string
  driverId?: string
  driverName?: string
  departTime?: string
  status: TripStatus
  restaurants: TripRestaurant[]
  totalPayment: number
  createdAt: string
}

// ─── 购物车 ──────────────────────────────────────────────────────────────────
export interface CartItem {
  productId: string
  productName: string
  spec: string
  price: number
  image: string
  quantity: number
  uomId?: string
  uomName?: string
  /** 行级税率（覆盖商品默认税率），如 0.135 / 0.23 / 0；未设置则按商品默认税率计算 */
  taxRate?: number
}

// ─── 采购记录 ────────────────────────────────────────────────────────────────
export interface PurchaseRecord {
  id: string
  productId: string
  productName: string
  spec: string
  quantity: number
  unitCost: number
  supplier: string
  arrivedAt: string
  createdAt: string
}

// ─── 用户角色 ────────────────────────────────────────────────────────────────
export type Role = 'operator' | 'restaurant' | 'picker' | 'sorter' | 'driver' | 'boss' | 'finance' | 'warehouse'

export interface RoleSession {
  role: Role
  id: string
  name: string
}

// ─── Odoo Pricelist（对应 product.pricelist + product.pricelist.item）──────────

/** 价格表条目适用范围，对应 Odoo applied_on */
export type PricelistApplyOn = 'global' | 'category' | 'product' | 'variant'

/** 价格计算方式，对应 Odoo compute_price */
export type PricelistComputeType = 'fixed' | 'percentage' | 'formula'

/** 公式定价基准来源，对应 Odoo base */
export type PricelistFormulaBase = 'list_price' | 'standard_price' | 'pricelist'

export interface OdooPricelistItem {
  id: string
  /** 适用范围 */
  applyOn: PricelistApplyOn
  /** applyOn='product'：对应 product_tmpl_id（ProductTemplate.id） */
  productTemplateId?: string
  /** applyOn='variant'：对应 product_id（Product.id） */
  productVariantId?: string
  /** applyOn='category'：对应 categ_id */
  categoryId?: string
  /** 最小数量 */
  minQty: number
  /** 有效期开始 */
  dateStart?: string
  /** 有效期结束 */
  dateEnd?: string
  /** 计算方式 */
  computeType: PricelistComputeType
  /** fixed: 固定单价 */
  fixedPrice?: number
  /** percentage: 折扣 % (e.g. 10 = 打九折，即减10%) */
  percentDiscount?: number
  /** formula: 基准来源 */
  formulaBase?: PricelistFormulaBase
  /** formulaBase='pricelist': 嵌套价格表 ID */
  basedOnPricelistId?: string
  /** formula: 折扣 % (e.g. 5 = 减5%) */
  priceDiscount?: number
  /** formula: 额外加价（€） */
  priceSurcharge?: number
  /** formula: 最低利润（€） */
  priceMinMargin?: number
  /** formula: 最高利润（€） */
  priceMaxMargin?: number
  /** formula: 四舍五入精度 */
  roundingMethod?: number
  /** 排序序号（小的优先） */
  sequence: number
}

export interface OdooPricelist {
  id: string
  externalId?: string
  name: string
  currency: string      // 'EUR'
  items: OdooPricelistItem[]
  sequence: number
  selectable: boolean
  active: boolean
  updatedAt: string
  /** 促销码 */
  promotionalCode?: string
  /** 备注 */
  notes?: string
  /** 网站 */
  website?: string
  /** 国家组 */
  countryGroups?: string[]
}

// ─── 发票 ─────────────────────────────────────────────────────────────────────
export type InvoiceStatus = 'draft' | 'posted' | 'paid' | 'cancelled'

export interface InvoiceLine {
  productId: string
  productName: string
  spec: string
  qty: number
  unitPrice: number
  taxRate: number
  subtotalExTax: number
  taxAmount: number
  subtotalIncTax: number
}

export interface Invoice {
  id: string
  name: string
  customerId: string
  customerName: string
  saleOrderIds: string[]
  lines: InvoiceLine[]
  subtotalExTax: number
  totalTax: number
  totalIncTax: number
  amountPaid: number
  amountDue: number
  status: InvoiceStatus
  paymentTerms: 'cash' | 'weekly' | 'monthly'
  dueDate?: string
  createdAt: string
  postedAt?: string
  paidAt?: string
}

// ─── 库存移动 ─────────────────────────────────────────────────────────────────
export type StockMoveType = 'in' | 'out' | 'adjustment' | 'return' | 'scrap'

export interface StockMove {
  id: string
  productId: string
  productName: string
  type: StockMoveType
  qty: number
  note?: string
  sourceType?: string | null
  sourceId?: string | null
  sourceRef?: string | null
  createdAt: string
}

// ─── 整体 Store ───────────────────────────────────────────────────────────────
export interface AppStore {
  productTemplates: ProductTemplate[]
  products: Product[]                    // variants
  productCategories: ProductCategory[]
  productAttributes: ProductAttribute[]
  customers: Customer[]
  orders: Order[]
  waves: PickingWave[]
  trips: Trip[]
  purchases: PurchaseRecord[]
  invoices: Invoice[]
  stockMoves: StockMove[]
  roleSession: RoleSession | null
  odooLists: OdooPricelist[]
}

export interface BackupJob {
  id: string
  status: 'running' | 'success' | 'failed'
  triggerType: 'AUTO' | 'MANUAL'
  triggeredBy: string | null
  gcsPath: string | null
  sizeBytes: number | null
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
}
