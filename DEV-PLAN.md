# DEV-PLAN：P0 + P1 功能实现计划

> 参考文档：`BUSINESS-FLOW.md`、`Veggie-业务流程文档.html`、`prisma/schema.prisma`
> 生成日期：2026-05-21

---

## 一、功能总览（13 项）

### P0（关键，阻塞日常运营）

| # | 功能 | 简述 |
|---|------|------|
| P0-1 | 批次级缺货预警 | 批次分析面板对比需求 vs 库存，缺货商品红色高亮 |
| P0-2 | 采购模块自动生成采购建议 | 根据订单需求 + 库存水位，自动推荐要买什么、买多少、找哪家供应商 |

### P1（重要，近期必须上线）

| # | 功能 | 简述 |
|---|------|------|
| P1-1 | 财务对账模块 | 月度/批次生成客户对账单、发票，替换 MOCK 数据 |
| P1-2 | 客户小程序下单 | 餐厅角色自助下单完整体验（商品浏览→加购→提交→订单跟踪） |
| P1-3 | 业务员↔客户绑定 | SALES 角色加入权限矩阵，业务员只看自己负责的客户和订单 |
| P1-4 | 客户↔司机默认绑定 | 常配客户自动匹配固定司机/批次 |
| P1-5 | 订单修改日志 UI | OrderAuditLog 已有后端，补全前端 UI 展示 |
| P1-6 | CONFIRMED 后安全编辑 | 定义哪些字段确认后仍可改、哪些需审批 |
| P1-7 | 核货确认界面 | 司机逐项核对货物，标记差异 |
| P1-8 | 差异处理流程 | 核货/配送中数量不符时的标准处理机制 |
| P1-9 | 拒收/退货处理 | 客户现场拒收的标准流程 + 库存回退 |
| P1-10 | 司机交账确认 | 配送结束后现金/转账核对，财务确认 |
| P1-11 | 缺货自动通知 | 缺货时推送通知给相关业务员/客户 |

---

## 二、现有基础设施盘点

> 只列出对本次开发有直接帮助的已有能力，避免重复建设。

| 已有能力 | 所在位置 | 可复用于 |
|----------|----------|----------|
| `OrderAuditLog` model + `writeLog`/`diffChanges` | `prisma/schema.prisma` + `lib/action-log.ts` | P1-5 订单修改日志 UI |
| `Order.salesman` 字段 + `Customer.salesman` 字段 | schema | P1-3 业务员绑定 |
| `Customer.commissionRate/commissionFixed` | schema | P1-10 司机交账 |
| `DriverSlot` model + `Order.driverSlotId` | schema | P1-4 客户↔司机绑定 |
| `ProductSupplierInfo` model (price/minQty/delay/sequence) | schema | P0-2 采购建议 |
| `PurchaseOrder/Line` + `GoodsReceipt` 完整采购链 | schema + API | P0-2 采购建议 |
| `Account` + `JournalEntry` + `JournalEntryLine` 双式记账 | schema + `lib/accounting.ts` | P1-1 财务对账 |
| `Invoice` model (DRAFT→POSTED→PAID→CANCELLED) | schema + API | P1-1 财务对账 |
| Trip.restaurants JSON (含 `cargoVerified`, `returns[]`, `pods[]`, `payment`) | schema + driver trip page | P1-7/8/9/10 |
| ALLOWED_TRANSITIONS 状态机 | `app/api/orders/[id]/route.ts` | P1-6 安全编辑 |
| `Product.qtyOnHand` + `StockMove` 库存追踪 | schema + API | P0-1 缺货预警 |
| `MOCK_HISTORICAL_DEBT` in finance page | `lib/mock-data.ts` | P1-1 需替换为真实数据 |
| `can(ability, action, subject)` RBAC | `lib/permissions.ts` | P1-3 SALES 角色权限 |
| 异常报告 modal (exception reasons + return/exchange) | driver trip page | P1-8/9 已有 UI 基础 |

---

## 三、数据库 Schema 变更

> ⚠️ 遵循 DB Migration Rules：手写 SQL → `prisma migrate resolve --applied` → psql 执行。
> **不用** `prisma db push` 或 `prisma migrate dev`。

### 3.1 新增字段

