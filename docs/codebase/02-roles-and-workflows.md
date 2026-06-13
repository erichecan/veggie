# 02 · 角色与工作流（最重要）

> 谁在哪个页面、做什么操作、把单据流转给谁。订单/采购/会计三条状态机的真实触发点（含文件:行）。
> 本文档是设计种子数据的核心依据：每个角色登录后工作台要有料，必须让种子数据落在每个角色会处理的状态上。

---

## 1. 九个角色速览

| 角色 | 目录 | 工作台 | 落地页 | 导航 appName | 说明 |
|---|---|---|---|---|---|
| **OPERATOR** | `classic/operator` | ✓ | /classic/operator | 销售 | 全能运营中枢，控制全流程，可进所有模块 |
| **BOSS** | `classic/boss` | ✓ | /classic/boss | 报表 | 决策者，看所有报表 + 大额采购审批；权限超级管理员（全通过） |
| **FINANCE** | `classic/finance`+`accounting` | ✓ | /classic/accounting | 财务 | 发票过账、对账单、司机交账、核销 |
| **DRIVER** | `classic/driver` | ✓ | /classic/driver | 配送 | 执行行程、签收、现金交账 |
| **SORTER** | `classic/sorter` | ✓ | /classic/sorter | 仓库 | 波次分货 |
| **WAREHOUSE** | `classic/warehouse` | ✓ | /classic/warehouse | 库存 | 到货/出货/库存总览/采购记录 |
| **RESTAURANT** | `classic/restaurant`+`customer-portal` | ✓ | /customer-portal | 采购 | 餐厅自助下单（C 端雏形，未上线） |
| **SALES** | 无目录 | ✗ | 无显式 | — | **无独立页**；仅在 `/api/orders` GET 按 `salesman` 过滤只看自己订单 |
| **PICKER** | 无目录 | ✗ | 无 | — | **无独立页**；拣货职能并入 SORTER/波次流程 |

> ⚠️ SALES 与 PICKER **没有页面目录**。SALES 通过 API 层权限过滤隐式实现（`app/api/orders/route.ts` GET：调用方 roles 含 SALES 且不含 BOSS/OPERATOR 时 `where.salesman = caller.name`）。设计种子数据时，给 SALES 角色准备数据 = 给某个 salesman 名下铺订单。

---

## 2. 各角色工作台与可执行操作

### OPERATOR（`operator/layout.tsx` 行 1-77；权限门：`user.role==='OPERATOR'`）
- 导航 15+ 项，4 组：业务流（报价单/销售订单/拣货波次/配送/发票/退货/信用票/采购/采购建议/供应商账单/库存）、主数据（商品/客户/价格表/计量单位/司机配置）、分析（销售/采购/物流分析）、用户管理。
- 工作台 `GET /api/workbench?date=`：6 张待办卡 —— 待确认报价单、今日待分配订单(unassignedConfirmed)、配送中、已完成待开票、待审核退货、低库存(<20)。

### BOSS（`boss/layout.tsx`；权限门：role ∈ {BOSS,OPERATOR}）
- 导航 5 项：经营总览/销售分析/采购分析/销售报表/财务总览。
- 工作台聚合 orders + purchase-orders + customers + `/api/finance/historical-debt`：订单总数/完成率、采购待发、应收应付、Top 客户/供应商、状态分布饼图。

### FINANCE（`finance/layout.tsx` role∈{FINANCE,OPERATOR,BOSS}；`accounting/layout.tsx` role∈{FINANCE,OPERATOR}）
- finance 导航：财务总览/对账单/司机交账/核销管理；accounting 导航：核销/总览/对账单/交账。
- finance 工作台 KPI：当日现结、当日在线、信用客户未结、总欠款、司机佣金。
- accounting 页 5 步核销流程：确认已送订单 → 司机带回签收单 → 核对漏单 → 批量核销(标记 `orderReturn=true`) → 现金核对。

### DRIVER（`driver/layout.tsx` role∈{DRIVER,OPERATOR}）
- 导航：配送任务/交账。工作台 `GET /api/trips?driverId=自己`，显示 PENDING/PENDING_ASSIGNMENT/VERIFYING/IN_PROGRESS 行程；进 `/driver/trip/[id]` 执行。

### SORTER（`sorter/layout.tsx` role∈{SORTER,OPERATOR}）
- 导航：分货任务。工作台 `GET /api/waves`（PICKED/SORTING），进 `/sorter/sort/[id]` 按餐馆分区分货。

