# 全站复式记账 / 流水化改造计划 · 20261014

> 需求原话：
> 1. PO-00061 截图「点击 Receipt 后，显示 PO 的 stock move 模块的记录」——「需要 stock move 模块，符合复式记账原则，有数据可查」
> 2. 「这种库存的改法，全站还有哪些地方有这样的问题，或者也需要采用复式结构去记录的信息」
> 3. 「综合评估后，你帮我创建一个全部修改的计划」
>
> **执行状态（20261015）**：客户已确认 D1 = 不补历史、D4 = 库存金额进总账，其余按建议。
> - L1、L2：已上线（PR #39）
> - L3、L4（采购行已收核对）、L5：随第二批发布
> - 阶段 6（预留/出库分离）：20261015 已按客户反馈完成，销售确认只减 Forecast、货离仓才减 On Hand，与采购对称
>
> 发布与验证记录见 `docs/20261014-veggie-deploy-log.md`。

---

## 0. 原则（所有阶段共用）

| # | 原则 | 含义 |
|---|---|---|
| P1 | **余额 = Σ 明细** | 任何"剩多少/欠多少"的数字，都必须能由一张只追加的明细表加总得出。存着的余额字段只是缓存 |
| P2 | **唯一入账函数** | 每类明细只有一个函数能写（如 `postStockMove`），缓存余额只在这个函数里同事务更新。测试扫描代码，禁止在别处直接 `increment/decrement` |
| P3 | **只追加、不修改** | 已入账的明细不改、不删；写错了做一笔反向冲正，冲正记录指回原记录 |
| P4 | **每日对账** | 定时任务按明细重算一遍，和缓存余额比对，有差异就报警（邮件 + 页面），不自动修 |
| P5 | **迁移友好** | 纯 PostgreSQL + Prisma，不用任何 Neon/GCP 能力；定时任务走 `/api/cron/*` + `CRON_SECRET`，由 droplet 的 crontab / systemd timer 触发（见 CLAUDE.md） |
| P6 | **历史数据不硬改** | 历史差额用"期初/差异"调整单一笔对平并留痕；改生产数据只走 migration，事先确认、事先备份 |

---

## 1. 现状盘点（20261014 实查代码）

### 🔴 没有明细，或余额和账本已经对不上

| # | 存着的余额 | 现状 | 问题 |
|---|---|---|---|
| A | **库存数量** `Product.qtyOnHand`、`Lot.currentQty` | 11 个文件直接改，各自顺手写一笔 `StockMove`（单边：只有 type + 带符号 qty） | 没有"从哪里到哪里"，看不出货去了供应商、客户、报废还是盘亏；只能做"总数守恒"检查，做不了复式校验。另外**订单确认时就扣 `qtyOnHand`**（`app/api/orders/[id]/route.ts` 注释："扣减 qtyOnHand 作为预留代理"），"预留"和"实际出库"混在同一个数里 |
| B | **库存价值 / 销售成本** | `Product.standardPrice` 收货时直接覆盖（移动平均），`Lot.unitCost` 有批次成本但没进账 | 总账没有"存货"科目；供应商账单直接借记 5000 采购成本（实地盘存法），收货、发货、报废、盘点在总账里都没有分录；毛利只能估算 |
| C | **贷记单 vs 发票余额** | 贷记单确认时总账贷记 1100 应收账款，但贷记单**不关联任何发票**，发票的 `amountDue` 不减 | **总账应收余额 ≠ Σ 发票未付金额**，差额 = 已确认贷记单合计。会影响账龄、信用额度检查（`lib/credit-check.ts` 读的是发票 `amountDue`）、对账单 |

### 🟡 有明细，但余额是另存的、没人核对