```sql
-- Customer 新增默认司机绑定（P1-4）
ALTER TABLE "Customer" ADD COLUMN "defaultDriverSlotId" TEXT;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_defaultDriverSlotId_fkey"
  FOREIGN KEY ("defaultDriverSlotId") REFERENCES "DriverSlot"("id") ON DELETE SET NULL;
CREATE INDEX "Customer_defaultDriverSlotId_idx" ON "Customer"("defaultDriverSlotId");

-- Order 新增编辑锁定标记（P1-6）
ALTER TABLE "Order" ADD COLUMN "editApprovalRequired" BOOLEAN NOT NULL DEFAULT false;

-- Trip 新增交账字段（P1-10）
ALTER TABLE "Trip" ADD COLUMN "cashCollected" DECIMAL(12,2) DEFAULT 0;
ALTER TABLE "Trip" ADD COLUMN "onlineCollected" DECIMAL(12,2) DEFAULT 0;
ALTER TABLE "Trip" ADD COLUMN "settlementStatus" TEXT DEFAULT 'pending';
ALTER TABLE "Trip" ADD COLUMN "settledAt" TIMESTAMP;
ALTER TABLE "Trip" ADD COLUMN "settledBy" TEXT;
ALTER TABLE "Trip" ADD COLUMN "settlementNote" TEXT;
```

### 3.2 新增 Model

```sql
-- 采购建议（P0-2）
CREATE TABLE "PurchaseSuggestion" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "productId" TEXT NOT NULL,
  "productName" TEXT NOT NULL,
  "currentStock" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "demandQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "suggestedQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "supplierId" TEXT,
  "supplierName" TEXT,
  "estimatedCost" DECIMAL(12,2),
  "priority" TEXT NOT NULL DEFAULT 'normal',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "purchaseOrderId" TEXT,
  "generatedAt" TIMESTAMP NOT NULL DEFAULT now(),
  "resolvedAt" TIMESTAMP,
  "resolvedBy" TEXT,
  CONSTRAINT "PurchaseSuggestion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PurchaseSuggestion_productId_idx" ON "PurchaseSuggestion"("productId");
CREATE INDEX "PurchaseSuggestion_status_idx" ON "PurchaseSuggestion"("status");
CREATE INDEX "PurchaseSuggestion_generatedAt_idx" ON "PurchaseSuggestion"("generatedAt");

-- 通知（P1-11）
CREATE TABLE "Notification" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "data" JSONB DEFAULT '{}',
  "read" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Notification_userId_idx" ON "Notification"("userId");
CREATE INDEX "Notification_read_idx" ON "Notification"("read");
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- 客户对账单（P1-1）
CREATE TABLE "Statement" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "customerId" TEXT NOT NULL,
  "customerName" TEXT NOT NULL,
  "periodStart" DATE NOT NULL,
  "periodEnd" DATE NOT NULL,
  "openingBalance" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "totalSales" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "totalPayments" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "closingBalance" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "orderIds" TEXT[] DEFAULT '{}',
  "invoiceIds" TEXT[] DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "sentAt" TIMESTAMP,
  CONSTRAINT "Statement_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Statement_customerId_idx" ON "Statement"("customerId");
CREATE INDEX "Statement_periodEnd_idx" ON "Statement"("periodEnd");
CREATE INDEX "Statement_status_idx" ON "Statement"("status");
```

### 3.3 Prisma schema 同步更新

上述 SQL 执行后，同步更新 `prisma/schema.prisma` 添加对应 model 定义，然后执行 `npx prisma generate` 重新生成客户端。

---

## 四、新增 / 修改 API 路由

