# Veggie 数据分析（Reporting）详细实现方案

> 参考来源：Odoo 17 Sales Reporting (`sale.report`) 的三层架构 —— DB VIEW → API → Pivot/Graph UI
> 货币：单币种 EUR，无需货币换算
> 技术栈：Next.js App Router + Prisma (raw SQL) + PostgreSQL + Tailwind + shadcn/ui + TypeScript

---

## 一、总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (React)                         │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌─────────────┐  │
│  │ PivotTable│  │ BarChart  │  │ LineChart │  │  PieChart   │  │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └──────┬──────┘  │
│        └──────────────┼──────────────┼───────────────┘          │
│                       ▼                                         │
│            ┌──────────────────┐                                  │
│            │ ReportingContext │  (dimensions, measures, filters) │
│            └────────┬─────────┘                                  │
└─────────────────────┼───────────────────────────────────────────┘
                      │ fetch(/api/reports/{type})
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Layer (Next.js Route)                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ /api/reports/sales      → sales_report VIEW              │   │
│  │ /api/reports/purchasing → purchasing_report VIEW          │   │
│  │ /api/reports/logistics  → logistics_report VIEW           │   │
│  └──────────────────────────────────────────────────────────┘   │
│  接收参数: dimensions[], measures[], filters{}, limit, offset    │
│  动态构建: SELECT dims, AGG(measures) FROM view WHERE filters    │
│            GROUP BY dims ORDER BY ...                            │
└─────────────────────┼───────────────────────────────────────────┘
                      │ Prisma.$queryRawUnsafe(sql)
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Database Layer (PostgreSQL)                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ CREATE VIEW veggie_sales_report AS                        │   │
│  │   SELECT ... FROM "Order" o                               │   │
│  │   JOIN "OrderLine" ol ON ol."orderId" = o.id              │   │
│  │   JOIN "Product" p ON p.id = ol."productId"               │   │
│  │   JOIN "ProductTemplate" pt ON pt.id = p."templateId"     │   │
│  │   LEFT JOIN "Customer" c ON c.id = o."restaurantId"       │   │
│  │   LEFT JOIN "DriverSlot" ds ON ds.id = o."driverSlotId"   │   │
│  │   LEFT JOIN "ProductCategory" pc ON pc.id = p."categoryId"│   │
│  │   LEFT JOIN "Uom" u ON u.id = ol."uomId"                 │   │
│  │   WHERE o.status NOT IN ('CANCELLED')                     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、数据库层 —— PostgreSQL VIEW 设计

### 2.1 销售分析 VIEW (`veggie_sales_report`)

核心思路：每一行 = 一条 OrderLine 粒度的扁平化记录，JOIN 所有维度表。

