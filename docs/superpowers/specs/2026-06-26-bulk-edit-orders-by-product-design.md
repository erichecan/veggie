# 设计：按商品批量编辑订单（③-C）

> 日期：2026-06-26
> 状态：已确认，待实现
> 上下文：这是「订单处理中心」三块改动里的第一块（顺序 C → A → B）。
> 全局背景见同目录 quotation/销售单同源、调度台多选司机等已完成改动。

---

## 一、目标与业务场景

运营经常需要对「同一个商品」跨多张订单做调整，典型场景：

- **拆箱/改量**：原本下单买一整箱牛油果，客户改口要半箱；另一家餐馆要不同数量。需要逐单填不同数量。
- **缺货移除**：某商品彻底没货，要把所有相关订单里这个商品行批量删掉。
- **临时调价**：对某商品在多张订单上统一调整单价。

现状缺口：系统只能**逐单**进入订单详情改明细，没有「按商品找出所有相关订单 → 批量改」的入口。`POST /api/orders/bulk` 的 `mass_edit` 只允许改 `deliveryBatch/deliveryDate/paymentMethod/driverSlotId`，**不含商品/数量/价格**。

---

## 二、范围（本轮）

| 维度 | 决策 |
|---|---|
| 纳入订单状态 | **未出发的全部**：`PENDING`（报价单）+ `CONFIRMED` / `WAVE_ASSIGNED`（销售单）。排除 `IN_DELIVERY`/`COMPLETED`/`LOCKED`/`CANCELLED` |
| 可编辑维度 | **改数量、整行删除（缺货移除）、改单价** |
| **单位切换（箱↔个）** | **本轮不做**（见第六节数据模型约束）。真要箱→个属"换商品"，另开功能 |
| 编辑方式 | **统一快捷 + 逐单可调**：顶部统一设置一键套用到所有选中行，落到下方逐行待改值后可再微调 |
| 入口/形态 | **独立新页面** `/operator/orders/bulk-edit`，销售单页加入口按钮。后续 ③-A 订单处理中心整合/复用 |

---

## 三、用户流程

1. **搜商品**：页面顶部商品搜索框（复用 `/api/products` 搜索），选定一个商品。
2. **拉订单**：调 `GET /api/orders/by-product?productId=X`，返回所有未出发、含该商品的订单。
3. **列表 + 多选**：表格列出这些订单的「该商品行」，行首 checkbox（支持全选/多选）。每行显示：订单号、客户、状态、配送日期、当前数量、单价、小计。
4. **统一设置区**（顶部）：选动作 + 目标值，一键套用到所有**选中**行：
   - 设数量 = N
   - 设单价 = €X
   - 标记删除（缺货移除）
   套用后写入下方逐行的"待改值"。
5. **逐行可调**：每行可编辑「新数量」「新单价」+「删除」勾选，显示与原值的 diff（如 `3 → 2`）。
6. **应用更新**：保存，逐单进度反馈，失败单标红保留可重试。

---

## 四、技术方案

### 4.1 新增后端：`GET /api/orders/by-product`

- 鉴权：`OPERATOR` / `BOSS`（写操作沿用 PUT 的鉴权）。
- 查询：`prisma.orderLine.findMany({ where: { productId, order: { status: { in: ['PENDING','CONFIRMED','WAVE_ASSIGNED'] } } }, include: { order: { include: { lines: true } } } })`，参照 `app/api/products/forecast/route.ts:36-42` 的成熟模式（`OrderLine.productId` 已建索引，schema.prisma:544）。
- 返回投影：每条 = `{ order: { id, code, restaurantName, status, deliveryDate }, matchedLine: { id, orderedQty, unitPrice, uomName, subtotal }, allLines: OrderLine[] }`。
  - `allLines` 用于保存时客户端构造整单 PUT payload，避免保存阶段再逐单 GET。