### WAREHOUSE（`warehouse/layout.tsx` role∈{WAREHOUSE,OPERATOR}）
- 导航：仓库管理。4 Tab：今日到货(采购记录)、今日出货(COMPLETED 订单按商品聚合)、库存总览、采购记录。KPI：到货数/出货数/低库存(<20)/在库商品/3 天内过期批次（`/api/lots/expiring?days=3`）。

### RESTAURANT（`restaurant/layout.tsx` 权限门：role==='RESTAURANT'）
- 导航：商品选购/我的订单。读 `/api/products`(ACTIVE) + `/api/pricelists`，走定价引擎算价 → 购物车 → `POST /api/orders`(报价单)。

---

## 3. 订单状态机（核心）

```
PENDING ──确认──▶ CONFIRMED ──分配波次──▶ WAVE_ASSIGNED ──建行程──▶ IN_DELIVERY ──行程完成──▶ COMPLETED ──发票过账──▶ LOCKED
   │                  │                       │                                                     
   └──────────────────┴───────────────────────┴────────────── CANCELLED（撤销）
```

转换白名单：`app/api/orders/[id]/route.ts` 行 22-32（ALLOWED_TRANSITIONS）。

| 转换 | 触发者 | API（文件:行） | 关键副作用 |
|---|---|---|---|
| PENDING→CONFIRMED | OPERATOR | `PUT /api/orders/[id]`（行 459-484）/ `POST /api/orders/bulk` action=confirm（行 ~208） | **扣库存**：每个 PRODUCT 行 `qtyOnHand -= orderedQty` + 写 `StockMove(OUT, qty=-)`；自动写 confirmationDate。允许负库存不阻断 |
| CONFIRMED→WAVE_ASSIGNED | OPERATOR | `POST/PUT /api/waves/[id]/assign` | 订单挂入 PickingWave（波次靠 orderIds[] 软关联） |
| WAVE_ASSIGNED→IN_DELIVERY | OPERATOR | `POST /api/trips`（建行程时推进，bulk action=start_delivery） | 订单进入司机行程 |
| IN_DELIVERY→COMPLETED | 行程完成 | `PUT /api/trips/[id]`（行 45-62）status=COMPLETED | 回写 `OrderLine.deliveredQty = orderedQty`，订单转 COMPLETED；**配送完成本身不再动库存**（确认时已扣） |
| COMPLETED→LOCKED | FINANCE | 发票过账（`/api/invoices/[id]/post`） | 锁单，不可改 |
| 任意→CANCELLED | OPERATOR | `PUT /api/orders/[id]` | 若已确认扣过库存，撤销时回补 `qtyOnHand += qty` + StockMove(IN)（行 542/588） |
| CONFIRMED/WAVE_ASSIGNED 改行 | OPERATOR | `PUT /api/orders/[id]` 行 227-320 | **库存差额调整**：删行→释放(+)、增量→再扣(-)、减量→回补(+)，均写 StockMove；并可能置 `editApprovalRequired=true`（见 03 §10） |

> ✅ **关键事实（已验证，纠正旧文档）**：销售侧**确实会扣库存**，在**确认（CONFIRMED）**时刻，不是下单时、也不是配送时。下单(PENDING)阶段不扣（`orders/route.ts` 行 291 注释「报价单阶段不扣库存」）。旧 `seed-orders-stock.ts` 直接 `prisma.create` 造各状态订单，**绕过了这段确认逻辑**，所以库存不动 —— 这是种子割裂的根因，而非业务代码缺桥。

---

## 4. 采购状态机

```
DRAFT ─send─▶ SENT ─to_approve─▶ TO_APPROVE ─approve─▶ CONFIRMED ─收货─▶ RECEIVED ─开票─▶ INVOICED ─lock─▶ LOCKED
  │             │                                                                                 
  └─confirm─────┴──────────────────────────────────── CANCELLED（cancel；可 reset_to_draft 回 DRAFT）
```

转换白名单：`app/api/purchase-orders/[id]/route.ts` 行 10-19；动作映射行 185-186。

