# DEV-PLAN — 数据分析中心（Analytics Center）

> 生成日期：2026-07-03
> 类型：大改（BIG change）——新增功能模块 + schema 变更 + 跨 10+ 文件
> 状态：⛔ 等待用户确认后开工
> 旧计划（2026-05 批次/保质期，已实现）归档至 `docs/20260521-dev-plan-p0-p1-lot.md`

---

## 0. 依据文档

本计划基于以下已有文档与代码静态分析（需求来自 2026-07-03 对话中确认的分析中心设计）：

- `docs/codebase/00-overview.md` ~ `05-data-sources-and-seed-state.md`（系统全貌）
- `docs/20260624-data-ownership-audit.md`（SSOT 审计，Order.items 双存等 P0 病灶）
- `docs/20260701-*`（销售会计税口径 SSOT：totalAmount 税前、taxRate 百分数、subtotal = unitPrice × orderedQty）
- `prisma/schema.prisma`（38 model 现状）
- `lib/reports/{definitions,sql-builder,types}.ts` + 迁移 `20260522_reporting_views`（现有透视报表引擎）
- 现有页面：`/classic/boss/`（page + sales-analysis + purchase-analysis + sales-report）

---

## 1. 目标一句话

给老板和运营建一个**三层下钻的数据分析中心**：① 老板日报一屏 → ② 销售/采购/物流/财务四个分析域 → ③ 每个数字可下钻到明细单据；并补齐支撑这些指标的三个数据缺口（真实成本、业务员规范化、盘点流程）。

---

## 2. 三个数据缺口现状核实（2026-07-03 重新核实代码后的结论）

| 缺口 | 原判断 | 核实后现状 | 本计划动作 |
|------|--------|-----------|-----------|
| ② 业务员规范化 | salesman 是自由文本 | ✅ **已解决**：迁移 `20260702000000` / `20260702000002` 已删除自由文本 `salesman`，`Order.salesUserId`、`Customer.salesUserId` 已关联 User，报表视图已含 `sales_user_id` | 无 schema 工作；分析 API 直接用 `salesUserId`，仅需在业务员业绩报表中落地 |
| ① 真实成本 | 只有静态 standardPrice | ⚠️ **半解决**：`PurchaseOrderLine.unitCost` 已有真实采购价（Decimal 12,4）；但 `Lot` 批次无成本字段，销售毛利无法关联到实际进价 | Phase 1：`Lot` 加 `unitCost`，收货时从 PO 行换算写入 + 历史回填脚本 + 商品日加权平均成本视图 |
| ③ 盘点流程 | 无 | ❌ **确认缺失**：只有 `scrap` API 和 StockMove `ADJUSTMENT` 类型，无盘点单模型/页面 | Phase 1：新增 `StockTake` / `StockTakeLine` 模型 + 仓库盘点页 + 盘差自动生成 ADJUSTMENT |

---

## 3. 指标口径 SSOT（先定死，所有报表共用）

> 落地为 `lib/analytics/metrics.ts` 常量 + `docs/20260703-analytics-metric-definitions.md` 文档，任何页面不得自定口径。

### 3.1 三个时点口径，分开展示、不混用

| 口径 | 时间字段 | 用途 |
|------|---------|------|
| **销售口径**（默认） | `Order.confirmationDate` | 销售额、毛利、客户分析 |
| **物流口径** | `Order.deliveryDate` | 配送、缺货、司机分析 |
| **财务口径** | `Invoice.postedAt` / `invoiceDate` | 开票额、应收、账龄 |

### 3.2 核心指标定义（数据源一律 OrderLine，禁止读 Order.items JSON——SSOT 审计 P0）