```sql
CREATE OR REPLACE VIEW veggie_sales_report AS
SELECT
    -- ===== 标识 =====
    ol.id                               AS id,
    o.id                                AS order_id,
    o.code                              AS order_code,

    -- ===== 时间维度 =====
    o."quotationDate"                   AS quotation_date,
    o."confirmationDate"                AS confirmation_date,
    o."deliveryDate"                    AS delivery_date,
    o."invoiceDate"                     AS invoice_date,
    o."createdAt"                       AS created_at,

    -- ===== 客户维度 =====
    o."restaurantId"                    AS customer_id,
    o."restaurantName"                  AS customer_name,
    c.city                              AS customer_city,
    c.country                           AS customer_country,
    c."paymentTerm"                     AS payment_term,

    -- ===== 商品维度 =====
    ol."productId"                      AS product_id,
    ol."productName"                    AS product_name,
    p."templateId"                      AS product_template_id,
    pt.name                             AS product_template_name,
    COALESCE(p."categoryId", pt."categoryId") AS category_id,
    COALESCE(pc.name, '未分类')          AS category_name,

    -- ===== 业务员 / 配送维度 =====
    o.salesman                          AS salesman,
    o."createdById"                     AS created_by_id,
    o."createdByName"                   AS created_by_name,
    o."driverSlotId"                    AS driver_slot_id,
    ds."driverName"                     AS driver_name,
    ds."timeOfDay"                      AS time_of_day,
    ds."batchNum"                       AS batch_num,

    -- ===== 状态/分类维度 =====
    o.status::text                      AS order_status,
    o."paymentMethod"::text             AS payment_method,

    -- ===== UoM 维度 =====
    ol."uomId"                          AS uom_id,
    ol."uomName"                        AS uom_name,

    -- ===== 度量值（Measures）=====
    -- 金额类
    ol."unitPrice"                      AS unit_price,
    ol.subtotal                         AS line_subtotal,
    o."totalAmount"                     AS order_total,
    ol."taxRate"                        AS tax_rate,
    ol.subtotal * COALESCE(ol."taxRate", 0)   AS tax_amount,
    ol.subtotal * (1 + COALESCE(ol."taxRate", 0)) AS line_total_inc_tax,

    -- 数量类
    ol."orderedQty"                     AS ordered_qty,
    ol."deliveredQty"                   AS delivered_qty,
    ol."invoicedQty"                    AS invoiced_qty,
    ol."orderedQty" - ol."deliveredQty" AS qty_to_deliver,
    ol."deliveredQty" - ol."invoicedQty" AS qty_to_invoice,

    -- UoM 归一化数量（转换到参考单位）
    ol."orderedQty" * COALESCE(u.factor, 1)   AS ordered_qty_ref,
    ol."deliveredQty" * COALESCE(u.factor, 1) AS delivered_qty_ref,

    -- 重量/体积（从模板获取，乘以数量）
    COALESCE(pt.weight, 0) * ol."orderedQty" * COALESCE(u.factor, 1)  AS total_weight,
    COALESCE(pt.volume, 0) * ol."orderedQty" * COALESCE(u.factor, 1)  AS total_volume,

    -- 佣金
    COALESCE(o."commissionRate", 0)     AS commission_rate,
    ol.subtotal * COALESCE(o."commissionRate", 0) AS commission_amount,

    -- 计数（每行为1，聚合时 SUM = 行数）
    1                                   AS line_count

FROM "OrderLine" ol
JOIN "Order" o           ON o.id = ol."orderId"
LEFT JOIN "Product" p    ON p.id = ol."productId"
LEFT JOIN "ProductTemplate" pt ON pt.id = p."templateId"
LEFT JOIN "ProductCategory" pc ON pc.id = COALESCE(p."categoryId", pt."categoryId")
LEFT JOIN "Customer" c   ON c.id = o."restaurantId"
LEFT JOIN "DriverSlot" ds ON ds.id = o."driverSlotId"
LEFT JOIN "Uom" u        ON u.id = ol."uomId"
WHERE o.status != 'CANCELLED';
```

### 2.2 采购分析 VIEW (`veggie_purchasing_report`)

