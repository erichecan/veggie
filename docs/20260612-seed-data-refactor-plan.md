# 全站种子数据重构方案(事件驱动)

> 日期:2026-06-12（**2026-06-13 据 `docs/codebase/` 全量代码核实修订**）
> 状态:已落地为 `prisma/seed-events/`
> 范围:大改(38 张表的种子生成方式改为事件驱动)
>
> ⚠️ **重大修订**：本稿原判断「销售全程不扣库存、P1 必须先补扣库存业务代码桥」。经代码核实**该判断错误**——销售侧在**订单确认(CONFIRMED)** 时已扣库存(`orders/[id]/route.ts:459-484`)。割裂根因是旧种子 `prisma.create` 绕过确认逻辑，**不需要补扣库存桥**。真正需种子补的只剩：采购账单/收款的会计记账(函数已存在或造平衡凭证)、司机佣金手填。下文已据此修正，原"补桥"措辞保留删除线语义、以本banner为准。

---

## 1. 背景与问题

当前种子数据是**"按表灌数据"**模式:每个 `seed-*.ts` 脚本独立地往一张或几张表塞随机行,表与表之间没有发生过任何真实业务事件。结果是**全站数据割裂**——每张表单独看都有数据,但它们不是"同一条业务"产生的,无法串联,也无法支撑"调库存 → 下单 → 看库存扣减"这类全流程测试。

### 1.1 全站业务链覆盖现状

| 业务链 | 设计意图 | 种子现状 | 业务代码现状 |
|---|---|---|---|
| 销售链(下单→拣货→出库→送货) | Order→PickingWave→DeliverySlip→Trip 串联 | ⚠️ 4 个脚本各自 `create` 订单,状态互不校验 | 🟢 **确认时已扣库存**(种子绕过了确认逻辑才没扣) |
| 库存链(入库/出库/批次) | StockMove 双向流水,Lot 管批次效期 | ❌ 只入不出,`Lot` 表全空 | 🟢 出入库逻辑有(确认扣减/收货入库/手动调整),Lot 在收货侧维护 |
| 应收链(发票→收款→对账单) | Invoice.saleOrderIds 勾稽,ΣPayment=amountPaid | ❌ invoice/payment/statement 各自造,金额不勾稽 | 🟢 收款核销逻辑存在 |
| 采购链(采购单→收货→供应商账单) | PurchaseOrder→GoodsReceipt→VendorBill | ❌ 三表无人 seed,全空 | 🟢 收货入库逻辑有 |
| 会计链(科目→凭证→分录) | Account→JournalEntry→JournalEntryLine 复式记账 | ❌ 全空 | 🔴 **无自动记账,纯手工** |
| 退货/差异 | CreditNote 挂退货,OrderDiscrepancy 记缺斤 | ⚠️ CreditNote 孤立造,OrderDiscrepancy 空 | — |
| 衍生数据 | PurchaseSuggestion 补货建议、Notification 通知 | ❌ 全空 | — |

### 1.2 完全没被任何 seed 覆盖的表

`Lot`、`Payment`、`PurchaseOrder`、`PurchaseOrderLine`、`GoodsReceipt`、`VendorBill`、`Account`、`JournalEntry`、`JournalEntryLine`、`PurchaseSuggestion`、`Notification`、`OrderDiscrepancy`、`ProductSupplierInfo`、`CustomerSpecialPrice`、`Uom`、`UomCategory`。

---

## 2. 现状勘察结论(决定"只改种子"还是"业务代码也补")

| 业务能力 | 代码位置 | 是否存在真实逻辑 | 对种子的影响 |
|---|---|---|---|
| 库存出入库(改 qtyOnHand + 写 StockMove) | `app/api/stock/route.ts` | 🟢 有,事务内完成 | 可复用,但只手动触发 |
| 采购收货入库 | `app/api/goods-receipts/route.ts` | 🟢 有,写 StockMove + 改 qtyOnHand | 可复用 |
| 发票金额勾稽 / 收款核销 | `app/api/invoices`、`app/api/payments` | 🟢 有,更新 amountPaid/amountDue | 可复用 |
| **确认扣库存(qtyOnHand + StockMove OUT)** | `app/api/orders/[id]/route.ts:459-484` + `bulk` | 🟢 **已实现**(CONFIRMED 时,允许负库存) | 种子等价重放即可,**无需补桥** |
| **发票过账自动记账** | `app/api/invoices/[id]/post` + `lib/accounting.ts` | 🟢 已实现(`postInvoiceToJournal`) | 种子复用 |
| **供应商账单过账记账** | `lib/accounting.ts:postVendorBillToJournal` | 🟡 函数存在但 app 未接线 | 种子直接 import 调用 |
| **收款记账** | — | 🔴 未实现 | 种子造平衡凭证(Dr 银行/Cr 应收) |
| **司机佣金计算** | `Trip.driverCommission` | 🔴 未实现 | 种子按 Σ(subtotal×commissionRate) 手填 |