| 指标 | 定义 |
|------|------|
| 销售额（税前） | Σ `OrderLine.subtotal`，Order.status ∈ {CONFIRMED, WAVE_ASSIGNED, IN_DELIVERY, COMPLETED, LOCKED}，按 confirmationDate 归日 |
| 销售额（税后） | Σ subtotal × (1 + taxRate/100)（沿用 20260701 口径，对外展示默认税后） |
| 毛利 | Σ (unitPrice − unitCostRef) × orderedQty；`unitCostRef` = 该商品当日加权平均批次成本（Lot.unitCost），无批次成本时 fallback `Product.standardPrice`，报表须显示"实际成本覆盖率 %" |
| 缺货率 | 按物流口径：Σ OrderDiscrepancy 行数 ÷ Σ OrderLine 行数（同日） |
| 退货额 | Σ CreditNote 金额（税前），按创建日 |
| 活跃客户 | 当期有 ≥1 张 CONFIRMED+ 订单的 Customer |
| 流失预警 | 前 8~30 天有 ≥2 单、近 7 天 0 单的客户（按 confirmationDate） |
| 应收余额 | Σ Invoice.amountDue，status ∈ {POSTED, PARTIAL}（以 Invoice 表为准，不算 Order） |
| 账龄分桶 | 按 `Invoice.dueDate` 与今天差值分 未到期 / 1-30 / 31-60 / 61-90 / 90+（⚠️ dueDate 是 String 类型，需安全 parse，脏值归"未知"桶并计数展示） |
| 损耗额 | Σ StockMove(type=SCRAP).qty × 批次成本 + 盘亏 ADJUSTMENT（负向）× 成本 |
| 库存周转天数 | 平均库存价值 ÷ 日均出库成本（按商品，取近 30 天） |
| 到货满足率 | Σ PurchaseOrderLine.receivedQty ÷ Σ orderedQty（按供应商/按 PO） |
| 司机日装载 | 按 deliveryDate + 司机归组：单数 / 行数 / 税后金额 |
| 司机交账差异 | Σ Payment(现金, 按司机) − Σ 当日 CASH 订单应收 |

---

## 4. 数据库 schema 变更（Phase 1）

> ⚠️ 迁移方式：按项目惯例用 `prisma db push` + 手写迁移 SQL + `migrate resolve`（shadow DB 无法重放旧迁移）。

### 4.1 `Lot` 加成本字段（缺口①）

```prisma
model Lot {
  // ...现有字段
  /// 参考单位下的单位成本（入库时从 PO 行 unitCost 按 UoM 换算写入；历史批次回填）
  unitCost      Decimal? @db.Decimal(12, 4)
}
```

- 写入点：`app/api/goods-receipts` 创建 Lot 时，从对应 `PurchaseOrderLine.unitCost` 经 `lib/uom.ts` 换算到参考单位。
- 回填脚本 `scripts/backfill-lot-cost.ts`：按 `Lot.sourceRef → PurchaseOrder → PurchaseOrderLine(productId)` 匹配回填；匹配不到保持 null（毛利 fallback standardPrice），脚本输出覆盖率报告。

### 4.2 盘点模型（缺口③）

```prisma
enum StockTakeStatus { DRAFT DONE CANCELLED }

model StockTake {
  id          String          @id @default(cuid())
  name        String          @unique          // STK-00001
  status      StockTakeStatus @default(DRAFT)
  takenAt     DateTime                          // 盘点业务日期
  createdById String?
  notes       String?
  lines       StockTakeLine[]
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model StockTakeLine {
  id          String    @id @default(cuid())
  stockTakeId String
  stockTake   StockTake @relation(fields: [stockTakeId], references: [id], onDelete: Cascade)
  productId   String
  productName String
  systemQty   Decimal   @db.Decimal(14, 3)   // 建单时系统库存快照
  countedQty  Decimal?  @db.Decimal(14, 3)   // 实盘数量
  diffQty     Decimal?  @db.Decimal(14, 3)   // countedQty − systemQty
  @@index([stockTakeId])
  @@index([productId])
}
```

- 盘点单 DONE 时：对每个 diffQty ≠ 0 的行生成 `StockMove(type=ADJUSTMENT, sourceType='STOCK_TAKE', sourceRef=name)`，并按批次成本计盘盈亏金额。

### 4.3 每日经营快照（分析中心地基）