```sql
CREATE OR REPLACE VIEW veggie_purchasing_report AS
SELECT
    pol.id                              AS id,
    po.id                               AS purchase_order_id,
    po.name                             AS po_name,

    -- 时间
    po."orderDate"                      AS order_date,
    po."expectedDate"                   AS expected_date,
    po."confirmedAt"                    AS confirmed_at,

    -- 供应商
    po."supplierId"                     AS supplier_id,
    sup.name                            AS supplier_name,
    sup.city                            AS supplier_city,

    -- 商品
    pol."productId"                     AS product_id,
    pol."productName"                   AS product_name,
    p."templateId"                      AS product_template_id,
    COALESCE(p."categoryId", pt."categoryId") AS category_id,
    COALESCE(pc.name, '未分类')          AS category_name,

    -- 状态
    po.status::text                     AS po_status,

    -- 度量值
    pol."unitCost"                      AS unit_cost,
    pol."subtotalExTax"                 AS subtotal_ex_tax,
    pol."taxAmount"                     AS tax_amount,
    pol."subtotalIncTax"                AS subtotal_inc_tax,
    pol."orderedQty"                    AS ordered_qty,
    pol."receivedQty"                   AS received_qty,
    pol."invoicedQty"                   AS invoiced_qty,
    pol."orderedQty" - pol."receivedQty" AS qty_to_receive,
    pol."bestBefore"                    AS best_before,
    1                                   AS line_count

FROM "PurchaseOrderLine" pol
JOIN "PurchaseOrder" po     ON po.id = pol."purchaseOrderId"
LEFT JOIN "Customer" sup    ON sup.id = po."supplierId" AND sup."isVendor" = true
LEFT JOIN "Product" p       ON p.id = pol."productId"
LEFT JOIN "ProductTemplate" pt ON pt.id = p."templateId"
LEFT JOIN "ProductCategory" pc ON pc.id = COALESCE(p."categoryId", pt."categoryId")
WHERE po.status != 'CANCELLED';
```

### 2.3 物流分析 VIEW (`veggie_logistics_report`)

```sql
CREATE OR REPLACE VIEW veggie_logistics_report AS
SELECT
    t.id                                AS id,
    t.name                              AS trip_name,

    -- 时间
    t."createdAt"                       AS created_at,
    t."settledAt"                       AS settled_at,

    -- 司机
    t."driverId"                        AS driver_id,
    t."driverName"                      AS driver_name,
    t."timeSlot"                        AS time_slot,

    -- 波次
    t."waveId"                          AS wave_id,

    -- 状态
    t.status::text                      AS trip_status,
    t."settlementStatus"                AS settlement_status,

    -- 度量值
    t."totalPayment"                    AS total_payment,
    t."driverCommission"                AS driver_commission,
    t."cashCollected"                   AS cash_collected,
    t."onlineCollected"                 AS online_collected,
    COALESCE(t."cashCollected", 0) + COALESCE(t."onlineCollected", 0) AS total_collected,
    -- 配送餐厅数（从 JSON 数组长度获取）
    jsonb_array_length(t.restaurants::jsonb)  AS restaurant_count,
    1                                   AS trip_count

FROM "Trip" t
WHERE t.status != 'PENDING';
```

### 2.4 迁移文件

创建 `prisma/migrations/20260522_reporting_views/migration.sql`，包含以上三个 VIEW 的 CREATE OR REPLACE 语句。通过 `prisma migrate resolve --applied` 标记。

---

## 三、API 层设计

### 3.1 通用报表 API 协议

**请求格式** (`POST /api/reports/{type}`)：

```typescript
interface ReportRequest {
  // 分组维度（行维度 + 列维度用 rowDimensions / colDimensions 区分）
  rowDimensions: DimensionSpec[];
  colDimensions?: DimensionSpec[];  // 仅 pivot 需要

  // 聚合度量
  measures: string[];   // e.g. ["line_subtotal", "ordered_qty"]

  // 筛选条件
  filters?: FilterSpec[];

  // 分页（用于非 pivot 的列表查看）
  limit?: number;       // 默认 200
  offset?: number;

  // 排序
  orderBy?: { field: string; direction: 'asc' | 'desc' }[];
}

interface DimensionSpec {
  field: string;            // VIEW 字段名，如 "customer_name"
  interval?: DateInterval;  // 仅日期字段: "day" | "week" | "month" | "quarter" | "year"
}

type DateInterval = 'day' | 'week' | 'month' | 'quarter' | 'year';

interface FilterSpec {
  field: string;
  operator: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'in' | 'not_in' | 'between' | 'like';
  value: string | number | string[] | [string, string];
}
```

**响应格式**：