| # | 存着的余额 | 明细来源 | 现状 |
|---|---|---|---|
| D | `Invoice.amountPaid / amountDue` | `Payment`（含预收款冲抵） | 3 个写入点（`/api/payments`、`lib/prepayments.ts`、`lib/trip-settlement-payment.ts`），各自同事务写 Payment 和余额，算法写了三份 |
| E | `VendorBill.amountPaid / amountDue` | `VendorPayment` | 同上，写入点在 `vendor-bills/[id]/payments` |
| F | `OrderLine.deliveredQty / invoicedQty` | 本应来自出库流水 / 发票行 | 约 10 个文件直接写，和流水无关联字段（`StockMove` 没有 `orderLineId`） |
| G | `PurchaseOrderLine.receivedQty / invoicedQty` | 本应来自入库流水 / 账单行 | 同上；`VendorBill.lines`、`Invoice.lines` 是 Json 列，不能直接 SQL 加总 |

### 🟢 已经合格，不动

- **总账分录**：开票、供应商账单、收款、付款、预收款冲抵、贷记单都是借贷平衡的分录（`lib/accounting.ts`）
- **预收款余额**：`computePrepaymentBalance` 每次从 Payment 现算，不存余额——这是 P1 的样板
- **司机收款**：`DriverCashConfirmation` → 生成 `Payment` 冲发票，可追溯；`Trip.cashCollected` 只有历史导入数据，代码里没有写入点
- **对账单、每日经营快照、冻结佣金**：本来就是某个时点的快照，不是会变动的余额

### 已有的历史体检（`docs/20260811-stock-conservation-audit.md`，Neon 冻结副本）

- `qtyOnHand ≠ Σ StockMove` 的商品 7 个；但 5479 个商品里 4195 个"既无库存也无流水"，守恒检查几乎没有约束力
- 133 万订单行只有 604 条出库流水（历史订单是 Odoo 导入，没走业务路径）
- 当时的结论：**不补历史流水，定一个起算日，之前的库存作为期初余额**——本计划沿用

---

## 2. 需要你确认的决策（我的建议在前）

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| D1 | 历史库存怎么处理 | ① 定起算日，每个商品补一笔"期初"调整对平；② 为 133 万历史订单行补流水 | **①**。与 8 月体检结论一致，期初余额是会计标准做法 |
| D2 | 什么时候算"出库" | ① 维持现状：确认订单即扣库存；② 两段式：确认 = 从 `WH/Stock` 移到 `WH/Output`（待出库，仍在仓内），司机送达 = `WH/Output → 客户` | **先①后②**。阶段 3 不改出库时点（零行为变化），阶段 6 再做两段式，那时"可用库存"和"在库库存"才能分开 |
| D3 | 库位粒度 | ① 单仓 `WH/Stock`；② 按 4 个温区建子库位（冷冻/冷藏/干货/常温） | **①**，除非客户确认要按区计数（与 `20260811-stock-transfer-mvp.md` 的问题是同一个）。结构上支持子库位，以后加不用改表 |
| D4 | 存货核算方法（**需会计确认**） | ① 维持实地盘存：采购账单直接进 5000，库存只记数量；② 改永续盘存：新增 1300 存货、5100 销售成本、5200 存货损耗科目，收货/发货/报废/盘点自动出凭证 | **②**，但必须由会计确认科目和起始月份；切换只能在月初，且要补一笔期初存货价值分录 |
| D5 | 成本取值 | ① 批次实际成本（FEFO 消耗到哪个批次就用它的 `Lot.unitCost`）；② 移动平均 `standardPrice` | **①**，批次成本已有数据；没有成本的批次退回 ② |
| D6 | 历史贷记单 | ① 系统按 `CreditNoteLine.sourceOrderId → Invoice.saleOrderIds` 自动建议抵扣，人工逐张确认；② 历史的不动，只管以后 | 先跑阶段 0 看差额多大再定 |

---

## 3. 分阶段计划

### 阶段 0 · 只读基线体检（约 0.5 天，无风险）

在 droplet 生产库上只读跑，产出 `docs/2026xxxx-ledger-baseline.md`：

