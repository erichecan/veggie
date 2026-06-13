# 种子数据全局设计方案（North Fresh 蔬菜配送系统）

> 日期：2026-06-12（**2026-06-13 据 `docs/codebase/` 全量代码核实修订**）
> 状态：设计稿 → 已落地为事件驱动种子（`prisma/seed-events/`）
> 目的：从全局视角设计一套合理、正确、完整、有真实感、能推演程序全部逻辑（含统计/报表）的种子数据。

> ⚠️ **重大修订说明**：旧稿据「销售全程不扣库存、必须先补扣库存桥」设计 T5 出库。经 `docs/codebase/03-business-rules.md` §5 核实，**该判断错误**：销售侧在**订单确认（CONFIRMED）**时已扣库存（`orders/[id]/route.ts:459-484`：`qtyOnHand -= orderedQty` + `StockMove(OUT)`）。割裂根因是旧种子 `prisma.create` 直接造订单**绕过了确认逻辑**，不是代码缺桥。本稿据此全面修正。

---

## 0. 一句话目标

**让数据库像「这家蔬菜批发公司真实运营了 6 个月」**——每条记录都是某业务事件的结果，表与表因果相连，每个角色登录都有符合职责的真实待办，任一订单都能从下单追到收款追到记账。

---

## 1. 业务定位

- **本体**：面向中餐馆的蔬菜/食材 **B2B 批发配送**（North Fresh / 爱尔兰华人供货商）。
- **当前模式**：operator 代客下单；**C 端（RESTAURANT / customer-portal）有雏形未上线**——种子为将来自助下单**预留**（订单可标记来源），当前订单均标 operator 代下。
- **核心流程**：报价 → **确认（确认即扣库存）** → 拣货波次 → 分拣 → 装车配送签收 → 按结算方式开票（过账生成应收凭证）→ 收款核销 → 对账；上游向供应商采购进货补库存。
- **9 角色**：OPERATOR/SALES/PICKER/SORTER/WAREHOUSE/DRIVER/FINANCE/BOSS/RESTAURANT（SALES/PICKER 无独立页，见 02 文档）。

---

## 2. 现状诊断（修订版）

| 问题 | 表现 | 真实根因 |
|---|---|---|
| **按表灌，数据割裂** | 多个 `seed-*.ts` 各自 `create`，彼此无因果 | 没有事件流编排 |
| **库存与订单对不上** | 「已确认/已完成」订单却没扣库存 | 种子 `prisma.create` 直接造订单，**绕过了确认逻辑里的扣库存代码**（非代码缺桥） |
| **库存流水无来源** | `StockMove` 只有 IN、无 source/lot | 入库循环独立于订单，缺 sourceType/lotId |
| **财务不勾稽** | Invoice/Payment/Statement 各自造，金额不等 | 没走真实勾稽/核销逻辑 |
| **整条链空白** | 采购链、会计凭证、收款、批次 Lot 几乎无数据 | 从未 seed |
| **角色登录空台** | SORTER/DRIVER/FINANCE 工作台缺对应状态 | 种子没按角色状态覆盖 |
| **数据不真实** | 单商品循环、随机撒、挤在最近几天 | 纯 `Math.random()`，无分布无偏好 |

**结论**：现状是「每张表单独看有数据，合起来不是一盘生意」。

---

## 3. 关键决策：改 vs 删库重做

走 **B（删库重做）**：开发阶段数据本就是造的（不触发 CLAUDE.md「删生产数据」红线），事件驱动种子的前提就是「从零按事件回放」，且 B 天然支持幂等 + 一键 reset。

> ⚠️ 执行前二次确认：仅限**开发/测试库**，确认 `DATABASE_URL` 指向开发库、无需保留真实业务数据。
> **本方案的种子带标记、只清自己**（`Order.externalRef='seed-evt'` 等），不强制 drop——既可挂在 `npm run db:seed` 主数据之后增量重放，也可配合全库 reset。

---

## 4. 核心策略（修订版 5 条）

1. **事件驱动，不按表灌**：按「进货→下单→确认（扣库存）→拣货→分拣→送货→开票→收款→记账」时间线回放；每个事件改它该改的下游表。**复用真实逻辑**：会计记账直接 `import` `lib/accounting.ts` 的 `postInvoiceToJournal` / `postVendorBillToJournal`（已实现且能填上采购/收款记账缺口）；扣库存/收货入库/核销按 `docs/codebase/03` 核实的真实副作用**等价重放**。
2. **真实分布**：二八分层 + 客户↔商品稳定偏好 + 长尾 + 6 个月时间散布 + **固定 seed 的 PRNG**（`prisma/seed-events/rng.ts`）。
3. **角色全覆盖**：每角色登录工作台/队列都有对应状态数据（见 §8 矩阵）。
4. **守恒断言**：种子末尾自动校验库存守恒、应收勾稽、借贷平衡、状态机自洽，不过即 fail（见 §9）。
5. **分层 + 幂等 + 可复现**：主数据（复用 `db:seed`）/ 交易事件 / 异常场景三层；带标记，一键 reset+reseed。