```typescript
interface ReportResponse {
  // 分组后的数据行
  rows: Record<string, any>[];

  // 度量值的汇总（总计行）
  totals: Record<string, number>;

  // 可用维度和度量的元数据（首次加载用）
  metadata?: {
    dimensions: DimensionMeta[];
    measures: MeasureMeta[];
  };

  // 分页信息
  total: number;
  limit: number;
  offset: number;
}

interface DimensionMeta {
  field: string;
  label: string;
  labelZh: string;
  type: 'string' | 'date' | 'datetime' | 'number' | 'enum';
  options?: { value: string; label: string }[];  // enum 维度的可选值
  dateIntervals?: DateInterval[];                 // 日期维度支持的区间
}

interface MeasureMeta {
  field: string;
  label: string;
  labelZh: string;
  aggregation: 'sum' | 'avg' | 'count' | 'min' | 'max';
  format: 'currency' | 'decimal' | 'integer' | 'percentage' | 'weight';
}
```

### 3.2 SQL 构建器 (`lib/reports/sql-builder.ts`)

核心模块，根据请求参数动态构建安全 SQL：

```typescript
// 白名单校验：只允许 VIEW 中实际存在的字段
const SALES_DIMENSIONS: Record<string, DimensionMeta> = {
  customer_name:    { field: 'customer_name',    label: 'Customer',        labelZh: '客户',     type: 'string' },
  customer_city:    { field: 'customer_city',     label: 'City',            labelZh: '城市',     type: 'string' },
  customer_country: { field: 'customer_country',  label: 'Country',         labelZh: '国家',     type: 'string' },
  product_name:     { field: 'product_name',      label: 'Product',         labelZh: '商品',     type: 'string' },
  category_name:    { field: 'category_name',     label: 'Category',        labelZh: '商品分类', type: 'string' },
  salesman:         { field: 'salesman',           label: 'Salesperson',     labelZh: '业务员',   type: 'string' },
  driver_name:      { field: 'driver_name',        label: 'Driver',          labelZh: '司机',     type: 'string' },
  time_of_day:      { field: 'time_of_day',        label: 'AM/PM',           labelZh: '上午/下午', type: 'enum',
                      options: [{ value: 'am', label: '上午' }, { value: 'pm', label: '下午' }] },
  order_status:     { field: 'order_status',       label: 'Status',          labelZh: '状态',     type: 'enum',
                      options: ['PENDING','CONFIRMED','WAVE_ASSIGNED','IN_DELIVERY','COMPLETED','LOCKED'].map(s => ({ value: s, label: s })) },
  payment_method:   { field: 'payment_method',     label: 'Payment',         labelZh: '支付方式', type: 'enum',
                      options: [{ value: 'ONLINE', label: '在线' }, { value: 'CASH', label: '现金' }] },
  payment_term:     { field: 'payment_term',       label: 'Payment Term',    labelZh: '付款条件', type: 'string' },
  created_by_name:  { field: 'created_by_name',    label: 'Created By',      labelZh: '创建人',   type: 'string' },
  uom_name:         { field: 'uom_name',           label: 'UoM',             labelZh: '单位',     type: 'string' },

  // 日期维度（支持 interval 子选项）
  delivery_date:     { field: 'delivery_date',      label: 'Delivery Date',   labelZh: '交货日期',   type: 'date', dateIntervals: ['day','week','month','quarter','year'] },
  confirmation_date: { field: 'confirmation_date',  label: 'Confirm Date',    labelZh: '确认日期',   type: 'date', dateIntervals: ['day','week','month','quarter','year'] },
  quotation_date:    { field: 'quotation_date',     label: 'Quotation Date',  labelZh: '报价日期',   type: 'date', dateIntervals: ['day','week','month','quarter','year'] },
  invoice_date:      { field: 'invoice_date',       label: 'Invoice Date',    labelZh: '发票日期',   type: 'date', dateIntervals: ['day','week','month','quarter','year'] },
  created_at:        { field: 'created_at',          label: 'Created At',      labelZh: '创建时间',   type: 'datetime', dateIntervals: ['day','week','month','quarter','year'] },
};

const SALES_MEASURES: Record<string, MeasureMeta> = {
  line_subtotal:        { field: 'line_subtotal',        label: 'Subtotal',          labelZh: '小计（不含税）',  aggregation: 'sum', format: 'currency' },
  line_total_inc_tax:   { field: 'line_total_inc_tax',   label: 'Total (inc. tax)',  labelZh: '小计（含税）',    aggregation: 'sum', format: 'currency' },
  tax_amount:           { field: 'tax_amount',           label: 'Tax',               labelZh: '税额',            aggregation: 'sum', format: 'currency' },
  ordered_qty:          { field: 'ordered_qty',          label: 'Ordered Qty',       labelZh: '订购数量',        aggregation: 'sum', format: 'decimal' },
  delivered_qty:        { field: 'delivered_qty',        label: 'Delivered Qty',     labelZh: '交货数量',        aggregation: 'sum', format: 'decimal' },
  invoiced_qty:         { field: 'invoiced_qty',         label: 'Invoiced Qty',      labelZh: '开票数量',        aggregation: 'sum', format: 'decimal' },
  qty_to_deliver:       { field: 'qty_to_deliver',       label: 'To Deliver',        labelZh: '待交货',          aggregation: 'sum', format: 'decimal' },
  qty_to_invoice:       { field: 'qty_to_invoice',       label: 'To Invoice',        labelZh: '待开票',          aggregation: 'sum', format: 'decimal' },
  ordered_qty_ref:      { field: 'ordered_qty_ref',      label: 'Qty (Ref UoM)',     labelZh: '数量（参考单位）', aggregation: 'sum', format: 'decimal' },
  total_weight:         { field: 'total_weight',         label: 'Weight (kg)',       labelZh: '总重量(kg)',      aggregation: 'sum', format: 'weight' },
  total_volume:         { field: 'total_volume',         label: 'Volume',            labelZh: '总体积',          aggregation: 'sum', format: 'decimal' },
  commission_amount:    { field: 'commission_amount',    label: 'Commission',        labelZh: '佣金',            aggregation: 'sum', format: 'currency' },
  unit_price:           { field: 'unit_price',           label: 'Avg Price',         labelZh: '均价',            aggregation: 'avg', format: 'currency' },
  line_count:           { field: 'line_count',           label: '# Lines',           labelZh: '行数',            aggregation: 'sum', format: 'integer' },
};

// SQL 构建核心函数
function buildReportSQL(
  viewName: string,
  req: ReportRequest,
  dimensionDefs: Record<string, DimensionMeta>,
  measureDefs: Record<string, MeasureMeta>
): { sql: string; params: any[] }
```

