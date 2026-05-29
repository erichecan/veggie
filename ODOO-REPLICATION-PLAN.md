# Odoo 全量复刻计划

> 目标：完整复刻客户在 Odoo 中的使用习惯，逻辑不简化，初始演示数据适量导入。
> Pricelist 和客户初始各导入 **5 条**（隐私保护，避免一次性取走全部数据）；
> 商品从 Odoo 导出的 CSV 导入 **50 条**，字段与 Odoo 保持一致；
> Pricelist 管理界面**完整复刻 Odoo**，支持完整 CRUD。

---

## 一、现状 vs 目标差距分析

| 维度 | 现有 Demo | Odoo 原有 | 差距 |
|------|-----------|-----------|------|
| 商品模型 | 单层 Product，无变体 | Template + Variant，按包装规格拆分变体 | 缺 Template 层，缺 Odoo 字段 |
| 商品数据 | 8 条演示商品（蔬菜） | 1798 条（含变体，多品类） | 导入 50 条真实商品 |
| 定价层次 | 3层：牌价→品类表→客户覆盖 | 1 pricelist per customer，含全局/品类/商品/变体 4 级规则 | 缺嵌套、缺层级 |
| 定价嵌套 | 不支持 | formula 可以 "based on other pricelist" 形成级联 | 完全缺失 |
| 定价范围 | 无最小数量、无日期范围 | 每条 rule 有 min_qty, date_start, date_end | 完全缺失 |
| Pricelist 管理 UI | 无完整 CRUD | Odoo 完整的 pricelist + items 管理界面 | 需完整复刻 |
| 客户字段 | 4个付款选项 | Price Type / Pricelist / 销售员 / 团队 / 付款条款 / 信用额度 / Tags / 佣金 | 缺多个字段 |
| Pricelist 初始数据 | 3张演示表 | 90+ 张 | **演示阶段导入 5 条** |
| 客户初始数据 | 4条演示数据 | 2400+ 条 | **演示阶段导入 5 条** |
| 发票 | 无 | 从销售单生成，跟踪 Open/Paid | 完全缺失 |
| 采购 / 成本历史 | 简单记录 | 成本变动历史，影响 formula 定价基准 | 需增强 |
| 库存 | 无 | 入库 / 出库 / 调整 / 库存盘点 | 需新建 |

---

## ★ 新增要求说明

### 要求 A：初始数据控量（隐私保护）

客户担心数据安全，不希望一次性导出全部数据。**演示阶段策略**：

| 数据类型 | 演示导入数量 | 来源 | 说明 |
|----------|------------|------|------|
| Pricelist | **5 条** | product.pricelist.csv 头 5 条 | 含 TAKEAWAY菜价、TAKEAWAY-2菜价（可演示嵌套） |
| 客户 | **5 条** | res.partner.csv 筛选 5 条 | 覆盖 Multi/Default/Last 三种 Price Type |
| 商品 | **50 条** | product.product.csv 前 50 条 | 覆盖蔬菜/干货/调料等多个品类 |

系统架构支持全量导入，客户信任后可一次性导入所有数据，只需替换 mock-data 文件即可。

### 要求 B：商品字段与 Odoo 一致

Odoo `product.product` 导出字段完整映射：

| Odoo 字段 | 系统字段 | 说明 |
|-----------|---------|------|
| Name | `name` | 英文商品名（如 "Carrot 10kg BAG"） |
| Sale Description | `saleDescription` | 中文名/备注（如 "红萝卜"） |
| Internal Reference | `internalRef` | SKU 编码（如 "CAB"） |
| Sale Price | `listPrice` | 销售牌价（€） |
| Cost | `standardPrice` | 成本价（€） |
| Commission Price | `commissionPrice` | 佣金计算基准（€） |
| Product Category | `categoryId` | 关联产品分类 |
| Product Type | `productType` | "product"=可储存品, "consu"=消耗品 |
| Quantity On Hand | `qtyOnHand` | 当前库存 |
| Forecast Quantity | `qtyForecast` | 预计库存 |
| Internal Reference | `internalRef` | 内部编码/SKU |
| Weight | `weight` | 重量（kg） |
| Sequence | `sequence` | 排序号 |
| Customer Taxes | `customerTaxIds` | 销售税（VAT） |
| Vendor Taxes | `vendorTaxIds` | 采购税 |

### 要求 C：Pricelist 管理界面完整复刻 Odoo

完整的 Pricelist CRUD 界面，对标 Odoo Sales > Pricelists：

1. **Pricelist 列表页**：搜索/筛选，显示名称、货币、规则条数、序号
2. **Pricelist 详情/编辑页**：
   - 基本信息（名称、货币、序号、是否可选）
   - Items 列表（与 Odoo pricelist items 视图一致）
   - 新增/编辑/删除 item
3. **Pricelist Item 编辑器**（对标 Odoo item dialog）：
   - Apply On：All Products / Product Category / Product / Product Variant
   - Min. Quantity
   - Date Start / Date End
   - Compute Price：Fixed Price / Percentage (discount) / Formula
   - Formula 子字段：Based on（Sales Price / Cost / Other Pricelist）、Discount、Extra Fee、Min. Margin、Max. Margin
   - 嵌套 Pricelist 选择器（下拉搜索）
4. **价格预览工具**：输入商品+数量，实时显示价格和解算路径

---

## 二、完整数据模型（TypeScript）

### 2.1 商品系统（与 Odoo 字段完全对齐）

```typescript
// ── 产品分类 ──────────────────────────────────────────────────────────────────
// 从 Odoo product.category 映射（CSV 中以 External ID 引用）
interface ProductCategory {
  id: string
  externalId: string              // "__export__.product_category_51_4991501f"
  name: string                    // "Vegetables" | "Dry Goods" | "Herbs"
  parentId?: string
}

// 演示数据中从 CSV 提取的分类（product_category_XX 去重后建立）：
// cat_51: Vegetables（蔬菜）
// cat_33: Canned/Preserved（罐头/干货）
// cat_40: Herbs（香草香料）
// cat_48: Spices（调味料）
// cat_36: Frozen/Ready Made（冷冻/速食）
// cat_32: Chinese Veg（中国蔬菜）
// cat_42: Condiments（调味品）
// cat_63: Meat（肉类）

// ── 商品（对应 Odoo product.product，单层，无变体层） ──────────────────────
// 注意：Odoo 导出的 product.product 已经是"最终变体"，
// 商品名中含包装规格（如 "Carrot 10kg BAG"），这就是 Odoo 的变体命名方式。
// 本系统直接使用此模型，不再拆分 Template/Variant 两层（简化实现）。

type ProductType = 'product' | 'consu'
// product = 可储存商品（跟踪库存）
// consu   = 消耗品（不跟踪库存，LOOSE 单件销售商品）

interface Product {
  id: string
  externalId: string              // Odoo External ID

  // ── 基本信息 ──────────────────────────────────────
  name: string                    // 英文名 + 规格，如 "Carrot 10kg BAG"
  saleDescription: string         // 中文描述/备注，如 "红萝卜"（来自 Sale Description）
  internalRef: string             // SKU 编码，如 "CAB"
  categoryId: string              // 关联分类

  // ── 价格 ──────────────────────────────────────────
  listPrice: number               // 销售牌价（€）= Odoo "Sale Price"
  standardPrice: number           // 成本价（€）= Odoo "Cost"
  commissionPrice: number         // 佣金基准价（€）= Odoo "Commission Price"

  // ── 税务 ──────────────────────────────────────────
  customerTaxRate: number         // 销售税率（VAT），如 0.135=13.5%, 0.23=23%, 0=0%
  vendorTaxRate: number           // 采购税率

  // ── 库存 ──────────────────────────────────────────
  productType: ProductType        // 商品类型
  qtyOnHand: number               // 当前库存（Quantity On Hand）
  qtyForecast: number             // 预计库存（Forecast Quantity）

  // ── 其他属性 ──────────────────────────────────────
  weight: number                  // 重量（kg）
  sequence: number                // 排序号（用于界面排序）

  // ── 系统字段 ──────────────────────────────────────
  status: 'active' | 'archived'   // 对应 Odoo active 字段
  images: string[]
  createdAt: string
  updatedAt: string
}

// ── 商品新建/编辑表单字段定义 ─────────────────────────────────────────────
// 对应 Odoo 商品表单界面的 Tab 布局：
// Tab 1: General Information（基本信息）
//   - Name, Internal Reference, Category, Product Type
//   - Sale Price, Customer Taxes
//   - Cost, Vendor Taxes
//   - Sale Description（中文备注/描述）
// Tab 2: Purchase（采购）
//   - Commission Price, Weight
// Tab 3: 库存（Stock）
//   - Quantity On Hand（只读，通过采购/调整更新）
//   - Forecast Quantity（只读）

// ── BOM（物料清单 / Kit） ─────────────────────────────────────────────────────
// 示例：1 CASE (AJC) = 10 × PKT，用于库存分拆
interface BomLine {
  componentProductId: string
  quantity: number
}

interface BillOfMaterials {
  id: string
  productId: string               // 成品 ID
  type: 'kit' | 'manufacture'
  quantity: number
  lines: BomLine[]
}
```

### 2.1.1 演示商品数据（50 条，从 product.product.csv 导入）

以下为选取的 50 条，覆盖蔬菜、中式蔬菜、香草、罐头/干货、调料、冷冻品多个分类：