---

## 5. 规模与分布

| 维度 | 量级 | 分布 |
|---|---|---|
| 客户 | 复用现有 + 派生画像 | 大 20(周3-4单)/ 中 50(周1-2单)/ 小 30(两周1单) |
| 商品 | 复用现有 SKU | 畅销 ~20% 高频 + 长尾偶卖 |
| 时间跨度 | 6 个月 | 工作日为主，事件散布 |
| 订单总量 | 默认 ~档可配（`SCALE`） | 二八：少数大客户贡献多数营业额 |
| 每单行数 | 3-12 行 | 从客户「常买清单」抽取（稳定偏好） |

> **主数据复用策略**：不重建 300-SKU 大目录。种子**跑在 `npm run db:seed` 之后**，读取库中现有 Product/Customer，按其 id 的**确定性哈希**派生稳定的「层级 + 常买清单 + 结算方式 + 业务员/司机归属」，再回放事件。既得真实分布，又与真实主数据保持一致、代码量与出错面都小。

---

## 5.5 报表驱动的数据丰富度（核实版）

程序有透视报表引擎（`sales`/`purchasing`/`logistics`，绑定 `veggie_*_report` 视图）+ BOSS 4 个分析页（经营总览/销售分析/采购分析/销售报表）。**数据丰富度按这些报表的真实维度/度量反推**。

| 透视维度 | 报表 | 种子必须保证 |
|---|---|---|
| 时间(日/月) | 销售/采购/物流趋势 | 订单散布完整 6 个月，每周有单 |
| 客户 | 销售分析、对账单、欠款 | 消费额二八分层，每客户**多次复购** |
| 业务员 salesman | 业务员维度切片、commission_amount | **5-6 业务员各带一批客户**，业绩有高低 |
| 商品/品类 | 动销排名、品类占比 | 销量畅销/滞销分层（长尾） |
| 司机 driver | 物流分析、driver_commission | **5 司机**配送量分布不同 |
| 支付方式 | 现金/在线占比 | ONLINE/CASH 混合 |
| 订单/采购状态 | 在途/完成、部分收货 | 各状态都有；PO 含部分收货(received<ordered) |
| 账龄/逾期 | FINANCE 历史欠款 | 月结客户**部分收款 + dueDate 过期**，closingBalance>0 |
| 批次效期 | `lots/expiring` | Lot.bestBefore 含近期到期 |

> ⚠️ **不存在的报表/度量，种子不为其编造**：销售视图**无毛利/cost_subtotal**、历史欠款**无 0-30/30-60 账龄分桶**、**无业务员佣金结算、司机佣金不自动算**（见 03 §12）。种子只保证「这些一旦补全就有数据可算」的底层丰富度（商品有 standardPrice、月结有逾期欠款、Trip 可手填 driverCommission），不假装报表已具备这些能力。

### 真实复购曲线

| 客户层 | 频率 | 半年单量 | 每单行数 | 结算 |
|---|---|---|---|---|
| 大(连锁火锅/酒店) | 周3-4 | ~80 | 8-12 | 月结、月底大额、偶逾期 |
| 中(社区川/粤菜) | 周1-2 | ~40 | 5-8 | 周结 |
| 小(小外卖) | 两周1 | ~12 | 3-5 | 现结 |

→ 点开任一客户看到完整复购曲线 + 账单；跑任一报表每个切片都有可分析数据。

---

## 6. 主数据层（复用 `db:seed`，派生画像）

`npm run db:seed` 已建：User(8 角色)、ProductCategory、ProductAttribute、Uom(+Category)、Account(STANDARD_ACCOUNTS)、ProductTemplate/Product(CSV)、OdooPricelist、Customer(演示+CSV)、DriverSlot。

种子事件层在此基础上**补/派生**：
- **客户画像**（确定性，由 `hash(customer.id)` 决定）：层级(大/中/小)、`paymentTerm`(monthly/weekly/cash)、`salesman`(5-6 选 1)、`defaultDriverSlotId`(5 司机选 1)、常买清单(从商品池按品类偏好抽 8-20 个 SKU 固定)。
- **供应商**：确保 ≥20 个 `isVendor=true`，通过 `ProductSupplierInfo` 关联商品(进货价≈成本、minQty、delay)。
- **商品成本**：确保 `standardPrice`(=listPrice×55-75%)、`safetyStockMin` 有值。
- **会计科目**：复用 STANDARD_ACCOUNTS（1100/1110/1200/2100/2200/3000/4000/5000/6000），记账函数依赖。
- **司机批次** DriverSlot：am/pm × 多司机。