```prisma
model DailyBusinessSnapshot {
  id                 String   @id @default(cuid())
  snapshotDate       DateTime @unique @db.Date
  salesExTax         Decimal  @default(0) @db.Decimal(14, 2)
  salesIncTax        Decimal  @default(0) @db.Decimal(14, 2)
  grossProfit        Decimal  @default(0) @db.Decimal(14, 2)
  costCoverageRate   Decimal  @default(0) @db.Decimal(6, 4)   // 实际成本覆盖率
  orderCount         Int      @default(0)
  activeCustomers    Int      @default(0)
  shortageLines      Int      @default(0)
  orderLines         Int      @default(0)
  creditNoteAmount   Decimal  @default(0) @db.Decimal(14, 2)
  scrapAmount        Decimal  @default(0) @db.Decimal(14, 2)
  purchaseExTax      Decimal  @default(0) @db.Decimal(14, 2)
  arBalance          Decimal  @default(0) @db.Decimal(14, 2)  // 当日应收余额快照
  arOverdue          Decimal  @default(0) @db.Decimal(14, 2)  // 逾期部分
  computedAt         DateTime @default(now())                  // 生成时间（订正后可重算）
}
```

- 生成策略：**惰性 + 手动**。打开分析中心时自动补齐缺失日期的快照（幂等 upsert）；页面提供"重算最近 N 天"按钮（credit note / 订正晚到时用）。不依赖外部 cron（Cloud Run min-instances=0，无常驻进程）。
- 当天数据实时算，昨天及以前读快照——保证历史报表数字不漂移。

### 4.4 报表视图补充（手写迁移 SQL）

- `v_lot_daily_cost`：商品 × 日 加权平均成本（毛利计算用）。
- 现有 `reporting_views` 已含 sales_user_id，不需改。

---

## 5. API 路由清单（全部 `withAuth`，按 permissions.ts 收口）

| 路由 | 方法 | 内容 |
|------|------|------|
| `/api/analytics/overview` | GET | 老板日报一屏：昨日快照 + 今日实时（待配送/波次装载/缺货待处理）+ 红灯区（负库存、超期未确认、流失 TOP） |
| `/api/analytics/snapshots` | GET / POST | 快照序列（趋势图）；POST=重算指定日期范围 |
| `/api/analytics/customers` | GET | 客户分析：ABC 分层、客单价、频率、流失预警名单（含最近下单日、历史周均单量） |
| `/api/analytics/margin` | GET | 毛利：按商品/分类/客户/业务员分组，含成本覆盖率 |
| `/api/analytics/ar-aging` | GET | 账龄分桶 + TOP 欠款客户 + 最近还款日 |
| `/api/analytics/procurement` | GET | 供应商进价对比/趋势、到货满足率、周转天数、损耗 |
| `/api/analytics/shortage` | GET | 缺货率按商品/日，关联 PurchaseSuggestion 命中情况 |
| `/api/analytics/logistics` | GET | 司机日装载、金额密度、出发时间（wave.dispatchedAt）、交账差异 |
| `/api/analytics/internal-control` | GET | 改价/折扣审计（ActionLog+OrderAuditLog 聚合）、操作员改单率、创建→确认时长 |
| `/api/stock-takes` `(/[id])` | GET/POST/PATCH | 盘点单 CRUD + 完成动作（生成 ADJUSTMENT） |

实现约束：聚合一律 `$queryRaw` 打视图/表级 GROUP BY，禁止取全量行内存聚合；所有列表带日期范围（默认近 30 天）+ 分页。

---

## 6. 页面清单

| 页面 | 路径 | 说明 |
|------|------|------|
| 老板日报一屏 | `/classic/boss`（改造现有 page.tsx） | 昨日 5 卡 + 今日 3 卡 + 红灯区 3 列表 + 30 天趋势小图；每个数字点击下钻 |
| 客户分析 | `/classic/boss/analytics/customers` | ABC / 流失预警 / 客户明细下钻到订单列表 |
| 毛利分析 | `/classic/boss/analytics/margin` | 分组切换（商品/分类/客户/业务员）+ 成本覆盖率角标 |
| 应收账龄 | `/classic/boss/analytics/ar-aging` | 分桶柱图 + 欠款客户表 → 下钻 Invoice |
| 采购分析（升级） | `/classic/boss/purchase-analysis`（扩展现有页） | 加进价趋势、满足率、周转、损耗四块 |
| 物流分析 | `/classic/boss/analytics/logistics` | 司机 × 日矩阵 + 交账差异 |
| 内控审计 | `/classic/boss/analytics/internal-control` | 改价榜、折扣异常、操作时效 |
| 仓库盘点 | `/classic/warehouse/stock-take`（+ 详情页） | 建单（可按分类筛选商品）→ 录入实盘 → 完成生成盘差 |