- 以 **`OrderLine` 表**为权威明细（`Order.items` JSON 已是派生，API 出口自动投影，见数据所有权审计 P0-3）。

### 4.2 保存：客户端逐单复用现有 `PUT /api/orders/[id]`

**不新建批量写端点**，理由：`PUT /api/orders/[id]` 已封装"行替换 + 库存差额调整 + `editApprovalRequired` 标记 + 金额含税重算 + 审计"全套逻辑且已验证；新建批量端点要么抽取这段（改动面大、风险高）、要么复制（违反 DRY）。

保存时对每个被改订单：
1. 取该单 `allLines`，对匹配的该商品行：改 `orderedQty` / `unitPrice`，或从数组移除（删除）。
2. `PUT /api/orders/{orderId}`，body `{ lines: 新lines, totalAmount }`（subtotal/total 服务端重算，仅作占位）。
3. 逐单串行，进度条/逐行状态反馈；失败单单独标红，不阻断其余。

**行为继承**（来自 `app/api/orders/[id]/route.ts`）：
- `PENDING` 单：自由改，无库存影响。
- `CONFIRMED`/`WAVE_ASSIGNED` 单：改行自动 `editApprovalRequired=true`（待复核）+ 库存差额调整。保存后提示"X 单已确认，改动已提交待复核"。

### 4.3 前端页面

`app/[locale]/classic/operator/orders/bulk-edit/page.tsx`：
- 商品搜索（autocomplete）→ 选定后拉 by-product 列表。
- 表格 + 多选 + 统一设置区 + 逐行编辑（数量/单价输入、删除勾选、diff 展示）。
- 「应用更新」串行保存 + 进度/失败反馈。
- 销售单页 `orders/page.tsx` 顶部加「批量改商品」入口按钮。

---

## 五、边界与校验

- 搜到商品但无未出发订单 → 空状态提示。
- 新数量必须 **> 0**；移除商品行走「删除」勾选，不靠填 0。
- 若删除会导致某订单 **0 行** → 警告并禁止该删除（不允许删空订单）。
- 改单价允许手填（沿用 PUT 信任前端 unitPrice、服务端只重算 subtotal 的口径）；不在本轮自动按数量重新解析阶梯价。
- 已出发/已完成/锁定订单不出现在列表（查询层已过滤）。

---

## 六、数据模型约束（为什么单位切换不做）

- 一个商品（`ProductTemplate`）只绑定**单个**可售 UoM（`schema.prisma:214-219`），不存在"一个商品多个可售单位 + 自动换算定价"。
- 定价引擎 `resolveCustomerPrice`（`lib/pricing-engine.ts:227`）**不接收 UoM 参数**；`OrderLine.uomId/uomName` 是可空自由字段，schema 不校验其属于该商品。
- 库存 `Product.qtyOnHand` 按该商品单位记账。
- 结论：真正的"箱→个"需建模为**换成另一个商品 variant**（各有独立牌价/库存），属"换商品行"，不是改一个文本单位。直接改 UoM 文本会造成单价/库存口径错乱，故本轮不做。

---

## 七、验证清单

- `tsc --noEmit` + `next build` 通过。
- 搜一个有多张未出发订单的商品 → 列表正确列出（含 PENDING + CONFIRMED）。
- 统一设数量 → 套用到选中行；逐行再微调生效；diff 正确显示。
- 删除勾选 → 保存后该商品行从订单移除；订单其余行/金额正确。
- CONFIRMED 单改量 → 保存后 `editApprovalRequired=true`，库存差额正确（与单订单编辑一致）。
- 删到订单 0 行 → 被禁止并提示。
- 浏览器实测整条链路（起 dev server，operator 账号）。

---

## 八、后续（不在本轮）

- ③-A 订单处理中心独立页面，整合本功能 + 筛选 + 打印拣货/原始单入口。
- ③-B 销售单列表打印状态改纯 icon。
- 单位切换（箱↔个）作为"换商品 variant"独立功能。