| 路由 | 方法 | 功能 | 关联 |
|------|------|------|------|
| `/api/purchase-suggestions` | GET | 查询采购建议列表 | P0-2 |
| `/api/purchase-suggestions` | POST | 触发生成采购建议（分析当前需求 vs 库存） | P0-2 |
| `/api/purchase-suggestions/[id]` | PUT | 确认/驳回/转为PO | P0-2 |
| `/api/waves/[id]/shortage` | GET | 获取指定批次的缺货分析数据 | P0-1 |
| `/api/orders/shortage-check` | POST | 批量检查一组订单的库存缺口 | P0-1 |
| `/api/statements` | GET | 查询对账单列表 | P1-1 |
| `/api/statements` | POST | 生成指定周期/客户的对账单 | P1-1 |
| `/api/statements/[id]` | GET/PUT | 查看/更新对账单 | P1-1 |
| `/api/notifications` | GET | 查询当前用户的通知列表 | P1-11 |
| `/api/notifications/[id]` | PUT | 标记通知已读 | P1-11 |
| `/api/notifications/read-all` | POST | 全部标记已读 | P1-11 |
| `/api/trips/[id]/settlement` | POST | 司机提交交账 | P1-10 |
| `/api/trips/[id]/settlement` | PUT | 财务确认交账 | P1-10 |
| `/api/customers/[id]` | PUT | 扩展：支持 defaultDriverSlotId 字段 | P1-4 |
| `/api/orders/[id]` | PUT | 扩展：CONFIRMED 安全编辑逻辑 | P1-6 |
| `/api/orders/[id]/audit` | GET | 已有，无需修改 | P1-5 |

**修改现有路由：**

| 路由 | 修改内容 | 关联 |
|------|----------|------|
| `POST /api/orders` | 自动匹配客户默认司机批次 | P1-4 |
| `PUT /api/orders/[id]` | 增加 CONFIRMED 后字段级编辑权限校验 | P1-6 |
| `PUT /api/orders/[id]` | 库存变动时触发缺货通知 | P1-11 |
| `GET /api/orders` | 支持 salesman 过滤（SALES 角色只看自己的） | P1-3 |
| `GET /api/customers` | 支持 salesman 过滤 | P1-3 |
| `PUT /api/trips/[id]` | 扩展 restaurants JSON 支持逐项核货 + 差异处理 | P1-7/8/9 |

---

## 五、新增 / 修改页面

### 新页面

| 页面路径 | 功能 | 关联 |
|----------|------|------|
| `classic/operator/purchase-suggestions/page.tsx` | 采购建议列表（一键生成、确认、转PO） | P0-2 |
| `classic/operator/waves/[id]/shortage/page.tsx` | 批次缺货分析面板 | P0-1 |
| `classic/finance/statements/page.tsx` | 对账单列表 + 生成 | P1-1 |
| `classic/finance/statements/[id]/page.tsx` | 对账单详情 | P1-1 |
| `classic/restaurant/orders/page.tsx` | 增强：完整自助下单流程 | P1-2 |
| `classic/driver/trip/[id]/settlement/page.tsx` | 司机交账界面 | P1-10 |

### 修改现有页面

| 页面 | 修改内容 | 关联 |
|------|----------|------|
| `classic/operator/waves/[id]/page.tsx` | 添加缺货预警标记（红色高亮） | P0-1 |
| `classic/operator/orders/[id]/page.tsx` | 添加审计日志面板 + CONFIRMED 安全编辑逻辑 | P1-5, P1-6 |
| `classic/operator/customers/[id]/page.tsx` | 添加默认司机绑定、业务员绑定下拉 | P1-3, P1-4 |
| `classic/finance/page.tsx` | 替换 MOCK 数据，接真实对账 API | P1-1 |
| `classic/driver/trip/[id]/page.tsx` | 增强核货界面：逐项确认 + 差异标记 + 交账入口 | P1-7, P1-8, P1-9, P1-10 |
| `classic/restaurant/page.tsx` | 增强商品浏览 + 购物车 + 下单 + 订单追踪 | P1-2 |
| 全局 Nav 组件 | 添加通知铃铛 + 未读计数 | P1-11 |

### 新组件

| 组件 | 功能 | 关联 |
|------|------|------|
| `components/shared/shortage-badge.tsx` | 缺货预警标记 | P0-1 |
| `components/shared/notification-bell.tsx` | 顶部通知铃铛 + 下拉面板 | P1-11 |
| `components/shared/audit-log-timeline.tsx` | 时间线形式显示订单修改日志 | P1-5 |
| `components/shared/cargo-checklist.tsx` | 核货逐项确认组件 | P1-7 |
| `components/shared/settlement-form.tsx` | 交账表单组件 | P1-10 |
| `components/restaurant/product-catalog.tsx` | 餐厅自助商品目录 | P1-2 |
| `components/restaurant/cart.tsx` | 购物车组件 | P1-2 |