**核心结论(修订):销售确认扣库存已实现,种子割裂的根因是旧脚本绕过确认逻辑。** 本方案是**纯种子事件驱动重写**(不改业务代码);仅会计/佣金两处缺口由种子在事件函数内补值(复用已有函数或造平衡凭证),并记录为后续待接线项。

---

## 3. 目标与原则(10 条策略)

**A. 生成方式**
1. 种子调用真实业务函数,而非 `prisma.create` 直接塞表——seed = 自动重放用户操作。
2. 按业务事件流编排,不按表编排——一条订单从下单走到收款,沿途留下因果一致的记录。
3. 可复现:用固定种子的伪随机(seeded PRNG),每次 seed 产出一致数据。

**B. 正确性**
4. 把对账校验写进种子,跑完自动断言,不通过即报错退出。
5. 软外键(如 `Invoice.saleOrderIds[]`)必须指向真实存在且状态自洽的记录。
6. 状态机一致性——COMPLETED 订单必配齐 wave/slip/trip/invoice;PENDING 不出现在已完成 trip 里。

**C. 完整性**
7. 覆盖全部业务链,不止销售链(逐链验收,见第 5 节)。
8. 主数据先于交易数据,且带真实约束(Uom 换算、供应商成本、客户特价)。

**D. 可用性**
9. 留一组"黄金路径"确定性实体,数字写死可手算;再留一组异常场景数据。
10. 分层 + 幂等可重置,提供一键 reset+reseed。

> 一句话:**把"往每张表灌数据"改成"让系统真的运营一遍"。**

---

## 4. 目标架构

### 4.1 种子分层

```
prisma/seed/
├── index.ts            # 唯一入口,按层编排 + 末尾跑对账校验
├── rng.ts              # seeded PRNG(可复现随机)
├── layer-1-master.ts   # 主数据:User/Category/Uom/Product/Customer/Supplier/特价/科目表
├── layer-2-events.ts   # 交易事件流:按时间线重放 进货→下单→出库→送货→开票→收款→记账
├── layer-3-scenarios.ts# 黄金路径 + 异常场景(确定性,数字写死)
├── events/             # 事件函数(优先复用 app 业务逻辑,薄封装)
│   ├── purchase.ts     #   下采购单 / 收货入库
│   ├── sales.ts        #   下单 / 拣货 / 出库(扣库存)/ 送货
│   ├── billing.ts      #   开票 / 收款核销 / 对账单
│   └── accounting.ts   #   事件触发记账
└── assert.ts           # 对账断言集
```

`package.json`:`db:seed` 指向 `prisma/seed/index.ts`,废弃散落的 `seed-*.ts`。

### 4.2 一条订单的生命周期时间线(事件驱动核心)

```
T0  进货:下采购单 → 收货 → StockMove(IN) → qtyOnHand 上涨 → 供应商账单
T1  下单:placeOrder() → Order(PENDING) + OrderLine
T2  确认:confirm → CONFIRMED
T2  确认:confirm → CONFIRMED → **StockMove(OUT) + qtyOnHand 下降**(已实现,扣库存发生在此)
T3  拣货:组 PickingWave → 缺货则记 OrderDiscrepancy
T4  分拣/送货:Wave SORTED → 装 Trip → IN_DELIVERY → COMPLETED(回写 deliveredQty,不再动库存)
T6  开票:生成 Invoice(saleOrderIds 勾稽真实订单,金额=订单和)
T7  收款:Payment 核销 → amountPaid/amountDue 更新 → 满额转 PAID
T8  记账:T0/T4/T6/T7 各自生成借贷平衡的 JournalEntry
```

每个事件都改变下游表的真实状态,数据天然串联且守恒。

---

## 5. 逐链改造计划