**日期维度 interval 处理**（对标 Odoo `getIntervalOptions`）：

```sql
-- interval = 'day'
DATE_TRUNC('day', delivery_date) AS delivery_date_day

-- interval = 'week'
DATE_TRUNC('week', delivery_date) AS delivery_date_week

-- interval = 'month'
DATE_TRUNC('month', delivery_date) AS delivery_date_month

-- interval = 'quarter'
DATE_TRUNC('quarter', delivery_date) AS delivery_date_quarter

-- interval = 'year'
DATE_TRUNC('year', delivery_date) AS delivery_date_year
```

**安全措施**：
1. 维度和度量必须在白名单中，拒绝任意字段名
2. 筛选器的值使用参数化查询（`$1, $2, ...`），防止 SQL 注入
3. 字段名通过白名单映射后再拼入 SQL，不直接使用用户输入

### 3.3 API 路由清单

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/reports/sales` | POST | 销售分析（ORDER_LINE 粒度） |
| `/api/reports/sales/metadata` | GET | 返回可用维度/度量/筛选项 |
| `/api/reports/purchasing` | POST | 采购分析 |
| `/api/reports/purchasing/metadata` | GET | 采购元数据 |
| `/api/reports/logistics` | POST | 物流分析 |
| `/api/reports/logistics/metadata` | GET | 物流元数据 |
| `/api/reports/export` | POST | 导出 Excel（接收同样的查询参数 + 当前数据快照） |

### 3.4 鉴权

所有 `/api/reports/*` 路由需要认证 + 角色校验：
- OPERATOR / BOSS / FINANCE：可访问全部报表
- SALES：仅可访问销售分析（且筛选自己的数据）
- DRIVER：仅可访问物流分析（且筛选自己的数据）
- 其他角色：无权限

---

## 四、前端层设计

### 4.1 页面路由

```
app/[locale]/classic/operator/reporting/
├── layout.tsx              # 报表区域布局（二级 tab 导航）
├── page.tsx                # 默认跳转到 sales
├── sales/
│   └── page.tsx            # 销售分析
├── purchasing/
│   └── page.tsx            # 采购分析
└── logistics/
    └── page.tsx            # 物流分析
```

### 4.2 组件架构

```
components/reporting/
├── ReportingContext.tsx        # React Context：管理当前维度、度量、筛选状态
├── ReportingToolbar.tsx        # 顶部工具栏：视图切换(Pivot/Bar/Line/Pie)、导出按钮
├── DimensionSelector.tsx       # 维度选择器（Dropdown + Checkbox）
├── MeasureSelector.tsx         # 度量选择器（Dropdown + Checkbox）
├── FilterPanel.tsx             # 筛选面板（日期范围、状态、客户搜索等）
├── DateIntervalPicker.tsx      # 日期区间选择器（日/周/月/季/年）
├── PivotTable/
│   ├── PivotTable.tsx          # 主组件：渲染行头 + 列头 + 数据格
│   ├── PivotHeader.tsx         # 行/列标题（可展开/折叠 + 加维度按钮）
│   ├── PivotCell.tsx           # 数据单元格（点击跳转明细）
│   └── PivotGroupByMenu.tsx    # 加维度下拉菜单（对标 Odoo PivotGroupByMenu）
├── Charts/
│   ├── ReportBarChart.tsx      # 柱状图（Recharts）
│   ├── ReportLineChart.tsx     # 折线图
│   └── ReportPieChart.tsx      # 饼图
├── ExportButton.tsx            # Excel 导出
└── PresetReports.tsx           # 预设报表快捷入口
```

### 4.3 核心交互流程

#### 初始加载
1. 页面加载 → 调用 `/api/reports/sales/metadata` 获取可用维度和度量
2. 应用默认预设（如：行维度=交货日期(月), 列维度=无, 度量=小计）
3. 调用 `/api/reports/sales` 获取数据
4. 渲染 Pivot Table

#### 用户交互
- **添加维度**：点击行/列标题区的 "+" 按钮 → 弹出 PivotGroupByMenu → 选择字段 → 重新查询
- **展开/折叠**：点击分组标题 → 加载下一层级数据（类似 Odoo 的 expandGroup）
- **切换度量**：点击 Measures 下拉 → 勾选/取消 → 重新查询
- **添加筛选**：在 FilterPanel 中选择字段+条件+值 → 重新查询
- **切换视图**：Toolbar 中点击 Pivot / Bar / Line / Pie 图标切换
- **排序**：点击度量列标题 → 按该度量升/降排序
- **导出**：点击 Export 按钮 → 调用导出 API → 下载 .xlsx 文件

### 4.4 Pivot Table 数据结构

对标 Odoo `pivot_model.js` 的树形结构，前端维护：

```typescript
interface PivotState {
  // 当前激活的行/列维度
  rowGroupBys: DimensionSpec[];
  colGroupBys: DimensionSpec[];

  // 激活的度量
  activeMeasures: string[];

  // 行组树（类似 Odoo rowGroupTree）
  rowTree: GroupNode;

  // 列组树
  colTree: GroupNode;

  // 单元格数据: cellKey → measure → value
  cells: Map<string, Record<string, number>>;

  // 排序
  sortedColumn?: { measure: string; order: 'asc' | 'desc' };
}

interface GroupNode {
  // 本节点的维度值，如 { customer_name: "Restaurant A" }
  values: Record<string, any>;
  label: string;

  // 子节点（展开后填充）
  children: GroupNode[];

  // 是否已展开
  isExpanded: boolean;

  // 是否是叶子节点（没有更多维度可展开）
  isLeaf: boolean;
}
```

### 4.5 预设报表

| 预设名称 | 行维度 | 列维度 | 度量 | 默认筛选 |
|----------|--------|--------|------|----------|
| 销售总览 | 交货日期(月) | — | 小计, 行数 | 最近 365 天, 非取消 |
| 客户分析 | 客户名 | — | 小计, 交货数量, 佣金 | 已确认+ |
| 商品分析 | 商品分类 > 商品名 | — | 小计, 订购数量, 总重量 | 已确认+ |
| 业务员业绩 | 业务员 | 交货日期(月) | 小计, 行数 | 本月 |
| 司机配送 | 司机 | 上午/下午 | 小计, 佣金 | 最近 30 天 |
| 支付方式 | 支付方式 | 交货日期(月) | 小计 | 最近 365 天 |
| 采购分析 | 供应商 | 下单日期(月) | 小计(不含税), 订购数量 | 非取消 |
| 物流概览 | 司机 | 交账状态 | 总收款, 现金, 在线, 佣金 | 已完成 |

### 4.6 图表库选择

使用 **Recharts**（已在 shadcn/ui charts 推荐列表中，基于 D3 + React）：
- `BarChart` → 柱状图（按维度对比度量）
- `LineChart` → 折线图（按时间维度看趋势）
- `PieChart` → 饼图（按维度看占比）
- 响应式、支持 Tooltip、Legend、自定义颜色

### 4.7 Excel 导出

使用 **SheetJS (xlsx)**：
- 前端收到报表数据后，直接在浏览器端调用 `XLSX.utils.json_to_sheet` + `XLSX.writeFile`
- 优点：无需后端额外接口，减少服务端压力
- Pivot 表格导出时保留行/列分组结构

---

## 五、导航集成

在 `components/classic/OdooNav.tsx` 中添加"数据分析"入口：

```typescript
// 在 APPS 数组中添加
{
  name: "数据分析",
  href: "/classic/operator/reporting/sales",
  icon: BarChart3,  // from lucide-react
  description: "销售/采购/物流多维度分析",
}
```

位置：放在"财务"和"设置"之间。

---

## 六、开发顺序（按依赖关系排列）

### Phase 1: 数据库层（约 1h）
1. 编写 `veggie_sales_report` VIEW SQL
2. 编写 `veggie_purchasing_report` VIEW SQL
3. 编写 `veggie_logistics_report` VIEW SQL
4. 创建迁移文件，应用到数据库
5. 验证 VIEW 可查询

### Phase 2: API 层（约 2h）
1. 实现 `lib/reports/sql-builder.ts`（SQL 构建器 + 白名单）
2. 实现 `lib/reports/definitions.ts`（三种报表的维度/度量定义）
3. 实现 `/api/reports/sales/metadata` 路由
4. 实现 `/api/reports/sales` 路由
5. 复制实现 purchasing 和 logistics 路由
6. 用 curl 验证 API

### Phase 3: 前端基础组件（约 3h）
1. 安装 recharts
2. 实现 `ReportingContext.tsx`
3. 实现 `DimensionSelector.tsx` + `MeasureSelector.tsx`
4. 实现 `FilterPanel.tsx` + `DateIntervalPicker.tsx`
5. 实现 `ReportingToolbar.tsx`

### Phase 4: Pivot Table（约 3h）
1. 实现 `PivotTable.tsx` 核心渲染
2. 实现行/列头展开折叠逻辑
3. 实现 `PivotGroupByMenu.tsx`
4. 实现排序功能
5. 实现合计行

### Phase 5: 图表（约 1.5h）
1. 实现 `ReportBarChart.tsx`
2. 实现 `ReportLineChart.tsx`
3. 实现 `ReportPieChart.tsx`
4. 视图切换逻辑

### Phase 6: 页面集成与预设（约 2h）
1. 创建 reporting 路由和布局
2. 实现 sales/page.tsx
3. 实现 purchasing/page.tsx
4. 实现 logistics/page.tsx
5. 实现预设报表快捷入口
6. 导航集成

### Phase 7: 导出与收尾（约 1h）
1. 实现 Excel 导出
2. 响应式适配
3. 端到端验证

**预计总工时：约 13.5 小时**

---

## 七、关键设计决策

| 决策点 | 选择 | 原因 |
|--------|------|------|
| 数据聚合层 | PostgreSQL VIEW | 性能最优，聚合计算下推到 DB；Odoo 成熟验证；VIEW 自动跟随底表更新 |
| SQL 构建 | 白名单 + 参数化 | 安全第一；不使用 ORM 因为动态 GROUP BY 用 Prisma 很难表达 |
| 前端状态 | React Context + useReducer | 报表状态复杂（维度/度量/筛选/展开状态），需要集中管理 |
| 图表库 | Recharts | React 生态主流，shadcn charts 推荐，API 简洁 |
| Pivot Table | 自建组件 | 需求高度定制（分组展开、加维度、点击跳转），现有库无法满足 |
| 导出 | SheetJS 前端导出 | 无需后端参与，减少网络往返；支持 xlsx 格式 |
| 日期处理 | PostgreSQL DATE_TRUNC | 性能好，支持 day/week/month/quarter/year 全部区间 |
| UoM 归一化 | VIEW 中预计算 ref_qty | 在 VIEW 层就做好单位转换，API 层无需关心 |

---

## 八、数据量与性能考虑

| 场景 | 预期规模 | 策略 |
|------|----------|------|
| 销售明细 | 数万~数十万行 OrderLine | VIEW 已做 JOIN 预处理；加 WHERE 日期筛选限制范围 |
| Pivot 分组 | 通常 < 1000 个分组组合 | GROUP BY 后数据量小，直接返回全量 |
| 图表数据 | 通常 < 100 个数据点 | 无性能问题 |
| Excel 导出 | Excel 列限制 16384 | 参考 Odoo 做 16384 列检查，超出提示用户 |

**索引优化**：VIEW 的 JOIN 条件对应的字段（orderId, productId, restaurantId, driverSlotId）在 schema 中已有索引，无需额外添加。

如果后期数据量超过百万行级别，可考虑：
1. 物化视图（MATERIALIZED VIEW）+ 定时刷新
2. 预聚合表（按天/周/月汇总）
3. 分区表（按月分区 Order 表）

---

## 九、与 Odoo 的对比和简化

| Odoo 功能 | Veggie 实现 | 简化原因 |
|-----------|-------------|----------|
| 多币种换算 | 不需要 | 单币种 EUR |
| Python `_auto=False` + `_table_query` | PostgreSQL VIEW | 直接用 SQL，效果相同 |
| `read_group` ORM 方法 | 自建 SQL builder | Prisma 不支持动态 GROUP BY |
| OWL 框架 Pivot Widget | React + shadcn/ui | 技术栈不同，但交互逻辑对标 |
| `properties_group_by` | 不需要 | Veggie 无自定义属性系统 |
| 多 origin 比较（同比/环比） | Phase 2 考虑 | 先做基础功能 |
| SearchModel 联动 | 独立 FilterPanel | Veggie 无全局 SearchModel |