---

## 六、权限系统变更

```typescript
// lib/permissions.ts 新增 SALES 角色到 MATRIX
SALES: {
  order:    ['read', 'create', 'update'],     // 只看自己负责客户的
  customer: ['read', 'update'],                // 只看自己负责的
  product:  ['read'],
  invoice:  ['read'],
  pricelist: ['read'],
}

// Role type 新增 SALES
export type Role =
  | 'OPERATOR' | 'RESTAURANT' | 'PICKER' | 'SORTER'
  | 'DRIVER' | 'BOSS' | 'FINANCE' | 'WAREHOUSE' | 'SALES'

// Subject type 新增
export type Subject = ... | 'statement' | 'purchase_suggestion' | 'notification'

// Action type 新增
export type Action = ... | 'settle' | 'approve_edit'
```

---

## 七、实现顺序（按依赖关系排列）

```
阶段 1 — 基础设施 + P0（约 2-3 天）
├── 1.1 数据库迁移：全部新表 + 新字段
├── 1.2 Prisma schema 同步 + generate
├── 1.3 权限系统更新（SALES 角色 + 新 Subject/Action）
├── 1.4 P0-1：缺货预警 API + 批次面板 UI
└── 1.5 P0-2：采购建议引擎 + 管理 UI

阶段 2 — P1 核心模块（约 3-4 天）
├── 2.1 P1-1：财务对账（Statement API + 对账页面 + 替换 MOCK）
├── 2.2 P1-3：业务员绑定（SALES 过滤 + 客户页面）
├── 2.3 P1-4：客户↔司机默认绑定（Customer 字段 + 下单自动匹配）
├── 2.4 P1-5：订单修改日志 UI（timeline 组件 + 订单详情嵌入）
└── 2.5 P1-6：CONFIRMED 后安全编辑（字段级权限 + 后端校验）

阶段 3 — 配送与售后（约 2-3 天）
├── 3.1 P1-7：核货确认界面（cargo-checklist 组件 + Trip API 扩展）
├── 3.2 P1-8：差异处理流程（数量修正 + 库存回调）
├── 3.3 P1-9：拒收/退货处理（退货流程 + StockMove RETURN）
└── 3.4 P1-10：司机交账确认（settlement API + 财务确认）

阶段 4 — 辅助功能（约 2 天）
├── 4.1 P1-2：客户小程序下单（商品目录 + 购物车 + 下单流程）
├── 4.2 P1-11：缺货自动通知（Notification 系统 + 铃铛组件）
└── 4.3 全局集成测试 + 种子数据更新
```

---

## 八、各功能详细设计

### P0-1：批次级缺货预警

**目标**：操作员在批次分析面板中一目了然看到哪些商品库存不足。

**实现思路**：
1. 新 API `GET /api/waves/[id]/shortage`：
   - 查询该 wave 包含的所有 orderIds
   - 汇总各商品的 orderedQty 总需求
   - 对比 `Product.qtyOnHand` 当前库存
   - 返回 `{ productId, productName, demandQty, stockQty, shortageQty, shortageRate }[]`
2. 在 `operator/waves/[id]` 页面嵌入缺货预警面板：
   - 缺货商品行显示红色背景 + 缺货数量
   - 汇总显示：缺货商品数 / 总商品数
   - 可点击跳转至采购建议（P0-2）

**不需要 schema 变更**：纯计算逻辑，基于已有 Order.lines + Product.qtyOnHand。

---

### P0-2：采购模块自动生成采购建议

**目标**：系统根据未完成订单需求与库存水位自动推荐采购方案。

**算法**：
```
对于每个 active Product:
  demand = SUM(orderLines.orderedQty) WHERE order.status IN (CONFIRMED, WAVE_ASSIGNED)
  available = product.qtyOnHand
  shortage = max(0, demand - available)
  IF shortage > 0:
    找到最优供应商 = ProductSupplierInfo WHERE sequence 最小
    suggestedQty = max(shortage, supplier.minQty)  // 不低于最小起订量
    estimatedCost = suggestedQty × supplier.price
    priority = shortage/demand > 0.5 ? 'urgent' : 'normal'
    写入 PurchaseSuggestion
```