1. 复跑 `scripts/audit/stock-conservation-probe.ts`：`qtyOnHand` vs `Σ StockMove`、`Lot.currentQty` vs 批次流水
2. 应收：`Σ 发票 amountDue`（POSTED）vs 总账 1100 余额 vs `Σ(totalIncTax − Σ Payment)`；列出已确认未抵扣的贷记单
3. 应付：`VendorBill.amountPaid` vs `Σ VendorPayment`
4. 订单行 `deliveredQty`、采购行 `receivedQty` 与流水的偏差抽样

**交付**：差额报告 + D1/D6 的数据依据。不改任何东西。

### 阶段 1 · 贷记单抵扣发票（约 2 天）

修复 1-C。

- **新表** `CreditNoteAllocation`：creditNoteId、invoiceId、amount、allocatedAt、createdBy、reversalOfId
- **余额公式**：发票未付 = `totalIncTax − Σ Payment − Σ CreditNoteAllocation`
- **余额收口**：发票余额收到一个函数 `recomputeInvoiceBalance(tx, invoiceId)`，阶段 2 复用
- **记账**：贷记单确认时已贷记 1100，抵扣只是应收子账内部核销，**不再出凭证**（避免重复贷记）
- **状态**：CONFIRMED → 全额抵扣后 APPLIED；部分抵扣显示剩余；未抵扣部分 = 客户可用贷项（和预收款一样在客户页显示）
- **界面**
  - 贷记单详情加「抵扣发票」，按来源订单自动推荐发票；
  - 发票详情显示抵扣记录；
  - 对账单、账龄、信用额度检查读新的余额。
- **历史数据**：按 D6 处理，走 migration（先确认、先备份）

### 阶段 2 · 收付款余额收口 + 对账任务骨架（约 1.5 天）

修复 1-D、1-E，并搭好 P4。

- `Invoice.amountPaid/amountDue` 的 3 个写入点，全部改为写完明细后调 `recomputeInvoiceBalance`
- `VendorBill` 同理，用 `recomputeVendorBillBalance`
- 测试扫描：除这两个函数外，任何文件出现 `amountPaid:` / `amountDue:` 写入即失败（创建时置 0 除外）
- 新增 `/api/cron/ledger-check`（`CRON_SECRET`）和 `LedgerCheckRun` 表（每次运行的检查项、差异条数、明细 Json）
- 首批检查项：发票余额、供应商账单余额、贷记单抵扣不超额
- 有差异时用 Resend 发邮件给管理员；设置页显示最近一次结果
- droplet 上加一条 crontab，每天 03:00 POST 触发

### 阶段 3 · 复式库存流水（核心，约 5–6 天）

修复 1-A；落地截图需求。

**3a 表结构**（只加不删，旧字段保留）

```
StockLocation  id, code, name, usage(INTERNAL|SUPPLIER|CUSTOMER|INVENTORY|SCRAP|TRANSIT), parentId, zoneId?, active
  初始化：WH/Stock、Partners/Vendors、Partners/Customers、
         Virtual/Inventory Adjustment、Virtual/Scrap、Virtual/Opening Balance

StockMove 新增：
  fromLocationId, toLocationId     —— 必填（回填后）
  reference                        —— 单据编号（PO-00061 / SO-xxx / ADJ-xxx）
  orderLineId?, purchaseOrderLineId?, stockTakeId?
  uomQty, uomId                    —— 业务单位下的原始数量（qty 继续存基础单位）
  unitCost?, value?                —— 阶段 5 用，阶段 3 先写
  reversalOfId?                    —— 冲正指向
  createdById
  新行 qty 一律为正，方向由库位决定
```

**3b 唯一入账函数** `lib/stock-ledger.ts`

`postStockMove(tx, { product, qty, from, to, reference, source, lot?, ... })` 在同一事务里完成：

- 写流水；
- 更新 `qtyOnHand`（内部库位净变化）；
- FEFO 消耗或回补批次（复用 `lib/inventory.ts`）。

另提供 `reverseStockMove(tx, moveId)`。测试扫描：除 `lib/stock-ledger.ts` 外，任何文件出现 `qtyOnHand` / `currentQty` 写入即失败。