| 转换 | 触发者 | API | 副作用 |
|---|---|---|---|
| 建单 DRAFT | OPERATOR/BOSS/WAREHOUSE | `POST /api/purchase-orders`（行 154 权限） | 自动生成 PO 编号；行金额 `ex=qty×unitCost, tax=ex×taxRate, inc=ex+tax`（行 102-104） |
| DRAFT→SENT / →CONFIRMED | OPERATOR | `PATCH …[id]` action=send/confirm | — |
| SENT→TO_APPROVE→CONFIRMED | OPERATOR 提审 / BOSS 批 | `PATCH` action=to_approve / approve | **手动触发，无金额阈值**（见 03 §10） |
| CONFIRMED→RECEIVED | WAREHOUSE | `POST /api/goods-receipts` | 建 GoodsReceipt → **入库**：写 `StockMove(IN)` + `qtyOnHand +=`（+ 建 Lot 批次） |
| RECEIVED→INVOICED | FINANCE | `PATCH` action=invoice / 建 VendorBill | 生成供应商账单 |
| INVOICED→LOCKED | FINANCE | `PATCH` action=lock | 结束 |

---

## 5. 会计流程（⚠️ 部分实现）

凭证生成逻辑在 `lib/accounting.ts`；标准科目 `STANDARD_ACCOUNTS`（1100 应收/1110 进项/1200 银行/2100 应付/2200 销项/3000 留存/4000 收入/5000 采购成本/6000 费用），需 `db:seed` 导入 Account 表。

| 事件 | 是否自动记账 | 凭证 |
|---|---|---|
| **发票过账** `POST /api/invoices/[id]/post` | ✅ **已实现**（调 `postInvoiceToJournal`） | Dr 应收(1100) / Cr 收入(4000) + Cr 销项税(2200)。同时回写 `OrderLine.invoicedQty=deliveredQty`，订单转 LOCKED。科目缺失则静默跳过但发票仍 POSTED |
| **供应商账单过账** | ❌ **未接线**（`postVendorBillToJournal` 函数存在但未被调用，`vendor-bills/[id]/route.ts` 仅置 postedAt） | 应为 Dr 采购成本/进项 / Cr 应付，**未生成** |
| **收款 Payment** | ❌ **未实现** | 应为 Dr 银行 / Cr 应收，**未生成** |

> 结论：会计链只有「销售发票过账」一条腿能自动生成凭证；采购、收款两条腿缺记账钩子。`JournalEntry`/`JournalEntryLine` 表当前**为空**（见 05 文档）。

---

## 6. 跨角色交接点

| # | 完成方 → 接收方 | 触发动作 | 状态变化 |
|---|---|---|---|
| 1 | RESTAURANT/OPERATOR → OPERATOR | 下单 `POST /api/orders` | Order = PENDING（落入「待确认报价单」） |
| 2 | OPERATOR → SORTER | 确认 + 分配波次 | PENDING→CONFIRMED（扣库存）→WAVE_ASSIGNED；波次入 SORTER 工作台 |
| 3 | SORTER → DRIVER | 分货完成 + 建行程 | Wave→SORTED；Order WAVE_ASSIGNED→IN_DELIVERY；行程入 DRIVER 工作台 |
| 4 | DRIVER → FINANCE | 行程完成/签收 | Trip→COMPLETED；Order→COMPLETED（回写 deliveredQty）；落「已完成待开票」 |
| 5 | OPERATOR/FINANCE | 开发票 + 过账 | Invoice DRAFT→POSTED（回写 invoicedQty）；Order→LOCKED；生成凭证 |
| 6 | DRIVER → FINANCE | 现结订单交账 | Trip 现金/在线 collected；accounting 页批量核销 `orderReturn=true` |
| 7 | OPERATOR/BOSS → WAREHOUSE → FINANCE | 采购单 → 收货入库 → 供应商账单 | PO DRAFT→…→CONFIRMED→RECEIVED(入库)→INVOICED |
| 异常 A | 拣货缺货 | SORTER 记 `OrderDiscrepancy`（SHORTAGE/SUBSTITUTE/WEIGHT_DIFF），OPERATOR 处理 resolution | — |
| 异常 B | 退货 | `CreditNote` 挂已完成订单/行程 | CreditNote DRAFT→CONFIRMED→APPLIED |
| 异常 C | 逾期欠款 | Invoice 部分收款 + dueDate 过期；Statement closingBalance>0 | 进 FINANCE 总览 |

---

## 关联文档
[00 概览](00-overview.md) · [01 数据模型](01-data-model.md) · [03 业务规则](03-business-rules.md) · [04 功能与报表](04-features-and-reports.md) · [05 数据来源与种子现状](05-data-sources-and-seed-state.md)