**API**：
- `POST /api/purchase-suggestions`：触发生成（清除旧 pending 建议，重新计算）
- `GET /api/purchase-suggestions`：列表查询（筛选 status/priority）
- `PUT /api/purchase-suggestions/[id]`：确认→自动创建 PO / 驳回 / 调整数量

**UI**：`classic/operator/purchase-suggestions/page.tsx`
- 表格：商品名、当前库存、需求量、建议采购量、推荐供应商、预估成本、优先级
- 操作：批量确认（→ 自动生成 PO）、单条编辑、驳回
- 顶部按钮「重新生成建议」

---

### P1-1：财务对账模块

**目标**：替换 MOCK 数据，实现真实的客户对账。

**核心逻辑**：
1. `Statement` model 存储对账快照：
   - 按客户 + 月度区间生成
   - `openingBalance` = 上期 closingBalance（首期为 0）
   - `totalSales` = 期内该客户 COMPLETED/LOCKED 订单总额
   - `totalPayments` = 期内该客户已收款金额（Trip.restaurants 里的 payment 汇总）
   - `closingBalance` = openingBalance + totalSales - totalPayments
2. Finance 页面改造：
   - 替换 `MOCK_HISTORICAL_DEBT`，从 Statement API 读取
   - DrillPanel 展示各客户的对账详情
   - 支持按月度生成、导出、标记已发送

---

### P1-2：客户小程序下单

**目标**：餐厅角色完整自助下单体验。

**现状**：`classic/restaurant` 页面已有基础框架，但下单流程不完整。

**增强点**：
1. 商品目录组件：分类浏览、搜索、按客户价格表显示专属价格
2. 购物车组件：增减数量、删除、小计自动计算
3. 提交订单：调用 `POST /api/orders`，自动带入 restaurantId/pricelistId/salesman
4. 订单追踪：查看自己的订单状态变更历史
5. 下单截止时间提示：05:00 截单倒计时

---

### P1-3：业务员↔客户绑定

**目标**：SALES 角色只看自己负责的客户和订单。

**已有基础**：`Customer.salesman` 和 `Order.salesman` 字段已存在。

**实现**：
1. 权限矩阵添加 SALES 角色（只允许 read/create/update 自己客户的 order/customer）
2. `GET /api/orders` 增加后端过滤：如果用户角色含 SALES，自动加 `WHERE salesman = user.name`
3. `GET /api/customers` 同理
4. 客户编辑页面：增加业务员下拉框（SALES 用户列表）
5. 订单创建时自动快照 `Customer.salesman` → `Order.salesman`

---

### P1-4：客户↔司机默认绑定

**目标**：常配客户下单时自动分配到固定司机批次。

**实现**：
1. `Customer.defaultDriverSlotId` 新字段（外键→DriverSlot）
2. 客户编辑页面增加「默认配送批次」下拉
3. `POST /api/orders` 逻辑：创建订单时若客户有 defaultDriverSlotId，自动设置 `order.driverSlotId`
4. 操作员分配批次时，已有默认绑定的订单自动预填

---

### P1-5：订单修改日志 UI

**目标**：在订单详情页展示完整修改历史。

**已有基础**：`OrderAuditLog` model + `writeLog`/`diffChanges` 已在后端工作。`GET /api/orders/[id]/audit` API 已存在。

**实现**：
1. 新组件 `audit-log-timeline.tsx`：时间线形式展示
   - 每条记录显示：操作人、操作时间、操作类型
   - 字段变更：旧值→新值（高亮差异）
   - 行级变更：新增/删除/修改的订单行
2. 嵌入 `operator/orders/[id]` 页面，作为可折叠面板

---

### P1-6：CONFIRMED 后安全编辑

**目标**：订单确认后，限制可修改的字段。

**字段分级**：
| 级别 | 字段 | CONFIRMED 后行为 |
|------|------|-----------------|
| 自由编辑 | internalNote, deliveryDate | 任何人可改 |
| 受限编辑 | 订单行数量、单价 | OPERATOR/BOSS 可改，自动写 audit log |
| 需审批 | 新增/删除订单行、修改客户 | 仅 BOSS |
| 禁止 | status 回退到 PENDING | 仅 BOSS 可执行"退回"操作 |