需要迁过来的 11 个写入点：

| 写入点 | 从 → 到 |
|---|---|
| `lib/purchase/receive-purchase-order.ts` 收货 | Vendors → WH/Stock |
| `purchase-orders/[id]/return` 采购退货 | WH/Stock → Vendors |
| `orders/[id]`、`orders/bulk`、`lib/order-line-stock.ts` 确认/改量/撤回 | WH/Stock ⇄ Customers（D2-① 下保持确认即出） |
| `trips/[id]/returns` 客户退货 | Customers → WH/Stock |
| `order-discrepancies/[id]` 差异处理 | 视处理方式：Customers ⇄ WH/Stock 或 → Scrap |
| `scrap` 报废 | WH/Stock → Virtual/Scrap |
| `stock-takes/[id]` 盘点 | WH/Stock ⇄ Inventory Adjustment |
| `stock-moves`（手工调整）、`lots`（手工建批次） | WH/Stock ⇄ Inventory Adjustment |

**3c 回填（migration，需确认 + 备份）**

- 已有流水按 type、sourceType 和 qty 符号映射库位：
  - IN/PO：Vendors→Stock；
  - OUT/ORDER：Stock→Customers；
  - RETURN：Customers→Stock 或 Stock→Vendors；
  - SCRAP：Stock→Scrap；
  - ADJUSTMENT：按符号进出 Inventory Adjustment。
  - 负数改为正数并对调库位。
- 按 D1，对每个 `qtyOnHand − Σ流水 ≠ 0` 的商品补一笔 `Opening Balance → WH/Stock` 期初流水，reference = `OPENING-<起算日>`。从此"库存 = 内部库位流水合计"严格成立。

**3d 界面**

- **「库存流水」页**（库存菜单下）：
  - 列：日期、单据、商品、批次、从、到、数量（业务单位+基础单位）、操作人；
  - 可按商品、批次、库位、单据、日期、类型筛选，可导出。
- **智能按钮**：
  - PO 详情「Receipt」→ 该 PO 的流水（**截图需求**）；
  - SO「Delivery」→ 该订单的流水；
  - 商品页「In / Out」→ 该商品流水；
  - 批次页 → 批次追溯。
- 已过账流水只读，冲正需要权限（新增权限码，不在代码里给角色授权）。

**3e 对账**：`ledger-check` 加三项检查——

- 每个商品"内部库位流水合计 = qtyOnHand"；
- 每个批次"流水合计 = currentQty"；
- 全部库位合计 = 0（复式校验）。

### 阶段 4 · 订单/采购行数量从流水派生（约 2 天）

修复 1-F、1-G。

- `deliveredQty`、`receivedQty` 改为在 `postStockMove` 里按 `orderLineId` / `purchaseOrderLineId` 重算（流水有了这两列之后才能做）
- `invoicedQty`：发票行、账单行是 Json 列，开票/出账时由唯一函数按行汇总写入；不建新表
- 回填：历史行保持现值，只对起算日之后的行做派生；`ledger-check` 加"起算日后行数量 = 流水合计"一项

### 阶段 5 · 存货估值与销售成本凭证（约 3–4 天，**D4 = ② 且会计确认后才开工**）

修复 1-B。

- **新科目**：1300 存货、5100 销售成本、5200 存货损耗；是否加 2150「已收货未开票」由会计定
- **自动凭证**：`postStockMove` 对"内部 ⇄ 外部"的流水，同事务调用 `postStockValuationToJournal`

  | 流水 | 凭证 |
  |---|---|
  | 收货 | 借 1300 / 贷 2150（或 2100） |
  | 发货 | 借 5100 / 贷 1300 |
  | 报废、盘亏 | 借 5200 / 贷 1300 |
  | 盘盈 | 反向 |
  | 客户退货 | 借 1300 / 贷 5100 |