| 链 | 现状 | 改造动作 | 是否需补业务代码 |
|---|---|---|---|
| 主数据 | 部分 | 补 Uom/UomCategory、ProductSupplierInfo、CustomerSpecialPrice、Account 科目表 | 否 |
| 采购→收货→应付 | 种子空,代码有 | 用 goods-receipts 逻辑重放进货,生成 PO→GR→VendorBill | 否(复用) |
| 销售→出库 | 种子绕过确认逻辑才没扣 | 种子走"确认"事件即触发 StockMove(OUT)+扣 qtyOnHand;按时间线重放 | **否(已实现)** |
| 库存/批次 | 只入不出,Lot 空 | 收货建 Lot;确认出库时 FIFO 消耗 Lot(种子增强) | 否 |
| 应收 | 金额不勾稽 | 开票金额= 关联订单和;收款走核销逻辑;对账单汇总真实发票 | 否(复用) |
| 会计 | 全空且无自动记账 | 二选一:①补事件记账钩子(推荐) ②种子直接造借贷平衡凭证 | 视选型 |
| 退货/差异 | 孤立/空 | CreditNote 挂真实发票;拣货缺货生成 OrderDiscrepancy | 否 |
| 衍生 | 空 | PurchaseSuggestion 由"库存<安全库存+近期销量"推导;Notification 由事件触发 | 否 |

---

## 6. 黄金路径 + 异常场景数据集

### 6.1 黄金路径(确定性,数字写死,供手动点测)
- 1 个客户「测试餐厅 A」、5 个商品(库存写死:白萝卜 100、土豆 200…,价格写死)。
- 1 条贯通订单:下单白萝卜 20 → 出库后库存应为 80 → 开票金额可手算 → 分两笔收款核销至 PAID。
- **验收**:进后台手动给白萝卜再下 10 单,库存应实时变 70,全程可肉眼验证。

### 6.2 异常场景(覆盖非 happy path)
- 缺货拣货 → OrderDiscrepancy(订量>库存)。
- 逾期欠款 → Invoice 部分收款 + dueDate 过期。
- 退货 → CreditNote 挂已完成订单。
- 负库存预警 → 触发 PurchaseSuggestion / Notification。

---

## 7. 对账校验清单(seed 末尾自动断言,不过即 fail)

- 每商品:`Σ(StockMove.IN) − Σ(StockMove.OUT) === Product.qtyOnHand`
- 每发票:`Σ(payments.amount) === amountPaid` 且 `amountDue === totalIncTax − amountPaid`
- 每发票:`saleOrderIds` 指向订单的金额之和 === 发票总额
- 每凭证:借方合计 === 贷方合计
- 状态机:COMPLETED 订单存在对应 wave/slip/trip/invoice;Trip 内订单状态 ∈ {IN_DELIVERY, COMPLETED}

---

## 8. 分阶段实施路线

| 阶段 | 内容 | 产出 | 风险 |
|---|---|---|---|
| **P0 地基** | 搭 `prisma/seed/` 分层骨架 + seeded RNG + assert 框架;主数据层补全 | 可复现的主数据 + 校验框架 | 低 |
| **P1 销售链重放** | 种子走"确认"事件,复用已实现的扣库存逻辑;黄金路径贯通 | "确认扣库存"在种子中成立,黄金路径可用 | 低(不改业务代码) |
| **P2 应收链贯通** | 开票勾稽订单、收款核销、对账单汇总(复用现有逻辑编排) | 应收数据守恒 | 低 |
| **P3 采购+会计** | 采购收货重放;会计记账(补钩子或造平衡凭证) | 全链贯通 | 中(会计选型) |
| **P4 异常+衍生+清理** | 异常场景、补货建议、通知;删除旧 `seed-*.ts`;接好 reset+reseed | 全站事件驱动种子上线 | 低 |

---

## 9. 风险与回滚

- **P1 不改业务代码**:扣库存逻辑已存在于确认路径(允许负库存不阻断),种子只是等价重放,无现网逻辑改动风险。
- **会计链**:发票过账记账已实现(复用);采购账单记账复用已有 `postVendorBillToJournal`;收款记账种子造平衡凭证。自动记账钩子接线(采购/收款)留后续里程碑。
- **旧脚本废弃**:`seed-*.ts` 删除前先确认无 CI / 文档引用;保留一个 git tag 便于对照。

---

## 10. 待确认决策点

1. ~~P1 扣库存策略~~ —— 已澄清:扣库存逻辑已存在(确认时,允许负库存不拦截),种子等价重放,无需决策。
2. **会计链**:本期种子复用 `postInvoiceToJournal`/`postVendorBillToJournal` + 收款造平衡凭证;自动记账钩子接线留后续里程碑(建议)。
3. **数据规模**:黄金路径之外的随机交易量级,通过入口 `SCALE` 参数可调(small/medium/large);默认 medium。
4. **运行方式**:删库 reset 后 `db:seed`+`db:seed:events`,还是只增量跑带标记的 events?(种子两者都支持)