> 若某主数据缺失（如全新库），种子先确保最小集存在再回放。

---

## 7. 事件流（核心：一条订单的生命周期，已据真实代码对齐）

```
T0 进货   下采购单 PurchaseOrder(+Line, DRAFT→SENT→CONFIRMED)
          → 收货 GoodsReceipt → StockMove(IN,+qty) + Lot(AVAILABLE) + Product.qtyOnHand↑
          → 供应商账单 VendorBill(POSTED) → 记账 postVendorBillToJournal()(Dr 采购成本+进项 / Cr 应付)
                                                              ↑ 填补代码缺口（过账钩子未接线，种子直接调函数）

T1 下单   Order(PENDING, operator 代下, externalRef='seed-evt') + OrderLine + OrderAuditLog(created)
          items Json 快照 + lines 关系都写（视图 join OrderLine，列表读 items）
T2 确认   PENDING→CONFIRMED + confirmationDate + DeliverySlip + OrderAuditLog(confirmed)
          → **扣库存**：每 PRODUCT 行 qtyOnHand -= orderedQty + StockMove(OUT,-qty, sourceType='SO')
          → FIFO 消耗最早 AVAILABLE 的 Lot（currentQty↓，耗尽置 DEPLETED，OUT.lotId 指向之）
                                                              ↑ 比 app 当前更细（app confirm 未做逐 Lot），属增强
T3 拣货   组 PickingWave(按 driverSlot, PENDING→PICKED) → 按比例缺货则 OrderDiscrepancy(SHORTAGE)
T4 分拣   Wave PICKED→SORTING→SORTED；Order CONFIRMED→WAVE_ASSIGNED
T5 送货   Trip(PENDING→IN_PROGRESS→COMPLETED) + Order WAVE_ASSIGNED→IN_DELIVERY→COMPLETED
          → 回写 OrderLine.deliveredQty = orderedQty（配送完成本身不再动库存，确认时已扣）
          → 司机交账：cashCollected/onlineCollected；driverCommission = Σ(订单 subtotal×commissionRate) 手填（app 未自动算）
T6 开票   按 paymentTerm 合并 Invoice(saleOrderIds 勾稽真实订单, 金额=订单和) + OrderLine.invoicedQty↑ + Order→LOCKED
          → 记账 postInvoiceToJournal()(Dr 应收 / Cr 收入+销项税)   ← 真实已实现逻辑
T7 收款   Payment 核销 → amountPaid↑/amountDue↓，满额→PAID
          → 记账(Dr 银行 / Cr 应收)，种子直接造平衡凭证             ← 填补代码缺口（收款记账未实现）
T8 对账   按客户周期汇总 Statement(opening+totalSales-totalPayments=closing)

异常分支（按比例）：
  退货  → CreditNote(+Line) 挂已完成订单 + StockMove(RETURN,+qty 回库)
  缺货  → OrderDiscrepancy 由 operator 处理(调量/替代/补货)
  补货  → demand-stock>0 → PurchaseSuggestion(priority 按 shortageRate)
  通知  → 缺货/订单事件 → Notification
```

**结算节奏决定开票与欠款**：
- `cash`：送货当天开票+全额收款，无应收。
- `weekly`：每周合并开周票，次周收款，偶部分欠。
- `monthly`：月底合并开月票，账期到次月——**逾期/部分收款/应收集中在此**。

订单状态由「时间线走到哪一步」决定：早期单多 COMPLETED/LOCKED/PAID，近几天单还在 PENDING/CONFIRMED/IN_DELIVERY——天然形成各角色都有的「在途」数据。

---

## 8. 角色覆盖矩阵（每角色登录有料）

| 角色 | 登录看到的待办（种子保证存在） |
|---|---|
| OPERATOR | 待确认报价单(PENDING)、待分配(CONFIRMED)、配送中、待开票(COMPLETED)、待审退货、低库存 |
| SALES(隐式) | 名下 salesman 有一批各状态订单 |
| SORTER | PICKED/SORTING 波次可分货 |
| DRIVER | 自己 driverId 的 IN_PROGRESS/待出发行程 + 待交账 |
| WAREHOUSE | 今日到货(GoodsReceipt)、今日出货(COMPLETED)、低库存、临期 Lot |
| FINANCE | 已完成待开票、未收/部分收发票、逾期欠款、待核销现结单、待过账供应商账单 |
| BOSS | 6 个月趋势、客户/供应商/业务员/司机排名、应收应付 |
| RESTAURANT(雏形) | 某餐厅账号 customerId 有历史订单可查 |