- **成本**：按 D5 取批次实际成本，回写 `StockMove.unitCost / value`
- **供应商账单**：改为冲 2150 而不是直接进 5000。这一步改的是利润口径，**只能在会计指定的月初切换**，同时补一笔期初存货价值分录
- **报表**：库存价值报表（按商品、按批次）；毛利改为读 5100 实际值

### 阶段 6 · 预留与出库分离（可选，约 3–5 天，D2 = ② 时做）

- 新增内部库位 `WH/Output`
- 确认订单：`WH/Stock → WH/Output`（可用库存减少，在库库存不变）
- 司机送达（行程完成）：`WH/Output → Customers`，此时才出成本凭证
- 缺货、补货建议、客户门户可售数量，改读 `WH/Stock` 的可用量
- 如果客户有多仓/分区需求，在这里一并实现 `20260811-stock-transfer-mvp.md` 的方案乙

---

## 4. 排期总览

| 阶段 | 内容 | 估时 | 前置 | 改生产数据 | 用户可见变化 |
|---|---|---|---|---|---|
| 0 | 只读基线体检 | 0.5 天 | — | 否 | 无（出报告） |
| 1 | 贷记单抵扣发票 | 2 天 | 0、D6 | 是（历史抵扣，可选） | 贷记单/发票页新增抵扣；应收余额变正确 |
| 2 | 收付款余额收口 + 对账任务 | 1.5 天 | 1 | 否 | 设置页对账结果；差异邮件 |
| 3 | 复式库存流水 | 5–6 天 | 0、D1、D3 | 是（回填 + 期初） | 库存流水页；PO Receipt 等智能按钮 |
| 4 | 行数量派生 | 2 天 | 3 | 否（只管起算日后） | 无（数字更准） |
| 5 | 存货估值凭证 | 3–4 天 | 3、D4、D5、会计 | 是（期初存货价值） | 总账出现存货/成本；库存价值报表 |
| 6 | 预留/出库分离 | 3–5 天 | 3、D2 | 否 | 可用量和在库量分开显示 |

**建议顺序**：0 → 1 → 2 → 3 → 4，合计约 11–12 天，可以连续做。5 和 6 等你和会计确认后再排。

---

## 5. 每阶段的验收标准（按 CLAUDE.md「完成标准」）

- 本地用种子数据把该阶段涉及的每条业务路径走一遍（收货、发货、退货、报废、盘点、贷记单抵扣……），截图或 curl 记录写进部署日志
- `ledger-check` 在本地种子数据上 0 差异；故意制造一个差异能报出来
- 新增测试：入账函数单测 + "禁止在别处写余额"的扫描测试；全量测试除既有 7 个失败外无新增失败
- 回填 migration 先在生产备份的副本上演练，记录前后差额
- 部署后在生产跑一次 `ledger-check`，结果写进 `docs/2026xxxx-veggie-deploy-log.md`

## 6. 风险与回退

| 风险 | 对策 |
|---|---|
| 迁移入账函数时漏掉某条路径，库存不再变化或重复扣减 | 扫描测试强制收口；每条路径一个集成测试（`scripts/audit/*-test.ts` 已有收货、缺货、报废等脚手架） |
| 回填库位映射出错 | 回填只写新列，不动 `qty`/`qtyOnHand`；映射规则先在副本上统计各组合数量，人工过目 |
| 大事务超时 | 回填按商品分批提交；入账函数沿用现有 `{ maxWait, timeout }` |
| 阶段 5 改了利润口径 | 只在月初切换，切换前后各出一份报表给会计核对 |
| 需要回退 | 每阶段只加表、加列，旧字段保留；代码回退即恢复旧行为，新列闲置不影响 |

## 7. 不在本计划内

- 补 133 万历史订单行的出库流水（D1 已建议不补）
- 司机现金单独建账：现有 `DriverCashConfirmation → Payment` 已可追溯
- 佣金发放台账：系统目前只算佣金、不记发放；如果客户要在系统里记"已发多少"，另开需求
- 多币种、多公司