```
蔬菜类（cat_51, 18条）：
  Aubergine CASE (AUC)           €14.50 / cost €12.00
  RTE Avocado CASE (AVC)         €24.50 / cost €18.50
  Butterhead Lettuce CASE (BHLC) €9.50  / cost €7.50
  Beansprout BAG (BSB)           €5.85  / cost €4.60
  Carrot 10kg BAG (CAB)          €9.00  / cost €4.80
  Cauliflower LOOSE (CAFL)       €2.50  / cost €1.85
  Cabbage Red BAG (CRB)          €11.00 / cost €5.85
  Cabbage White BAG (CWB)        €14.50 / cost €10.50
  Chinese Leaf 8's CASE (CLC8)   €23.00 / cost €21.50
  Celery CASE (CEC)              €17.00 / cost €13.00
  Chilli Green CASE (CGC)        €22.50 / cost €17.85
  Chilli Red 3KG/CASE (CRC)      €21.00 / cost €12.00
  Chilli Thai Red 2kg CASE (CTR) €28.00 / cost €24.50
  Cherry Tomato CASE (CTC)       €16.00 / cost €14.50
  Courgette CASE (COC)           €14.00 / cost €7.90
  Cucumber CASE (CUC)            €12.00 / cost €5.00
  Cooking Apple LOOSE (CAL)      €0.60  / cost €0.32
  Cabbage York LOOSE (CYL)       €1.60  / cost €0.95

中式蔬菜（cat_32, 4条）：
  Bitter Melon KG (BMKG)         €9.00  / cost €6.70
  Chinese Cauliflower CASE (CCFC)€29.95 / cost €20.50
  Choisam CASE (CHC7)            €35.00 / cost €20.00
  Chilli Green KG (CGK)          €8.00  / cost €6.00

香草香料（cat_40, 5条）：
  Basil KG (BAK)                 €15.00 / cost €12.15
  Coriander KG (COK)             €13.00 / cost €9.25
  Thin Round Chives PKT (CHP)    €1.90  / cost €1.80
  Black Pepper Powder PKT (BPP)  €6.85  / cost €5.22
  Celery LOOSE (CEL)             €1.50  / cost €0.81

调料/干货（cat_48, 4条）：
  Heera Black Pepper 6*1KG CASE (BPC) €86.00 / cost €69.60
  Heera Black Pepper 10*400g CASE     €65.00 / cost €52.19
  Black Pepper Coarse 1KG PKT (BPC)   €15.95 / cost €11.60
  Cashewnut 10kg TIN (CSN10)          €95.00 / cost €80.00

罐头/调味品（cat_33, 12条）：
  GS Baby Corn 24*425g CASE (BBC)    €24.00 / cost €18.99
  Bamboo Shoot Slice 6*2950g CASE    €24.00 / cost €15.99
  Chaokoh Coconut Milk 6*2900ml CASE €53.00 / cost €47.50
  Chaokoh Coconut Milk 24*400g CASE  €34.00 / cost €28.75
  Coconut Cream 40*200g CASE         €39.50 / cost €34.50
  Cream Corn Stokely 12*404g CASE    €18.50 / cost €14.95
  *Blue Bag* Flour 25Kg (CREM25)     €31.00 / cost €25.50
  *Blue Bag* Flour 8*2KG (CREM82)    €27.50 / cost €21.94
  Cooking Wine 10L DRUM (CW10)       €12.85 / cost €8.24
  Mizkan Rice Vinegar 20L CASE (BJC) €41.00 / cost €34.44

速食/冷冻（cat_36, 5条）：
  Aji Chicken Gyoza 10*600g CASE (AJC) €46.00 / cost €32.50
  Aji Duck Gyoza 10*600g CASE (AJD)    €50.00 / cost €45.50
  Aji Pork Gyoza 10*600g CASE (AJP)    €46.00 / cost €39.00
  Aji Prawn Gyoza 10*600g CASE (AJPR)  €72.50 / cost €66.50
  Aji Veg Gyoza SPINACH 10*600g CASE   €40.00 / cost €34.00

肉类（cat_63, 2条）：
  Duck Pancake BLUE (DPB)                €45.00 / cost €35.50
  C.Vale Steam Cooked Chicken Breast 4*2.5KG (CV) €56.00 / cost €52.50
```

### 2.2 Pricelist 系统（完整 Odoo 等价实现）

```typescript
// ── Pricelist Item（价格规则） ────────────────────────────────────────────────
type PricelistItemApplyOn =
  | 'global'        // 适用所有商品（Odoo: "All Products"）
  | 'category'      // 按产品分类
  | 'product'       // 按商品模板
  | 'variant'       // 按商品变体（最精确）

type PricelistComputeType =
  | 'fixed'         // 固定价格
  | 'percentage'    // 百分比折扣（基于 formulaBase）
  | 'formula'       // 公式（含嵌套 pricelist）

type FormulaBase =
  | 'public_price'  // 基于牌价（listPrice）
  | 'cost'          // 基于成本价（standardPrice）
  | 'other_pricelist' // 基于另一个 pricelist（嵌套）

interface PricelistItem {
  id: string
  // 适用范围
  applyOn: PricelistItemApplyOn
  productTemplateId?: string      // applyOn='product' 时必填
  productVariantId?: string       // applyOn='variant' 时必填
  categoryId?: string             // applyOn='category' 时必填

  // 触发条件
  minQty: number                  // 最小数量（0=无限制）
  dateStart?: string              // ISO, 开始日期
  dateEnd?: string                // ISO, 结束日期

  // 计价方式
  computeType: PricelistComputeType
  fixedPrice?: number             // computeType='fixed' 时
  
  // formula / percentage 共用字段
  formulaBase?: FormulaBase       // 基准来源
  basedOnPricelistId?: string     // formulaBase='other_pricelist' 时，指向嵌套 pricelist
  priceDiscount?: number          // 折扣百分比（0-100），0=不折扣
  priceSurcharge?: number         // 加价金额（€），可负
  priceMinMargin?: number         // 最低利润率保护（可选）
  priceMaxMargin?: number         // 最高利润率上限（可选）

  sequence: number                // 匹配优先级，数字越小越优先
}

// ── Pricelist ─────────────────────────────────────────────────────────────────
interface Pricelist {
  id: string
  externalId: string              // Odoo External ID，如 "__export__.product_pricelist_44_2530682a"
  name: string                    // "TAKEAWAY菜价"
  currency: string                // "EUR"
  items: PricelistItem[]
  sequence: number                // 显示排序
  selectable: boolean             // 是否在销售单中可选
  active: boolean
  updatedAt: string
}
```

### 2.3 客户系统（完整 Odoo 字段）

```typescript
type PriceType =
  | 'multi'         // Multi Price：使用分配的 pricelist
  | 'default'       // Default Price：使用公开牌价
  | 'last'          // Last Price：使用上次销售价格

type PaymentTerms =
  | 'COD'           // Cash on Delivery
  | '15days'        // 15 Days
  | '30net'         // 30 Net Days
  | '45days'        // 45 Days
  | '2months'       // 2 Months

interface Customer {
  id: string
  externalId: string              // Odoo External ID
  name: string
  displayName: string             // 可与 name 不同（别名/简称）

  // 联系信息
  street?: string
  city?: string
  country: string                 // 默认 "Ireland"
  phone?: string
  mobile?: string
  email?: string
  vatNumber?: string              // 爱尔兰格式: IE + 7位数字 + 字母

  // 业务属性
  priceType: PriceType
  pricelistId?: string            // 分配的 pricelist ID（priceType='multi' 时启用）
  paymentTerms: PaymentTerms
  creditLimit?: number            // 信用额度 (€)

  // 销售管理
  salespersonId?: string          // 销售员 ID
  salesTeamId?: string            // 销售团队 ID
  tags: string[]                  // 标签（路区标记如 M1, D1, 或自定义）

  // 佣金
  commissionRate?: number         // 佣金率（0-1）
  commissionFixed?: number        // 固定佣金（€/单）

  // 内部备注
  notes?: string
  active: boolean
  createdAt: string
}

interface Salesperson {
  id: string
  name: string
  email: string
}

interface SalesTeam {
  id: string
  name: string
  salespersonIds: string[]
}
```

### 2.4 销售订单

```typescript
type SaleOrderStatus =
  | 'draft'           // 草稿/询价
  | 'sent'            // 已发送报价
  | 'confirmed'       // 已确认（销售订单）
  | 'wave_assigned'   // 已生成拣货单
  | 'in_delivery'     // 配送中
  | 'completed'       // 已完成（全部交付）
  | 'cancelled'       // 已取消

interface SaleOrderLine {
  id: string
  productVariantId: string
  productName: string
  spec: string                    // 规格描述
  quantity: number
  uomId: string
  unitPrice: number               // 实际使用价格（从 pricelist 解算）
  discount: number                // 折扣% (0=无折扣)
  subtotal: number                // = quantity × unitPrice × (1 - discount/100)
  // 定价溯源（用于展示"价格来自哪条规则"）
  priceSource?: 'pricelist_item' | 'manual' | 'last_price' | 'public_price'
  pricelistItemId?: string
}

interface SaleOrder {
  id: string
  name: string                    // 单号 SO-XXXX
  customerId: string
  customerName: string
  pricelistId?: string            // 下单时使用的 pricelist（从客户默认带入，可手动改）
  lines: SaleOrderLine[]
  totalAmount: number
  status: SaleOrderStatus
  paymentMethod: 'online' | 'cash' | 'account'
  notes?: string
  salespersonId?: string
  // 关联
  invoiceIds: string[]            // 生成的发票 IDs
  waveId?: string
  tripId?: string
  createdAt: string
  confirmedAt?: string
}
```

### 2.5 发票