**实现**：
1. 后端 `PUT /api/orders/[id]`：新增 `CONFIRMED_EDITABLE_FIELDS` 白名单检查
2. 前端：非可编辑字段在 CONFIRMED 状态下置灰
3. 审计日志自动记录所有 CONFIRMED 后的修改

---

### P1-7：核货确认界面

**目标**：司机逐项核对货物，精确标记每个商品的实际数量。

**已有基础**：Trip.restaurants 已有 `cargoVerified` bool，当前是批量一键确认。

**增强**：
1. `cargo-checklist.tsx` 组件：
   - 每行一个商品：名称、订购数量、实收数量（可输入）
   - 数量一致 → 绿色 ✓；不一致 → 红色高亮
   - 底部汇总：已核 / 总数
2. Trip API 扩展：restaurants 每个 item 增加 `verifiedQty` 字段
3. 全部核完才允许标记 cargoVerified = true

---

### P1-8：差异处理流程

**目标**：核货或配送中发现数量不符时的标准处理。

**流程**：
1. 核货发现差异 → 自动创建差异记录（存入 restaurants[].discrepancies）
2. 差异类型：多货、少货、破损
3. 少货 → 自动通知操作员补货或修改订单数量
4. 多货 → 标记退回仓库
5. 差异确认后 → 自动调整 `OrderLine.deliveredQty`、触发 `StockMove`

---

### P1-9：拒收/退货处理

**已有基础**：driver trip page 已有 exception modal + returns[] 数据结构。

**增强**：
1. 退货后自动创建 `StockMove(type=RETURN)`，库存回退
2. 退货金额自动从 Trip.totalPayment 中扣除
3. 退货原因标准化 + 可拍照存证（已有 pods[] 机制）
4. 退货记录同步到 Order 的 deliveredQty

---

### P1-10：司机交账确认

**目标**：配送结束后，司机上报收款明细，财务核对确认。

**流程**：
1. 司机端：Trip 完成后进入交账页面
   - 自动汇总：各餐厅现金/转账金额
   - 司机确认总额，上传收据照片
   - 提交交账
2. 财务端：交账列表页面
   - 查看各司机待核对的 Trip
   - 对比系统应收 vs 司机上报
   - 确认/驳回

---

### P1-11：缺货自动通知

**目标**：缺货预警触发时推送通知。

**实现**：
1. `Notification` model 存储通知
2. 触发点：
   - P0-1 缺货分析发现缺货 → 通知负责该客户的 SALES 用户
   - 操作员手动标记缺货 → 通知对应客户的 RESTAURANT 用户
3. 前端通知铃铛组件：轮询 `/api/notifications`，显示未读计数 + 下拉面板
4. 通知类型：shortage（缺货）、order_update（订单变更）、settlement（交账提醒）

---

## 九、风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| DB 迁移与 TMS 共享库冲突 | 新表/字段可能影响 TMS 查询 | 所有新表名前缀明确，字段加 NULL default |
| Trip.restaurants JSON 结构膨胀 | 核货、差异、退货数据嵌套层级深 | 定义清晰的 TypeScript interface，存储前验证 |
| SALES 角色过滤遗漏 | 未加过滤的 API 可能泄露其他业务员的数据 | 每个 API 统一检查，写集成测试 |
| 采购建议算法初期不准 | 首批建议可能偏大偏小 | 设计为「建议→人工确认→生成 PO」，不自动下单 |
| 通知轮询频率 | 频繁轮询增加 DB 压力 | 默认 30s 间隔，后续可升级 SSE/WebSocket |
| 客户下单截止时间时区 | 爱尔兰时区 GMT/IST 切换 | 服务端统一用 UTC，前端按 Europe/Dublin 展示 |

---

## 十、测试验证计划

每个阶段完成后执行：

1. **API 测试**：curl 验证每个新/修改端点的 200/401/403/404/500 场景
2. **权限测试**：用不同角色 token 访问受限 API，确认隔离
3. **数据一致性**：缺货数量 = 需求 - 库存（不允许负库存）
4. **UI 走查**：每个新页面/组件可交互、无死按钮
5. **回归测试**：现有订单流程（PENDING→COMPLETED）不受影响