---

## 9. 守恒断言（`prisma/seed-events/assert.ts`，跑完自动校验）

1. **库存守恒**：每商品 `qtyOnHand == Σ StockMove.qty`（IN/RETURN 正、OUT 负）。
2. **批次守恒**：每 Lot `currentQty == initialQty - Σ(消耗该 lot 的 OUT 绝对值)`；currentQty>0 ⇒ AVAILABLE。
3. **收款勾稽**：每发票 `Σ payments.amount == amountPaid` 且 `amountDue == totalIncTax - amountPaid`。
4. **发票勾稽**：每发票 `subtotalExTax == Σ(saleOrderIds 指向订单的 totalAmount)`（订单 totalAmount 为不含税 Σsubtotal）。
5. **借贷平衡**：每 JournalEntry `Σ debit == Σ credit` 且 `totalDebit == totalCredit`。
6. **状态机自洽**：COMPLETED/LOCKED 订单的行 `deliveredQty==orderedQty`；LOCKED 单必有发票；Trip 内订单状态 ∈ {IN_DELIVERY,COMPLETED}；CANCELLED 不出现在任何 Trip/Wave。
7. **对账闭环**：每 Statement `closingBalance == openingBalance + totalSales - totalPayments`。

任一断言失败 → 打印明细并 `process.exit(1)`。

---

## 10. 黄金路径 + 异常场景

### 10.1 黄金路径（确定性，数字写死，供手算点测）
- 客户「测试餐厅 A」(月结)，5 个商品库存写死(白萝卜 100、土豆 200…)。
- 一条贯通订单：下单白萝卜 20 → 确认后库存应 80 → 开票金额可手算 → 分两笔收款核销至 PAID。
- **验收**：进后台再给白萝卜下 10 单并确认，库存应实时变 70，全程肉眼可验。

### 10.2 异常场景（覆盖非 happy path）
- 缺货拣货 → OrderDiscrepancy(订量>库存)。
- 逾期欠款 → 月结客户 Invoice 部分收款 + dueDate 过期 + Statement closingBalance>0。
- 退货 → CreditNote 挂已完成订单 + StockMove(RETURN)。
- 临期批次 → Lot.bestBefore 在 3 天内 → 仓库「临期」KPI 有数。
- 补货预警 → demand>stock → PurchaseSuggestion(critical)。

---

## 11. 实现结构与运行

```
prisma/seed-events/
├── index.ts          唯一入口：按层编排 + 末尾跑 assert
├── rng.ts            seeded PRNG（mulberry32）+ 确定性 hash/pick/weighted
├── personas.ts       读现有 Customer/Product → 派生画像（层级/常买/结算/归属）
├── events/
│   ├── purchase.ts   下采购单 / 收货入库(IN+Lot) / 供应商账单 + 记账
│   ├── sales.ts      下单 / 确认(扣库存+FIFO Lot) / 波次 / 行程送达
│   ├── billing.ts    开票(+记账) / 收款核销(+记账) / 对账单
│   └── scenarios.ts  黄金路径 + 异常场景
└── assert.ts         守恒断言集
```

- 入口加 `package.json` 脚本：`db:seed:events`（`npx tsx --env-file=.env.local prisma/seed-events/index.ts`）。
- **幂等**：跑前 `deleteMany` 清除带标记数据（`externalRef='seed-evt'`、Invoice/Trip/Wave 前缀 `EVT-`/`[EVT]`、Statement.tenantId='seed-evt'、JournalEntry.narration like、Lot/StockMove sourceRef 前缀 `EVT-`），主数据不动。
- 推荐运行：`npm run db:seed`（主数据）→ `npm run db:seed:events`（事件回放 + 断言）。

---

## 12. 与代码缺口的关系（种子如何处理「本该自动却没实现」）

| 缺口（见 03 §12） | 种子做法 |
|---|---|
| 确认扣库存 | ✅ 已实现，种子等价重放 |
| 采购账单过账记账 | 种子直接调 `postVendorBillToJournal()`（函数已存在，只是 app 未接线） |
| 收款记账 | 种子造平衡凭证(Dr 银行/Cr 应收) |
| 司机佣金计算 | 种子按 Σ(subtotal×commissionRate) 手填 `Trip.driverCommission` |
| 安全库存触发补货 | 种子按 demand-stock 生成 PurchaseSuggestion（与 app 算法一致） |
| 毛利/账龄分桶 | **不编造**；只保证底层数据（standardPrice、逾期欠款）就绪 |

> 这些「种子补、app 缺」之处，已在 [docs/codebase/03 §12](codebase/03-business-rules.md) 记录为待补业务代码，便于后续里程碑接线。