```typescript
type InvoiceStatus = 'draft' | 'posted' | 'paid' | 'cancelled'

interface InvoiceLine {
  id: string
  productVariantId: string
  description: string
  quantity: number
  unitPrice: number
  discount: number
  taxRate: number                 // 爱尔兰 VAT 13.5% 或 23% 或 0%
  subtotalExTax: number
  subtotalIncTax: number
  saleOrderLineId?: string        // 溯源到销售单行
}

interface Invoice {
  id: string
  name: string                    // 发票号 INV-XXXX
  customerId: string
  customerName: string
  saleOrderIds: string[]          // 可以合并多张销售单
  lines: InvoiceLine[]
  subtotalExTax: number
  totalTax: number
  totalIncTax: number
  amountPaid: number
  amountDue: number
  status: InvoiceStatus
  dueDate?: string
  paymentTerms: PaymentTerms
  notes?: string
  createdAt: string
  postedAt?: string
  paidAt?: string
}
```

### 2.6 采购 & 成本历史

```typescript
type PurchaseOrderStatus = 'draft' | 'confirmed' | 'received' | 'cancelled'

interface PurchaseOrderLine {
  id: string
  productVariantId: string
  productName: string
  quantity: number
  unitCost: number                // 进货单价（€）
  subtotal: number
}

interface PurchaseOrder {
  id: string
  name: string                    // PO-XXXX
  supplierId: string
  lines: PurchaseOrderLine[]
  totalAmount: number
  status: PurchaseOrderStatus
  expectedArrival?: string
  arrivedAt?: string
  createdAt: string
}

// 成本变动历史（每次采购后自动追加一条）
interface CostPriceHistory {
  id: string
  productVariantId: string
  cost: number
  reason: string                  // "采购入库 PO-0012" | "手动调整"
  purchaseOrderId?: string
  recordedAt: string
}
```

### 2.7 库存

```typescript
type StockMoveType = 'in' | 'out' | 'adjustment' | 'return'

interface StockMove {
  id: string
  productVariantId: string
  type: StockMoveType
  quantity: number                // 正数入库，负数出库
  referenceId?: string           // 关联单据 ID（PO/SO/调整单）
  referenceType?: 'purchase' | 'sale' | 'adjustment'
  notes?: string
  createdAt: string
}

// 当前库存快照（计算字段，从 StockMove 汇总）
interface StockOnHand {
  productVariantId: string
  quantity: number
  lastUpdated: string
}
```

---

## 三、定价引擎完整实现

### 3.1 核心算法

```typescript
/**
 * Odoo-compatible pricelist price resolver
 * 
 * 优先级逻辑（Odoo 原版行为）：
 * 1. 在 pricelist.items 中按 sequence 排序
 * 2. 找到第一条 applyOn + minQty + dateRange 全部满足的 item
 * 3. 按 computeType 计算：
 *    - fixed：直接返回 fixedPrice
 *    - percentage：基于 formulaBase 的价格 × (1 - priceDiscount/100) + priceSurcharge
 *    - formula：同 percentage，但 formulaBase='other_pricelist' 时递归解算嵌套 pricelist
 * 4. 如果没有匹配的 item，返回商品牌价（listPrice）
 * 
 * @param depth 递归深度，超过 5 层强制返回牌价（防循环）
 */
function resolvePrice(
  params: {
    productVariantId: string
    productTemplateId: string
    categoryId: string | undefined
    quantity: number
    date: string                  // ISO, 当前日期
    pricelistId: string | null
  },
  allPricelists: Pricelist[],
  products: Map<string, { listPrice: number; standardPrice: number }>,
  costHistory: CostPriceHistory[],
  depth = 0
): number {
  const { productVariantId, productTemplateId, categoryId, quantity, date, pricelistId } = params

  // 兜底：无 pricelist 或递归过深，返回牌价
  if (!pricelistId || depth > 5) {
    return products.get(productVariantId)?.listPrice ?? 0
  }

  const pricelist = allPricelists.find(p => p.id === pricelistId)
  if (!pricelist) return products.get(productVariantId)?.listPrice ?? 0

  // 按 sequence 排序的 items
  const sortedItems = [...pricelist.items].sort((a, b) => a.sequence - b.sequence)

  // 找第一条匹配的 item
  const item = sortedItems.find(item => {
    // 日期范围过滤
    if (item.dateStart && date < item.dateStart) return false
    if (item.dateEnd && date > item.dateEnd) return false
    // 最小数量过滤
    if (quantity < item.minQty) return false
    // 适用范围过滤
    switch (item.applyOn) {
      case 'global': return true
      case 'category': return item.categoryId === categoryId
      case 'product': return item.productTemplateId === productTemplateId
      case 'variant': return item.productVariantId === productVariantId
    }
  })

  if (!item) {
    return products.get(productVariantId)?.listPrice ?? 0
  }

  // fixed
  if (item.computeType === 'fixed') {
    return round2(item.fixedPrice ?? 0)
  }

  // percentage 或 formula：先确定 base 价格
  let basePrice: number
  switch (item.formulaBase) {
    case 'cost': {
      // 最新成本价
      const latest = costHistory
        .filter(h => h.productVariantId === productVariantId)
        .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0]
      basePrice = latest?.cost ?? products.get(productVariantId)?.standardPrice ?? 0
      break
    }
    case 'other_pricelist': {
      // 递归：用嵌套 pricelist 解算
      basePrice = resolvePrice(
        { ...params, pricelistId: item.basedOnPricelistId ?? null },
        allPricelists, products, costHistory, depth + 1
      )
      break
    }
    case 'public_price':
    default: {
      basePrice = products.get(productVariantId)?.listPrice ?? 0
      break
    }
  }

  // 应用折扣和加价
  const discount = item.priceDiscount ?? 0
  const surcharge = item.priceSurcharge ?? 0
  let price = basePrice * (1 - discount / 100) + surcharge

  // 利润率保护（可选）
  const cost = products.get(productVariantId)?.standardPrice ?? 0
  if (item.priceMinMargin !== undefined) {
    price = Math.max(price, cost + item.priceMinMargin)
  }
  if (item.priceMaxMargin !== undefined) {
    price = Math.min(price, cost + item.priceMaxMargin)
  }

  return round2(price)
}

function round2(n: number) { return Math.round(n * 100) / 100 }
```

### 3.2 客户价格解算入口

```typescript
/**
 * 根据客户 priceType 决定最终价格
 */
function getCustomerPrice(
  customerId: string,
  productVariantId: string,
  quantity: number,
  date: string,
  customers: Customer[],
  allPricelists: Pricelist[],
  products: Map<string, { listPrice: number; standardPrice: number }>,
  costHistory: CostPriceHistory[],
  lastSalePrices: Map<string, number>,   // key: `${customerId}_${productVariantId}`
): number {
  const customer = customers.find(c => c.id === customerId)
  if (!customer) return 0

  // 获取商品的 template 和 category（需从 products 查）
  const variant = getVariant(productVariantId)
  const template = getTemplate(variant.templateId)

  switch (customer.priceType) {
    case 'default':
      // 牌价
      return products.get(productVariantId)?.listPrice ?? 0

    case 'last':
      // 上次成交价，没有则回退到牌价
      return lastSalePrices.get(`${customerId}_${productVariantId}`)
        ?? products.get(productVariantId)?.listPrice
        ?? 0

    case 'multi':
    default:
      // 使用分配的 pricelist
      return resolvePrice(
        {
          productVariantId,
          productTemplateId: template.id,
          categoryId: template.categoryId,
          quantity,
          date,
          pricelistId: customer.pricelistId ?? null,
        },
        allPricelists, products, costHistory
      )
  }
}
```

---

## 四、数据导入方案（CSV → 应用数据）

### 4.1 Pricelist 导入（`product.pricelist.csv`）

CSV 共 90+ 条，字段：`External ID, Pricelist Name, Currency, Selectable, Sequence`

**导入脚本逻辑（`scripts/import-pricelists.ts`）：**
```typescript
// 读取 CSV → 生成 Pricelist[]（items 初始为空，后续手动录入或从 Odoo 导出 items CSV）
const pricelists: Pricelist[] = csvRows.map(row => ({
  id: generateId(),
  externalId: row['External ID'],
  name: row['Pricelist Name'],
  currency: 'EUR',
  items: [],
  sequence: parseInt(row['Sequence']) || 99,
  selectable: row['Selectable'] === 'True',
  active: true,
  updatedAt: row['Last Updated on'],
}))
```

**注意**：CSV 里只有 pricelist 头，没有 items 明细。Items 需要从 Odoo 导出 `product.pricelist.item` 的 CSV，或手动在界面维护。

### 4.2 客户导入（`res.partner.csv`）

CSV 共 2400+ 条，字段：`External ID, Display Name, City, Price Type, Pricelist, Street, Notes`

**导入脚本逻辑（`scripts/import-customers.ts`）：**
```typescript
const customers: Customer[] = csvRows
  .filter(row => row['Display Name'] !== 'Administrator')  // 跳过系统账号
  .map(row => {
    // 将 Odoo External ID 映射到本系统的 pricelist ID
    const odooPlId = row['Pricelist']
    const matchedPl = pricelists.find(p => p.externalId === odooPlId)

    // Price Type 映射
    const priceTypeMap: Record<string, PriceType> = {
      'Multi Price': 'multi',
      'Default Price': 'default',
      'Last Price': 'last',
    }

    return {
      id: generateId(),
      externalId: row['External ID'],
      name: row['Display Name'],
      displayName: row['Display Name'],
      city: row['City'] || '',
      street: row['Street'] || '',
      country: 'Ireland',
      priceType: priceTypeMap[row['Price Type']] ?? 'default',
      pricelistId: matchedPl?.id,
      paymentTerms: 'COD',  // 默认，后续可按 Odoo 导出补全
      creditLimit: undefined,
      tags: [],
      notes: row['Notes'] || '',
      active: true,
      createdAt: row['Created on'],
    }
  })
```