- 组件复用：图表用已有 `recharts`；表格沿用 antd Table 惯例；下钻统一跳既有列表页带查询参数（订单列表、发票列表已存在）。
- 权限：BOSS 全部；OPERATOR 可看销售/缺货/物流；FINANCE 可看账龄/内控；WAREHOUSE 只有盘点页。`lib/permissions.ts` 加 `Analytics`、`StockTake` subject。

---

## 7. 开发顺序（4 个 Phase，每个可独立上线）

### Phase 1 — 数据地基（先行，其余全依赖它）
1. 口径文档 `docs/20260703-analytics-metric-definitions.md` + `lib/analytics/metrics.ts`
2. Schema：Lot.unitCost + StockTake 两表 + DailyBusinessSnapshot（db push + 手写迁移 + resolve）
3. goods-receipts 写入 Lot.unitCost；回填脚本跑生产前先在本地验证覆盖率
4. `v_lot_daily_cost` 视图 + 快照生成器 `lib/analytics/snapshot.ts`
5. 盘点 API + 仓库盘点页

### Phase 2 — 老板价值最高三件套
6. `/api/analytics/overview` + boss 首页改造（日报一屏）
7. 客户流失预警 + 客户分析页
8. 应收账龄页

### Phase 3 — 利润与采购联动
9. 毛利分析页（含成本覆盖率）
10. 缺货 × 采购建议联动 + 采购分析页升级

### Phase 4 — 物流与内控
11. 物流分析页
12. 内控审计页

---

## 8. 大改三项评估（CLAUDE.md 第十三节）

- **架构**：分析层全部只读（除盘点/快照两个写点），与交易链路解耦；快照表把"历史报表稳定性"从交易表的可变性中隔离出来，无单点风险。盘点完成写 StockMove 走既有库存机制，不另起库存真相（避免重蹈 SSOT 审计病灶）。
- **质量**：复用 `lib/reports` 引擎、`reporting_views`、`lib/uom.ts` 换算、recharts/antd 既有惯例；指标口径集中在 `lib/analytics/metrics.ts` 单处定义，各 API 引用，杜绝页面各算各的。
- **性能**：历史读快照（O(天数)）；实时聚合走 SQL GROUP BY + 索引（confirmationDate、deliveryDate、Invoice.status 已有索引）；无 N+1；全部日期范围限定 + 分页。

---

## 9. 风险点

| 风险 | 应对 |
|------|------|
| `Invoice.dueDate/postedAt` 是 String 类型，可能有脏值 | 账龄计算安全 parse，无法解析归"未知"桶并显示条数；不在本期改字段类型 |
| 历史 Lot 回填不到成本（Odoo 导入批次 sourceRef 可能断链） | fallback standardPrice + 报表明示覆盖率；覆盖率 < 70% 时毛利页顶部黄条提示 |
| Order.items JSON 与 OrderLine 双存（SSOT P0 未重构） | 本模块一律读 OrderLine；不趁机重构双存（另立任务） |
| 快照与订正数据（credit note / invoicedQty 回写晚到） | 快照记 computedAt + 手动重算按钮；财务口径以 Invoice 为准不受影响 |
| prisma migrate shadow DB 无法重放 | 全部用 db push + 手写迁移 + migrate resolve（项目既定做法） |
| WAVE_ASSIGNED 等状态集合以后变化 | 状态集合定义进 `lib/analytics/metrics.ts` 常量，单点维护 |

---

## 10. 验证计划（每 Phase 完成后）

- `npm run build` + 本地 dev 启动无红错
- 快照幂等性：同一天重复生成结果一致
- 毛利抽 3 个商品手工核对（进价 × 数量 vs 报表）
- 盘点全流程：建单 → 录实盘 → 完成 → StockMove 生成 → 库存数变化正确 → 再盘一次差异归零
- 账龄总额 = Σ Invoice.amountDue（对账）
- 未带 token / 低权限角色访问每个 analytics API → 401/403
- 老板一屏每个数字下钻目标页可达且筛选参数正确