---

## 五、UI 界面清单（对应 Odoo 功能）

### 5.1 Pricelist 管理（operator/pricing/pricelists）

| 界面 | 功能 | Odoo 对应页面 |
|------|------|--------------|
| 价格列表 | 列出全部 90+ pricelist，搜索/筛选 | Sales > Pricelists |
| Pricelist 详情 | 编辑 pricelist，增删 items | Pricelist form view |
| Item 编辑器 | 选择 ApplyOn/ComputeType/MinQty/日期/嵌套 pricelist | Pricelist item dialog |
| 批量价格查询 | 输入客户+商品+数量，预览实际价格（含溯源） | 无直接对应，自建 |

### 5.2 客户管理（operator/customers）

| 界面 | 功能 |
|------|------|
| 客户列表 | 2400+ 客户，支持按 pricelist/city/salesperson 筛选 |
| 客户详情 | 完整 Odoo 字段：Price Type、Pricelist、付款条款、信用额度、标签、销售员 |
| 客户订单历史 | 列出该客户所有历史销售单 |
| 客户账期余额 | 当前未付金额 / 信用额度使用情况 |

### 5.3 商品管理（operator/products）

| 界面 | 功能 |
|------|------|
| 商品模板列表 | 按分类浏览，显示变体数量 |
| 商品模板详情 | 基本信息 + 变体列表 + 属性配置 |
| 变体详情 | 单独的牌价/成本价/库存/规格 |
| 成本价历史 | 该变体所有成本变动记录（含来源） |
| BOM 配置 | 配置 Kit 关系（CASE = N × PKT） |

### 5.4 销售订单（operator/orders）

| 界面 | 功能 |
|------|------|
| 创建销售单 | 选客户→自动带入 pricelist→按商品自动显示客户价 |
| 订单详情 | 显示每行价格来源（来自哪条 pricelist rule） |
| 价格手动覆盖 | 在行上手动改价，记录为 manual override |
| 生成发票 | 从销售单一键生成发票 |

### 5.5 发票管理（finance/invoices）

| 界面 | 功能 |
|------|------|
| 发票列表 | 全部发票，状态筛选 Open/Paid/Draft |
| 发票详情 | 含税额计算，VAT 23% / 13.5% / 0% |
| 登记收款 | 标记为 Paid，记录收款日期和金额 |
| 账期汇总 | 按客户汇总：当前欠款 / 逾期 |

### 5.6 采购管理（operator/purchases）

| 界面 | 功能 |
|------|------|
| 采购单列表 | 所有采购单，状态筛选 |
| 创建采购单 | 选供应商 → 添加商品行 → 录入单价 |
| 收货确认 | 确认到货 → 自动更新库存 + 写入成本历史 |

### 5.7 库存管理（warehouse/inventory）

| 界面 | 功能 |
|------|------|
| 库存列表 | 各变体当前库存 |
| 库存调整 | 手动盘点调整（差异原因备注） |
| 库存流水 | 所有 in/out 记录 |

---

## 六、开发分阶段计划

### Phase 1：数据模型升级 + 数据导入（约 2-3 天）

**目标**：替换现有 types.ts 和 mock-data.ts，不破坏现有页面

#### 1.1 数据模型
1. 更新 `lib/types.ts`：
   - 用新 `Product` 接口（含 Odoo 全字段）替换现有简化版
   - 新增 `ProductCategory`、`ProductType`
   - 新增完整 `Pricelist` / `PricelistItem` 接口
   - 新增完整 `Customer` 接口（含 priceType / paymentTerms / salesperson 等）
   - 新增 `CostPriceHistory`、`StockMove`、`Invoice` 接口

#### 1.2 演示数据（精确导入数量）
2. 生成 `lib/seed-products.ts`（**50 条**，来自 product.product.csv）
   - 字段与 Odoo 完全对应
   - 覆盖 8 个产品分类
   - 同时生成 `lib/seed-categories.ts`（8 条分类）

3. 生成 `lib/seed-pricelists.ts`（**5 条**，来自 product.pricelist.csv）
   - 选取：CITY CENTRE菜价、TAKEAWAY菜价、TAKEAWAY-2菜价、M7N3M1菜价、MR CHEN
   - TAKEAWAY-2菜价 的 items 配置 "based on: TAKEAWAY菜价"（演示嵌套效果）
   - 其他 4 条各有 3-5 条 items（覆盖 fixed/percentage/formula 三种类型）

4. 生成 `lib/seed-customers.ts`（**5 条**，来自 res.partner.csv）
   - 选取覆盖：1 条 Multi Price + CITY CENTRE、1 条 Multi Price + TAKEAWAY、
     1 条 Multi Price + TAKEAWAY-2、1 条 Default Price、1 条 Last Price
   - 包含地址、电话、付款条款字段

#### 1.3 定价引擎
5. 新建 `lib/pricing-engine.ts`：完整实现（见第三节算法）
6. 兼容层：`lib/pricing.ts` 中的 `resolvePrice()` 委托给新引擎

**验收**：
- 50 条商品所有字段与 Odoo CSV 一一对应，无截断
- `resolvePrice()` 嵌套测试通过：TAKEAWAY-2菜价 → TAKEAWAY菜价 → item 规则 → 正确价格
- 所有现有页面不报错

### Phase 2：Pricelist 管理 UI（完整复刻 Odoo）（约 3-4 天）

**目标**：操作员可以完整 CRUD 所有 pricelist 和 items，界面与 Odoo 一致

#### 2.1 Pricelist 列表页 `app/operator/pricing/pricelists/page.tsx`

布局对标 Odoo Sales > Pricelists：
- 顶部：「新建 Pricelist」按钮（右上角）
- 搜索框（按名称搜索）
- 表格列：名称 | 货币 | 规则数量 | 序号 | 可选择 | 最后更新 | 操作（查看/编辑/删除）
- 点击行 → 跳转详情页
- 支持按序号排序

#### 2.2 Pricelist 详情/编辑页 `app/operator/pricing/pricelists/[id]/page.tsx`

**顶部面包屑**：Pricelists > [名称]

**基本信息 Card**（对应 Odoo pricelist form 顶部）：
```
名称 [文本输入]          货币 [EUR 固定]
序号 [数字输入]          可在销售单选择 [开关]
```

**Rules / Items 表格**（对应 Odoo pricelist items tab）：

列：Apply On | 目标（商品/分类名）| Min Qty | Date Start | Date End | Compute Price | Price / Discount | 操作

每行操作：编辑（铅笔图标）| 删除（垃圾桶图标）

表格底部：「添加规则」按钮

**价格预览区**（Odoo 没有但客户需要）：
- 输入：选商品 + 输入数量 → 即时显示该 pricelist 下的价格
- 显示解算路径（"命中 rule #2: 85% of TAKEAWAY菜价 rule #1: Fixed €8.50"）

**保存按钮** + **删除 Pricelist 按钮**

#### 2.3 Pricelist Item 编辑器 `components/pricelist-item-dialog.tsx`

对标 Odoo "Add/Edit a Pricelist Item" 弹窗，完整字段：

**第一行：Apply On**
```
○ All Products  ○ Product Category  ○ Product  ○ Product Variant
```
当选 Category / Product / Variant 时，显示对应的搜索下拉框

**第二行：Min. Quantity**
```
Min. Quantity: [数字输入，默认 0]
```

**第三行：Date Range（可选）**
```
Start Date: [日期选择]    End Date: [日期选择]
```

**第四行：Compute Price**
```
○ Fixed Price      → 显示 "Fixed Price: €[输入框]"
○ Discount         → 显示 "Based on: [Sales Price/Cost/Other Pricelist下拉] Discount: [%输入]%"
○ Formula          → 显示完整公式字段（见下）
```

**Formula 子字段**（仅 Formula 模式显示，对标 Odoo）：
```
Based on:  [Sales Price ▼ / Cost / Other Pricelist]
              └─ 选 Other Pricelist 时：[pricelist 搜索下拉]（支持实时搜索 5 条演示 pricelist）
Discount:  [数字]  %
Extra Fee: € [数字]（可正可负）
Min. Margin: € [数字]（可选）
Max. Margin: € [数字]（可选）
```

**保存/取消按钮**

表单验证：
- Fixed Price 模式：价格不能为负
- Formula 选 Other Pricelist 时：不能选自己（防止直接循环）
- Sequence 自动递增（最大 sequence + 10）

#### 2.4 价格预览工具 `app/operator/pricing/preview/page.tsx`

```
选择客户: [搜索下拉]  →  自动显示客户的 priceType 和 pricelist
选择商品: [搜索下拉]
数量: [数字输入]
日期: [日期选择，默认今天]

[计算价格] 按钮

─────────── 结果 ───────────
最终价格: €23.00

解算路径:
  客户: Good World (Multi Price, TAKEAWAY-2菜价)
  ↓ TAKEAWAY-2菜价 查找规则...
  ↓ Rule #1: All Products, Formula, Based on: TAKEAWAY菜价, Discount: 0%
  ↓ 递归解算 TAKEAWAY菜价...
    ↓ TAKEAWAY菜价 查找规则...
    ↓ Rule #3: Product = "Carrot 10kg BAG", Fixed Price: €23.00
  ↓ base = €23.00 × (1 - 0%) = €23.00
最终: €23.00
```

**验收**：
- 从列表可以看到 5 条演示 pricelist
- 可以新建 pricelist（名称、货币、序号、可选择）
- 可以为 pricelist 添加各类 item（4 种 applyOn × 3 种 computeType）
- 嵌套选择器：选 Other Pricelist 时可以从下拉中选择其他 pricelist
- 价格预览工具展示完整嵌套解算路径（TAKEAWAY-2 → TAKEAWAY）
- item 编辑/删除/重排序正常

### Phase 3：客户管理 UI 升级（约 2 天）

**目标**：客户详情页显示所有 Odoo 字段，支持 pricelist 分配

1. 升级 `app/operator/customers/[id]/page.tsx`：
   - 添加 Price Type 显示/编辑
   - 添加 Pricelist 选择器（从 90+ 条中搜索选择）
   - 添加付款条款、信用额度、标签、销售员字段
2. 客户列表增加按 pricelist 筛选

**验收**：
- 可以给客户分配 TAKEAWAY菜价 pricelist
- 可以将 Price Type 改为 Multi Price / Default Price / Last Price

### Phase 4：销售单定价集成（约 2 天）

**目标**：创建销售单时自动按客户 pricelist 显示正确价格

1. 升级订单创建页：选择客户后自动带入 pricelistId
2. 添加商品行时调用 `getCustomerPrice()` 计算单价
3. 每行显示价格来源标记（"来自 TAKEAWAY菜价 rule #3"）
4. 支持手动覆盖单行价格（记录为 manual）

**验收**：
- 为 TAKEAWAY菜价 客户创建订单，价格正确
- 为 TAKEAWAY-2菜价 客户创建订单，价格通过嵌套正确继承

### Phase 5：发票模块（约 2-3 天）

1. `app/finance/invoices/page.tsx` — 发票列表
2. `app/finance/invoices/[id]/page.tsx` — 发票详情（含 VAT 计算）
3. 从销售单生成发票的 action
4. 登记收款功能
5. 账期汇总视图

### Phase 6：采购 & 成本历史（约 1-2 天）

1. 升级采购单，收货时写入 `CostPriceHistory`
2. 商品详情页显示成本变动历史图表
3. formula 定价在计算时正确取最新成本

### Phase 7：库存模块（约 1-2 天）

1. 库存列表：按变体展示当前库存
2. 库存调整：手动录入差异
3. 库存流水：按商品查看 in/out 历史

---

## 七、关键技术决策

### 1. 数据存储：维持 in-memory mock，不引入数据库

现有架构是纯 in-memory（Zustand store + mock-data）。全量导入 90+ pricelist 和 2400+ 客户后，内存占用约 3-5MB，在浏览器中完全可行。无需引入 Prisma/PostgreSQL 即可完整演示所有功能。

若未来需要持久化，只需将 mock-data-v2.ts 替换为 Prisma 查询，接口层不变。

### 2. Pricelist Items 的初始数据

从 `product.pricelist.csv` 只能导入 pricelist 头，**Items 不在这个 CSV 中**。处理方案：
- **方案 A**：请客户从 Odoo 导出 `product.pricelist.item` 的 CSV（推荐）
- **方案 B**：根据截图中的信息，手动录入关键 pricelist 的 items（如 TAKEAWAY菜价、CITY CENTRE菜价 等高频使用的）
- **方案 C**：先建好 pricelist 头+UI，让客户自己在界面上录入 items

### 3. 嵌套循环防护

`resolvePrice()` 中的 `depth > 5` 保护。实际上 Odoo 也不允许循环引用，UI 上创建 item 时要做校验：不能选择会导致循环的 pricelist。

### 4. Price Type = "Last Price" 的实现

需要在成功完成销售单后，更新 `lastSalePrices` Map（key: `customerId_variantId`），存储在 Zustand store 中。每次销售单 complete 时触发更新。

---

## 八、里程碑时间表

| 里程碑 | 内容 | 预计完成 |
|--------|------|---------|
| M1 | 数据模型 + 定价引擎 + CSV 导入脚本 | Phase 1 完成 |
| M2 | Pricelist 管理 UI（可演示嵌套定价） | Phase 1+2 完成 |
| M3 | 客户管理 + 销售单定价集成 | Phase 1-4 完成 |
| M4 | 发票 + 采购 + 库存 | Phase 1-7 全完成 |

**M2 是最关键的演示节点**：届时可以向客户展示"TAKEAWAY-2菜价继承TAKEAWAY菜价"的嵌套效果，建立信心。

---

## 九、销售单工作流与库存字段业务逻辑

> 本节记录客户在 Odoo 中的实际销售流程，以及各库存字段的准确含义。
> 系统实现必须与此节描述完全一致。

---

### 9.1 完整销售流程（4 步）

```
[第1步] 销售员代餐馆创建报价单（Quotation）
         ↓  点击「确认订单」
[第2步] 报价单变为销售单（Sale Order）→ 预测库存(Forecast)减少
         ↓  出库/配送
[第3步] 销售处理库存（发货/配送）→ 实物库存(On Hand)减少
         ↓  生成发票
[第4步] 生成发票（Invoice）→ 跟踪付款状态
```

---

### 9.2 订单状态定义

| 系统状态 | Odoo 对应 | 中文名 | 说明 |
|----------|-----------|--------|------|
| `PENDING` | Quotation / Draft | 报价单 | 初始状态，尚未确认；库存不受影响 |
| `CONFIRMED` | Sale Order / Confirmed | 销售单 | 已确认；Forecast 库存减少（实物未动） |
| `WAVE_ASSIGNED` | — | 已分配波次 | 已分配到配送计划（等待出库） |
| `IN_DELIVERY` | — | 配送中 | 实物已出库；On Hand 减少 |
| `COMPLETED` | Done | 已完成 | 配送完成；可生成发票 |

---

### 9.3 库存字段定义（每条订单行）

| 字段名 | Odoo 列名 | 数据来源 | 含义 |
|--------|-----------|---------|------|
| **Ordered Qty**（订购数量） | Ordered Quantities | 订单行 `quantity` | 销售员填写的本次订购数量；**只有此字段可在编辑模式下修改** |
| **Forecast Quantity**（预测库存） | Forecast Quantity | 动态计算 | `qtyOnHand - Σ(所有CONFIRMED且未出库订单的该品订购量)`；确认订单时减少 |
| **Quantity On Hand**（现有库存） | Quantity On Hand | `Product.qtyOnHand` | 仓库中实际在手数量；仅在实物出库（配送）时减少 |
| **Delivered Quantity**（已交货数量） | Delivered Quantities | 配送记录 | 本订单实际已配送给客户的数量；初始为 0 |
| **Invoiced Quantity**（已开票数量） | Invoiced Quantities | 发票记录 | 本订单已生成发票的数量；初始为 0 |

**关键规则**：
- Forecast Qty = On Hand - 所有已确认（CONFIRMED 及以上）但未完成配送的订单预留量
- On Hand 只在实物出库时改变，与「确认订单」操作无关
- Ordered Qty、Forecast Qty、On Hand 均以订单行的 UoM（计量单位）为基准

---

### 9.4 各操作对库存的影响

| 操作 | Ordered Qty | Forecast Qty | On Hand | Delivered Qty | Invoiced Qty |
|------|-------------|--------------|---------|--------------|-------------|
| 创建报价单（PENDING） | 写入 | 不变 | 不变 | 0 | 0 |
| 确认订单（→CONFIRMED） | 不变 | **减少** | 不变 | 不变 | 不变 |
| 撤回报价（→PENDING） | 不变 | **恢复** | 不变 | 不变 | 不变 |
| 出库/配送（→IN_DELIVERY） | 不变 | 不变 | **减少** | **增加** | 不变 |
| 完成配送（→COMPLETED） | 不变 | 不变 | 不变 | 确认最终值 | 不变 |
| 生成发票 | 不变 | 不变 | 不变 | 不变 | **增加** |

---

### 9.5 编辑模式字段权限

在编辑订单时，字段可编辑性规则如下：

| 字段 | 可编辑状态（PENDING） | 可编辑状态（CONFIRMED） | 说明 |
|------|---------------------|----------------------|------|
| 商品描述（Description） | ✅ 可编辑 | ✅ 可编辑 | 备注信息 |
| 订购数量（Ordered Qty） | ✅ 可编辑 | ✅ 可编辑 | 确认后修改数量需重新计算 Forecast |
| 单价（Unit Price） | ✅ 可编辑 | ✅ 可编辑 | 允许手工覆盖定价 |
| 预测库存（Forecast Qty） | ❌ 只读 | ❌ 只读 | 系统自动计算 |
| 现有库存（On Hand） | ❌ 只读 | ❌ 只读 | 仓库实物数量 |
| 已交货数量（Delivered Qty） | ❌ 只读 | ❌ 只读 | 由配送操作写入 |
| 已开票数量（Invoiced Qty） | ❌ 只读 | ❌ 只读 | 由发票操作写入 |
| 计量单位（UoM） | ❌ 只读 | ❌ 只读 | 与商品绑定，不可单独改 |

---

### 9.6 报价单列表（Quotation List）功能

- 显示所有 `PENDING` 状态订单
- 支持按报价日期排序（默认最新优先）
- 支持按客户、销售员筛选
- 点击进入报价单详情，可修改：
  - 报价日期（Quotation Date）
  - 交货日期（Delivery Date）
  - 订单行（商品、数量、单价）
- 点击「确认订单」→ 状态变为 CONFIRMED，进入销售单列表

---

### 9.7 销售单列表（Sale Order List）功能

- 显示所有 `CONFIRMED` 及以上状态订单
- 支持按确认日期/交货日期排序
- 支持多维度筛选：
  - 按状态（CONFIRMED / IN_DELIVERY / COMPLETED）
  - 按客户、销售员
  - **按星期几筛选交货日期**（如筛选"周二配送"的订单）
- 点击进入销售单详情：
  - 「撤回」（Withdraw）→ 状态退回 PENDING，变回报价单，可再次修改
  - 修改已确认订单的数量时，自动重算 Forecast Qty

---

### 9.8 实现约束（开发必须遵守）

1. **创建报价单（POST /api/orders）时，禁止扣减 `qtyOnHand`**
   - 报价单处于 PENDING 状态，尚未确认，不应占用任何库存
   - 库存检查（是否充足）应推迟到「确认」时进行

2. **确认订单（PUT /api/orders/:id，status: CONFIRMED）时**：
   - 执行库存充足性检查（forecastQty 是否足够）
   - 更新 `Product.qtyOnHand`（减去 orderedQty）作为预留代理
   - 写入 `StockMove`（type: `RESERVATION`，表示预留而非出库）

3. **撤回报价（PUT /api/orders/:id，CONFIRMED→PENDING）时**：
   - 恢复 `Product.qtyOnHand`（加回 orderedQty）
   - 写入 `StockMove`（type: `RESERVATION_CANCEL`）

4. **实物出库（→IN_DELIVERY）时**：
   - `qtyOnHand` 已在确认时扣减，此步骤更新 deliveredQty
   - 写入 `StockMove`（type: `OUT`，记录实际出库流水）

---

## 十、Quotations / Sales Orders 列表页功能规范

### 10.1 列定义（对标 Odoo Sales → Quotations 视图）

| # | 列名 | 数据来源 | 筛选类型 | 说明 |
|---|------|----------|----------|------|
| 0 | ☑ 复选框 | — | — | 多选用于批量操作 |
| 1 | 报价单号 | `order.code` | 文本搜索 | 格式 CJ-YYMMDD-NNN |
| 2 | 报价日期 | `order.quotationDate` | 日期范围（From/To） | 报价单创建日期 |
| 3 | 客户 | `order.restaurantName` | 文本搜索 | 含信用超额红色徽标 |
| 4 | 创建人 | `order.createdByName` | 文本搜索 | 下单操作人 |
| 5 | 业务员 | `customer.salesman` | 文本搜索 | 客户归属业务员 |
| 6 | 销售团队 | `customer.salesTeam` | 文本搜索 | 客户归属销售团队 |
| 7 | 金额 | `order.totalAmount` | — | 含货币符号 € |
| 8 | 退货 | 布尔占位 | 下拉（全部/是/否） | 当前阶段固定为否，后续退货模块接入 |
| 9 | 开票状态 | 计算字段 | 下拉枚举 | 见 10.3 |
| 10 | 状态 | `order.status` | 下拉枚举 | 见 10.4 |
| 11 | 内部备注 | `order.internalNote` | 文本搜索 | 最多 30 字 |
| 12 | 创建日期 | `order.createdAt` | 日期范围（From/To） | 系统写入时间戳 |
| 13 | 交货星期 | `order.deliveryDate` | 按星期筛选 | 周一~周日下拉 |

### 10.2 列头内联筛选行（Inline Column Header Filter Row）

- 在表头行（`<thead>`）下方增加第二行 **筛选输入行**，每列正下方放对应筛选控件
- 筛选控件类型：
  - **文本搜索**：`<input type="text" placeholder="搜索…">` 触发 `contains` 匹配（不区分大小写）
  - **日期范围**：并排两个 `<input type="date">`（From / To）
  - **下拉枚举**：`<select>` 含"全部"选项

### 10.3 开票状态（Invoice Status）计算规则

| 计算条件 | 显示标签 | 颜色 |
|----------|----------|------|
| 订单未完成（非 COMPLETED）且无关联 Invoice | 无需开票 | 灰 |
| 订单已完成（COMPLETED）且无关联 Invoice | 待开票 | 橙 |
| 订单已完成且有关联 Invoice（已记账/已支付） | 已全额开票 | 绿 |

### 10.4 状态（Order Status）枚举对照

| 系统值 | Odoo 标签 | 中文标签 |
|--------|-----------|----------|
| PENDING | Quotation / Draft | 报价单 |
| CONFIRMED | Sales Order | 已确认 |
| WAVE_ASSIGNED | Ready | 已生成拣货单 |
| IN_DELIVERY | Delivery | 配送中 |
| COMPLETED | Done | 已完成 |

### 10.5 全局 Filter Bar（顶部筛选栏）

位于视图切换 Tab 下方，包含三个功能区：

**① 快捷筛选（Quick Filters）**
- 「今日订单」：筛选 `quotationDate` 或 `createdAt` 落在今天的订单，**默认激活**
- 用户可点击取消激活

**② 分组（Group By）**
- 按以下字段对表格行分组，激活时不分页，显示分组标题行
- 分组选项：客户、业务员、销售团队、状态、交货星期

**③ 常用筛选（Favourites）**
- 点击"收藏当前筛选"：将当前 `colFilters + tabFilter + viewMode + orderTodayActive + groupBy` 保存到 `localStorage`（key: `veggie_order_favourites`）
- 保存时弹出命名输入框，输入筛选集名称
- 点击已保存筛选可一键恢复
- 可删除单条已保存筛选

### 10.6 筛选管道（Filter Pipeline）

```
所有订单
  ↓ viewMode（报价单 PENDING / 销售单 非PENDING）
  ↓ orderTodayActive（quotationDate 或 createdAt = today）
  ↓ tabFilter（状态快捷 Tab：全部 / 待开票 / 已确认 / …）
  ↓ colFilters（13 列内联筛选，全部 AND 关系）
  ↓ groupBy（按字段分组）
  ↓ 分页（PAGE_SIZE=40，groupBy 激活时不分页）
```

---

## 十一、待客户确认的信息

1. **Pricelist Items 数据**：是否可以从 Odoo 导出 `product.pricelist.item` 的 CSV？这样可以直接导入所有规则，否则需要手动录入。

2. **Product 数据**：是否可以导出 `product.template` 和 `product.product` 的 CSV？包含所有商品变体的牌价和成本价。

3. **客户付款条款**：`res.partner.csv` 中没有 payment terms 字段，是否有另一个 CSV 含这个信息？

4. **功能范围确认**：是否需要在 Phase 1 就迁移全部 2400+ 客户数据，还是先用少量测试数据验证逻辑后再全量导入？

---

## 十、完整业务流程与产品需求（2026-04-27 客户访谈整理）

### 10.1 整体流程概览

```
报价单 (Quotation / PENDING)
    ↓ 销售点击「确认订单」
销售订单 (Sale Order / CONFIRMED)  ←── 在此安排司机 + 批次
    ↓ 仓库按批次配货出库
货物 + 送货单（含 QR Code）随司机出发
    ↓
司机送达客户，客户签收（现金客户当场付钱）
    ↓
司机返回，将送货单交给会计
    ↓
会计核销 —— 扫码 / 手动确认「单子回来了没」
    ↓ 有问题的单子（退货/报废/改价）
销售处理 Return / Scrap / Price 调整
    ↓
会计生成 Invoice（可多单合并）
    ↓
客户付款 → Invoice 标记 Paid
```

---

### 10.2 司机分配与批次管理

#### 业务规则

- 每天分多个**批次**，每批次对应一名司机
- 批次+司机名合并为**一个字段**存储，格式：`{批次} {司机名}`
  - 示例：`1 am BAO`、`2 am AFZAAL`、`1 pm YIWEI`
- 批次代码约定：

| 批次代码 | 送货时段 |
|---------|---------|
| `1 am` | 早晨第 1 批 |
| `2 am` | 早晨第 2 批 |
| `1 pm` | 下午第 1 批 |
| `2 pm` | 下午第 2 批 |
| `3 am` / `3 pm` … | 可按需扩展 |

#### 分配时机

- **报价单阶段**：销售可选填，不强制（销售不一定知道当天司机安排）
- **Sale Order 阶段（确认后）**：最终确认，统一在订单列表行内操作

#### 操作方式

- 订单列表每行有一个「批次+司机」下拉，**直接在列表行内修改**，不需要进详情页
- 下拉选项来自预定义 Odoo team_id 列表（约 100 个选项）
- 支持按批次筛选，支持 Group by 批次

#### 仓库价值

- 系统知道：`1 am` 批次送哪些客户、需要哪些货 → 仓库按批次打印拣货单、提前备货
- 系统知道：每个司机应收多少现金回来 → 会计核对更简单

---

### 10.3 客户指定送货时间

- 餐馆在下单时会指定期望的**送货日期/时间**（`deliveryDate` 字段）
- 订单确认后，销售或会计仍可修改
- 送货时间是安排批次的主要依据：早上送/下午送

---

### 10.4 送货单与 QR Code

- 每张订单确认后，系统生成对应**送货单（Delivery Slip）**
- 送货单上印有**QR Code**，编码内容为订单 ID 或 Invoice 编号
- 司机出发时携带：货物 + 该批次所有订单的送货单
- QR Code 用途：会计扫码核销，一扫即标记「单子已回来」

---

### 10.5 会计核销流程（漏单核查）

#### 漏单定义

| 漏单类型 | 描述 | 严重程度 |
|---------|------|---------|
| 未拣货 | 仓库漏备货，货没出去 | 高 |
| 未送达 | 司机漏送某客户 | 高 |
| **单子未回** ⭐ | 货送出去了但送货单没带回 | **最主要**，尤其现金单 |

#### 为什么「单子未回」最危险

- 现金客户 = 司机收了现金，但没把收据带回 → **丢钱丢单，无从追查**
- 系统记录：每个司机该带多少现金回来，若核销时金额不对立刻发现

#### 核销操作方式（两种）

**方式 A — 扫码批量核销（推荐）：**
1. 司机把一叠送货单交给会计
2. 会计用扫码枪逐张扫送货单上的 QR Code
3. 系统自动批量标记：`orderReturn = true`（单子已回）
4. 未被扫到的订单 = 漏单，系统自动列出

**方式 B — 手动核销：**
- 在核销页面，会计勾选已回来的订单，批量点击「确认回单」
- 适用于：QR Code 损坏 / 无扫码枪的场景

#### 核销页面功能需求

- **角色入口**：登录页增加「会计」角色一键登录
- **默认视图**：今日已出库（CONFIRMED / IN_DELIVERY）且 `orderReturn = false` 的订单
- **漏单高亮**：超过预期送达时间但仍未回单的订单标红提示
- **业务引导**：页面顶部显示今日业务摘要 + 操作步骤引导（step-by-step）
- **批量操作**：全选 / 多选 → 一键标记回单
- **扫码入口**：页面显著位置有「开始扫码」按钮，扫码后实时更新状态
- **统计看板**：今日应回单数 / 已回单数 / 漏单数 / 应收现金 / 已核现金

---

### 10.6 问题单处理（销售负责）

送货后有问题的订单由销售处理，会计不直接操作：

| 操作 | 场景 |
|------|------|
| **Return** | 客户拒收 / 部分退货 |
| **Scrap** | 货物损坏报废 |
| **Price 调整** | 送货后发现价格错误 |

处理完成后，会计再基于最终金额生成 Invoice。

---

### 10.7 Invoice 生成（会计负责）

- 问题单处理完毕后，会计在系统中创建 Invoice
- 支持：一张订单 → 一张 Invoice
- 支持：多张订单合并 → 一张 Invoice（同一客户）
- Invoice 状态：Draft → Posted → Paid

---

### 10.8 库存变化时机

| 操作 | 库存变化 |
|------|---------|
| 订单确认（PENDING → CONFIRMED） | `qtyOnHand` 减少（预留） |
| 撤回订单（CONFIRMED → PENDING） | `qtyOnHand` 恢复 |
| 货物全部出库完成 | 销售做库存盘点/调整，`qtyOnHand` 最终确认 |
| Return | `qtyOnHand` 增加（退货入库） |

---

### 10.9 角色与权限矩阵

| 角色 | 主要职责 | 可访问模块 |
|------|---------|-----------|
| **销售 (Sales)** | 创建报价单、确认订单、安排司机、处理 Return/Scrap/Price | 订单列表、报价单、库存调整 |
| **会计 (Accountant)** | 核销漏单（扫码）、生成 Invoice、核对现金 | 核销页面、Invoice 管理、只读订单列表 |
| **运营 (Operator)** | 全局管理、查看所有数据 | 全部模块 |
| **司机 (Driver)** | 查看当日送货任务（未来扩展） | 配送单列表（只读） |

---

### 10.10 数据模型补充：批次字段

在 `Order` 模型上增加字段：

```typescript
interface Order {
  // ... 现有字段 ...
  deliveryBatch?: string   // 批次+司机，格式: "1 am BAO" | "2 pm AFZAAL" | null
  // deliveryDate 已有，无需新增
  // orderReturn 已有，无需新增
}
```

送货单（DeliverySlip）已有关联，QR Code 在送货单打印时生成，编码订单 ID。

---

### 10.11 核销页面：扫码枪联动多选 + 批量核销（Odoo Mass Editing 模式）

#### 背景

会计在用扫码枪逐张扫送货单时，每扫一张应**自动勾选该订单的复选框**，而不是立即单条核销。全部扫完后，会计统一点击「批量核销」一次提交。这与 Odoo 的 Mass Editing 工作流一致：

> 扫码枪扫描 → 订单高亮 + 自动勾选 → Action → Mass Editing → 批量写 `orderReturn = true`

#### 功能需求

**1. 复选框列（列表首列）**

- 每行订单前显示 checkbox
- 表头有「全选 / 取消全选」checkbox
- 已核销（`orderReturn = true`）的行复选框默认不可选（置灰），但仍可手动强制选择

**2. 扫码枪输入联动**

- 页面保留「扫码 / 输入单号」输入框（常驻聚焦，不自动提交）
- 扫码枪扫描后：
  - 若订单存在 → **在列表中高亮并自动勾选该行**，同时滚动至该行
  - 若已核销 → 高亮行，显示「已核销」提示，**不重复勾选**
  - 若找不到 → 显示「找不到订单」错误提示
- 每次扫码后输入框自动清空，等待下一次扫描
- 每次扫码附加视觉反馈（Beep 效果由浏览器 AudioContext 实现，可选）

**3. 选中后浮现 Action Bar**

当有任意订单被勾选时，页面顶部（或底部固定栏）浮现 Action 操作条：

```
[已选 N 张]  [Action ▼]  [取消选择]
```

Action 下拉菜单选项（对应 Odoo Sales Order Action 菜单）：

| 选项 | 操作 | 权限 |
|------|------|------|
| **批量核销** (Mass Editing: Return) | 将选中订单的 `orderReturn` 设为 `true` | FINANCE |
| **批量撤销核销** | 将选中订单的 `orderReturn` 设为 `false` | FINANCE |

**4. 批量提交**

点击「批量核销」：

1. 调用 `POST /api/orders/bulk`，body: `{ action: 'mark_returned', ids: [...], value: true }`
2. 成功后刷新列表，已核销行变为绿色，取消勾选
3. 失败时显示错误，保持勾选状态

#### API 变更：`/api/orders/bulk` 新增 action

```typescript
// 新增 action: 'mark_returned'
type BulkAction = 'cancel' | 'delete' | 'mark_returned' | 'confirm'

// mark_returned body
{ action: 'mark_returned', ids: string[], value: boolean }
// → UPDATE Order SET orderReturn = value WHERE id IN (ids)
// → 权限：FINANCE（核销）或 OPERATOR/BOSS（管理员覆盖）

// confirm body
{ action: 'confirm', ids: string[] }
// → UPDATE Order SET status = 'confirmed' WHERE id IN (ids) AND status = 'pending'
// → 权限：OPERATOR / BOSS
```

---

### 10.12 运营订单页：Odoo 风格 Action 菜单

#### 背景

对标 Odoo Sales 模块的 Action 下拉菜单，运营在订单列表选中多条后，通过 Action 执行批量操作，而不是点击独立按钮。

#### 功能需求

**1. Action 下拉按钮**

在订单列表顶部操作栏，当有订单被勾选时显示：

```
[Action ▼]
```

下拉菜单包含（根据当前选中订单状态动态启用/禁用）：

| 菜单项 | 操作 | 启用条件 |
|--------|------|---------|
| **Confirm Quotation** | 将 PENDING 订单批量设为 CONFIRMED | 仅当选中的订单中有 PENDING 状态时可用 |
| **Cancel Sale / Quotation** | 将选中订单设为 CANCELLED | 选中订单不全为 COMPLETED |
| **BATCH Validate Delivery Orders** | 将 CONFIRMED 订单批量设为 IN_DELIVERY（模拟 Odoo 批量验货出库） | 仅当选中中有 CONFIRMED 状态时可用 |
| **BATCH Create Invoices** | 为 COMPLETED 订单批量生成 Invoice 草稿 | 仅当选中中有 COMPLETED 状态时可用 |
| **Mass Editing (Sale Order)** | 打开批量字段编辑弹框，允许统一修改 deliveryBatch / deliveryDate 等字段 | 任意选中时可用 |

**2. Confirm Quotation 流程**

- 仅对 PENDING 状态的订单有效（其他状态跳过）
- 调用 `POST /api/orders/bulk { action: 'confirm', ids: [...] }`
- 成功后 toast 提示「已确认 N 张报价单」
- 失败时显示错误信息

**3. Mass Editing 弹框**

弹出对话框，会计/运营可批量设置以下字段（空值表示不修改）：

| 字段 | 控件类型 | 说明 |
|------|---------|------|
| `deliveryBatch` | Select（批次选项） | 批量分配司机批次 |
| `deliveryDate` | Date picker | 修改预计送达日期 |
| `paymentMethod` | Select（CASH / ONLINE） | 修改付款方式 |

确认后调用 `PATCH /api/orders/bulk { action: 'mass_edit', ids, fields: {...} }`

**4. BATCH Validate Delivery Orders**

- 将选中的 CONFIRMED 订单状态更新为 IN_DELIVERY
- 调用 `POST /api/orders/bulk { action: 'start_delivery', ids: [...] }`
- 成功后提示「N 张订单已开始配送」

**5. Cancel Sale / Quotation**

- 现有 Cancel 操作迁移到 Action 菜单中（保持现有 API，仅 UI 入口变更）
- 调用 `POST /api/orders/bulk { action: 'cancel', ids: [...] }`

---

### 10.13 UI 交互规范：行高亮与选中状态

#### 扫码/手动选中高亮（会计核销页）

| 状态 | 视觉效果 |
|------|---------|
| 刚刚被扫码命中 | 行背景闪烁（pulse 动画），持续 2 秒后恢复 |
| 已勾选 | 行背景 `bg-amber-50`，左侧显示勾选色边框 |
| 已核销（`orderReturn = true`） | 行背景白色，文字颜色减淡，复选框置灰 |
| 漏单 + 现付 | 行背景 `bg-red-50`（最高优先级） |
| 漏单 + 其他 | 行背景 `bg-yellow-50` |

#### 复选框全选逻辑

- 「全选」只选当前**可勾选**（未核销）的行
- 选中数量 / 总数量显示在 Action Bar：「已选 3 / 8 张」
- 切换筛选条件后保留已选 ID，但若行已被筛掉则不计入显示

---

### 10.14 新功能实现优先级（开发排期建议）

| 优先级 | 功能 | 涉及文件 |
|--------|------|---------|
| P0 | `/api/orders/bulk` 新增 `mark_returned` + `confirm` action | `app/api/orders/bulk/route.ts` |
| P0 | 会计核销页：复选框 + 扫码联动勾选 + Action Bar 批量核销 | `app/[locale]/accounting/page.tsx` |
| P1 | 运营订单页：Action 下拉菜单（Confirm Quotation + Cancel） | `app/[locale]/operator/orders/page.tsx` |
| P2 | 运营订单页：Mass Editing 弹框（deliveryBatch / deliveryDate） | `app/[locale]/operator/orders/page.tsx` |
| P2 | 运营订单页：BATCH Validate Delivery Orders | `app/api/orders/bulk/route.ts` + orders page |
| P3 | 运营订单页：BATCH Create Invoices | Invoice 模块（后续阶段） |

---

## 11. Quotation 详情页 1:1 复刻（2026-04-29 新增）

### 11.1 业务定义边界

按 Odoo 模型严格区分两种状态：

| 阶段 | DB Status | UI 显示 | 详情页路由 | 可编辑 |
|------|-----------|---------|------------|--------|
| 报价阶段 | `PENDING` | Quotation | `/classic/operator/quotations/[id]` | ✅ 全字段 |
| 已发送报价 | `PENDING` + `sentAt` 不空 | Quotation Sent | `/classic/operator/quotations/[id]` | ✅ 全字段 |
| 销售订单 | `CONFIRMED` / `WAVE_ASSIGNED` / `IN_DELIVERY` | Sales Order | `/operator/orders/[id]` | 部分字段 |
| 完成 | `COMPLETED` | Done | `/operator/orders/[id]` | 仅备注 |
| 锁定 | `LOCKED` | Locked | `/operator/orders/[id]` | 仅查看 |
| 取消 | `CANCELLED` | Cancelled | `/operator/orders/[id]` | 仅查看 |

**核心规则**：Quotation 必须 confirm 之后才算订单。PENDING 阶段的所有视图、入口、操作都归属 Quotation 体系。

### 11.2 页面结构（按截图严格复刻）

#### 区域 1：顶部面包屑
- `Quotations / D146149`
- 紫色超链接 + 灰色分隔 + 单号

#### 区域 2：操作栏
- 左：[Edit] 紫色 / [Create] 灰边 | [Print ▾] [Action ▾]
- 右：`1 / 40` + ‹ ›

#### 区域 3：状态流条
- 左侧三按钮：[Create Invoice]（PENDING 时 disabled）/ [Preview] / [Unlock]
- 右侧：`Quotation > Quotation Sent > Sales Order` 三段
- 当前激活段紫色填充，已通过段灰色加深，未到达段浅灰

#### 区域 4：主信息卡片
- 标题：`D146149`（text-3xl bold）
- 右上：`🚚 1 Delivery` 徽章（trips 数）
- 两列字段：
  - 左：Customer（紫链）/ Balance / Internal Notes
  - 右：Order Date / Sales Team / Pricelist / Payment Terms / Signature / Price Type

#### 区域 5：Tab
- `Order Lines` | Optional Products | Automation Information | Other Information
- 激活 tab：紫色 2px 下划线

#### 区域 6：Order Lines 表格（17 列严格对齐）
1. ▼ 展开
2. NO 行号
3. Product 紫色超链接
4. Description 多行规格
5. Ordered Qty
6. Forecast Quantity
7. Quantity On Hand
8. Delivered Quantity
9. Invoiced Quantity
10. Unit of Measure
11. Unit Price
12. Cost
13. Price 占位按钮
14. Taxes 小标签
15. Cms Price
16. Cms Sub
17. Total

#### 区域 7：底部总计
- 左：Commission Total
- 右：Untaxed Amount / Taxes / **Total** / Margin / Amount Due

#### 区域 8：Chatter（活动时间线）
- 顶栏：[Send message] [Log note] [Schedule activity] | 📎0 Follow 👤3
- 时间线：按日期分组，"Today" / "27 April 2026" 分隔条
- 每条记录：圆形头像 + 用户名（绿色加粗） + 时间灰字 + bullet 列表内容
- 数据源：`GET /api/orders/{id}/audit`，每条 `OrderAuditLog` 渲染
  - `created` → "Sale Order created"
  - `confirmed` → "Quotation confirmed" + Status diff
  - `updated` → 列出 changedFields
  - `note` → 自由文字（用户主动记录）

### 11.3 路由分流（核心修复）

**`/classic/operator/quotations/page.tsx` 行点击**：
```typescript
onClick={() => {
  if (o.status === 'pending') router.push(`${prefix}/classic/operator/quotations/${o.id}`)
  else router.push(`${prefix}/classic/operator/orders/${o.id}`)
}}
```

**`/operator/orders/[id]/page.tsx` 守卫**：
```typescript
useEffect(() => {
  if (order?.status === 'pending') {
    router.replace(`${prefix}/classic/operator/quotations/${order.id}`)
  }
}, [order])
```

**面包屑返回**：
- Quotation 详情 → `/classic/operator/quotations`
- Order 详情 → `/operator/orders`

### 11.4 Schema 增量

```prisma
model Order {
  // ... 既有字段
  /// 报价单发送给客户的时间（决定 Quotation vs Quotation Sent 子状态）
  sentAt    DateTime?
  /// 锁定时间（COMPLETED 状态进一步锁定后不可改）
  lockedAt  DateTime?
}

enum OrderStatus {
  PENDING
  CONFIRMED
  WAVE_ASSIGNED
  IN_DELIVERY
  COMPLETED
  LOCKED       // 新增：完成后锁定，会计开票后置此态
  CANCELLED    // 新增：客户取消报价
}
```

### 11.5 Chatter 组件抽象

抽取 `components/order/OrderChatter.tsx`：
- props：`orderId: string`
- 数据：`apiGet<OrderAuditLog[]>('/api/orders/{id}/audit')`
- 渲染：日期分组时间线 + Send message 输入框
- 子操作：
  - `Send message` → `POST /api/orders/{id}/audit` body `{ action: 'message', detail }`
  - `Log note` → `POST .../audit` body `{ action: 'note', detail }`
  - `Schedule activity` → 占位（未来对接日历）

挂在两个详情页底部：
- `/classic/operator/quotations/[id]/page.tsx`
- `/operator/orders/[id]/page.tsx`（替换原"修改历史"section）

### 11.6 列表过滤规则

| 列表 | 过滤条件 |
|------|----------|
| `/classic/operator/quotations` | status === pending（含 sent） |
| `/classic/operator/orders` | status !== pending（CONFIRMED 及以后） |
| `/operator/orders` | 全部（运营总览） |

### 11.7 实施分包

**PR-A — 主体页面 + 路由分流**
- 新建 `/classic/operator/quotations/[id]/page.tsx`
- 列表 onClick 按状态分流
- 详情页面包屑链接

**PR-B — Chatter 组件 + audit POST**
- 抽 `<OrderChatter />` 通用组件
- `POST /api/orders/[id]/audit` 接口（记录 note/message）
- 两个详情页都挂载

**PR-C — 状态语义对齐**
- schema：`sentAt`, `lockedAt`, `LOCKED`, `CANCELLED`
- `/operator/orders/[id]` PENDING 守卫
- `/classic/operator/orders` 过滤 PENDING
- Quotation Action 菜单加 `Confirm` 项

### 11.8 验收标准

1. 列表点 PENDING 单 → 进入 quotation 详情，顶部状态流"Quotation"激活
2. 列表点 CONFIRMED 单 → 进入 order 详情，状态流"Sales Order"激活
3. 直接访问 `/operator/orders/{pending-id}` → 自动重定向到 quotation 详情
4. quotation 详情页面包屑"Quotations" → 返回 quotation 列表
5. order 详情页面包屑"Orders" → 返回 order 列表
6. 两个详情页底部 chatter 显示完整时间线，用户可发送消息
7. 发送消息后立刻在时间线顶部出现新条目
8. quotation 详情 Action 菜单点 "Confirm" → 状态变 CONFIRMED + 自动跳到 order 详情

### 11.9 修订（2026-04-29）：统一详情页模板

⚠️ 11.1 表格中"详情页路由"列原写 PENDING/CONFIRMED 走两条不同路由，**已废弃**。

**新规则（与 Odoo 实际一致）**：
- 所有订单状态共用 **同一个详情模板** `/classic/operator/quotations/[id]/page.tsx`
- 状态条 `Quotation › Quotation Sent › Sales Order` 自动反映当前 status
- 按钮按状态可见性：

| 按钮 | 显示条件 |
|------|---------|
| Edit | status ≠ LOCKED/CANCELLED |
| Confirm Quotation | status = PENDING |
| Send by Email | status = PENDING |
| Lock | status ∈ {CONFIRMED, WAVE_ASSIGNED, IN_DELIVERY, COMPLETED} |
| Cancel | status ≠ LOCKED |
| Create Invoice | status ∈ {CONFIRMED, WAVE_ASSIGNED, IN_DELIVERY, COMPLETED} |
| Unlock | status = LOCKED |

**遗留路由处理**：
- `/operator/orders/[id]` → `useEffect` 跳到 `/classic/operator/quotations/[id]`
- `/classic/operator/orders/[id]` → 同上

**列表跳转规则**：
- `/classic/operator/quotations` 列表行 → `/classic/operator/quotations/[id]`（不再按 status 分流）
- `/classic/operator/orders` 列表行 → `/classic/operator/quotations/[id]`
- `/operator/orders` 列表行 → 自动重定向到 `/classic/operator/quotations/[id]`
