# 数据所有权审计(SSOT)— 全库字段级地图

> 日期:2026-06-24
> 目的:系统排查"同一业务事实被分裂存储到多处、列表从不同源读取"导致的业务逻辑不一致(非程序 bug、非 DB 错误)。
> 方法:通读 `prisma/schema.prisma`(40 model / 14 enum) + 5 个并行 agent 全库扫描 `app/api/**`(102 routes)、`app/**` 页面、`lib/**`、`prisma/seed*` 的每个争议字段写入点/读取点。
> 分类口径:**canonical(唯一权威)** / **派生·合理快照(不要动)** / **冗余副本(已腐化,病灶)** / **死字段(无写入或无读取)**。

---

## 一、总体诊断

系统是"一个功能一个功能堆"出来的,核心病根是 **同一业务事实存在多个可写真相(multiple sources of truth),且各写入入口互不回写**。最典型的是你卡住的订单↔调度↔司机链路:报价单页写一套、调度台写另一套,谁也不同步。

按严重程度分四级,P0 直接导致端到端流程跑不通:

| 级别 | 病灶 | 影响 |
|---|---|---|
| **P0-1** | `Order.driverSlotId` ↔ `PickingWave.orderIds[]` 两套独立可写真相 | "这单归谁送"在报价单页和调度台各写一套,互不回写 |
| **P0-2** | `Trip` 与 `PickingWave` 两套平行配送实现 | 确认订单建 Trip(司机端用)+ 调度台用 wave,同一配送事实存两份 |
| **P0-3** | `Order.items`(Json)与 `OrderLine[]` 双存,items 已腐化 | 改单后 items 永不回写,报表/拣货/打印读 items → 同单不同页明细不一致 |
| **P1-4** | 三套配送状态机不同步 | `Order.status` / `wave.dispatchedAt`(WaveStatus 死) / `Trip.status` 互不驱动 |
| **P1-5** | 库存 `Lot.currentQty` 与销售出库脱节 | 销售只扣 `qtyOnHand` 不扣 Lot → 批次余量虚高,FIFO/效期不可信 |
| **P1-6** | 应收(AR)四套口径 | 财务页用最不准的 `Order.totalAmount`;凭证缺口致总账 AR 永久虚高 |
| **P1-7** | 权限 `role` vs `roles[]` 脱节 | 后端用 roles[]、前端用 role,改角色只写 role → 权限判定分裂 |
| **P2** | 一批死字段 / 冗余副本 | 见第四节清单 |

---

## 二、字段所有权矩阵(按链路)

### 链路 A:订单 ↔ 配送调度 ↔ 司机(核心病灶区)

| 字段 | 分类 | 写入点(file:line, 时机) | 读取点 | 问题 |
|---|---|---|---|---|
| `Order.driverSlotId` (FK) | canonical(订单意向) | `orders/route.ts:268`(下单带默认)、`orders/[id]/route.ts:133`(报价单页编辑) | `orders/route.ts:87`、`dispatch-loader.ts:98` | 与 wave.orderIds 各管一摊,无同步 |
| `PickingWave.orderIds[]` | canonical(实际调度) | `waves/[id]/assign:51`、`unassign:22`、`orders/[id]/batch:96`(拖拽) | `BatchTab.tsx:103`、`driver-summary:40` | **与 driverSlotId 是同一事实两套真相** |
| `Order.deliveryBatch` (字符串) | 冗余副本 | `orders/[id]/route.ts:132`、前端拼字符串 | `dispatch-loader.ts:99`(OR 匹配) | 旧合并字段,司机改名后陈旧,永不同步 |
| `PickingWave.driverName` | 冗余副本 | `generate-daily:46`、`batch:77`(建波时快照) | `driver-summary:65`(优先读快照→显示旧名) | 改名零级联 |
| `DriverSlot.driverName` | canonical(司机名唯一源) | `driver-slots/[id]:23`(改名) | 各处 slot 关联 | 改名**无任何级联**到上述 3 个副本 |
| `Order.deliveryDate` | canonical | 下单 `orders:267`、编辑 `[id]:136`、**确认出发回填=waveDate `dispatch:38`** | dispatch/accounting/print | 出发时被 wave.waveDate 反向覆盖,源/派生倒置 |
| `DeliverySlip.deliveryDate` | 派生快照 | `orders/[id]:505`(确认订单时快照) | print 送货单 | 确认后改期/出发回填,slip 不刷新→陈旧 |
| `PickingWave.waveDate` | canonical(排程日) | `generate-daily:42`、`batch:56` | `dispatch:29`、board | 合理 |
| `Order.status` | canonical | `dispatch:38`(CONFIRMED→IN_DELIVERY) | 列表过滤 | `WAVE_ASSIGNED` 枚举值无任何写入点 |
| `PickingWave.status` (WaveStatus) | **死字段** | 仅 `waves/[id]:32` 泛化透传 | board | PICKING/PICKED/SORTING/SORTED 无业务流推进,死状态机 |
| `PickingWave.dispatchedAt` | canonical(真实发车标志) | `dispatch:42` | `dispatch:20`(防重复)、`BatchTab:187` | 真正的"已发车"信号 |
| `Trip.status` (TripStatus) | canonical(Trip 自有) | `orders/[id]:512`(确认建 PENDING_ASSIGNMENT)、司机端 | `driver/page.tsx`、settlement | 与 wave/Order 状态机**完全独立无同步** |
| `Trip.waveId` / `Trip.restaurants`(Json) / `Trip.driverName` | 冗余副本 | `trips/route.ts:124/145`(建 Trip 时独立聚合+快照) | 司机端 | **与 wave 平行存储同一配送事实** |
| `Customer.defaultDriverSlotId` | canonical(客户默认) | 客户编辑 | `orders/route.ts:217`(下单带入) | 合理 |

**结论**:`Order` 上**没有** `waveId`,波次→订单是 `orderIds[]` 单向引用(查"某单在哪个波次"要全表 `has` 扫描)。`orders/[id]/batch/route.ts:18` 注释声明"单一存储=PickingWave,本接口只写 orderIds",但 `orders/[id]/route.ts:133` 同时仍写 `Order.driverSlotId` —— **设计意图与实现自相矛盾**,这是 P0-1 的根。Trip 与 wave 是两套平行调度(P0-2)。

### 链路 B:订单内容与数量

| 字段 | 分类 | 写入点 | 读取点 | 问题 |
|---|---|---|---|---|
| `OrderLine[]` | **canonical(真权威)** | 下单 `orders:271`、改单 `[id]:200/206`、差异 `order-discrepancies/[id]:78`、Trip 数量回写 | 详情页 `:283`、改单、PDF、列表 include | — |
| `Order.items` (Json) | **冗余副本(已腐化)** | **仅下单写一次** `orders:260`、`customer-portal:203`、seed | waves `:404`、warehouse `:88`、boss 销售报表 `:178`、day-wise 打印、invoices 列表 `:45`、restaurant 端、`trips/[id]/discrepancy:51` | **改单/确认/差异/送达/开票全不回写**;`orders/[id]:517` 把陈旧 items 灌进 `Trip.restaurants` 带入履约链 |
| `Order.totalAmount` | 派生(已存) | 下单 `:262`、改单 `[id]:338`(Σ前端 subtotal)、差异 `recalcOrderTotal:275`(Σ OrderLine) | 列表/详情/Trip/统计 | 改单信任前端 subtotal、不重算;两条重算路径口径不同 |
| `OrderLine.orderedQty` | canonical | 下单 `:281`、改单 `[id]:191`、差异调整 | 详情 | — |
| `OrderLine.deliveredQty` | canonical | Trip COMPLETED `trips/[id]:52`(=orderedQty)、退货减量、核货 | invoicedQty 源 | 干净,无双写 |
| `OrderLine.invoicedQty` | canonical(但回写粗暴) | 开票/过账 `invoices:136`、`post:39`(=deliveredQty) | 详情 | 按整单 `orderId IN` 刷新,**与具体发票行无关**,部分/多次开票会错 |
| `OrderLine.productName/spec` | 派生快照 | 下单 `:274`(冻结当时 Product.name) | 详情/PDF | 设计正确 |

**结论**:`OrderLine` 是唯一权威,`Order.items` 是从"第一次改单"起永久分裂的腐化副本。**根治 = 删 `Order.items` 列,所有读 items 的页面改读 lines**。

### 链路 C:库存 + 定价 + 计量单位

| 字段 | 分类 | 写入点 | 读取点 | 问题 |
|---|---|---|---|---|
| `Product.qtyOnHand` | **canonical(唯一活动余额)** | 确认扣减 `orders/[id]:476`、撤回回补 `:540`、收货 `goods-receipts:123`、报废、手动入/移库、差异、PO 收退 | 下单 ATP、仓库页、采购建议 | 全系统唯一真递增/减的库存 |
| `Product.stock` | **死字段/僵尸副本** | 仅导入 `products/bulk:32/77` | 仓库页 fallback `qtyOnHand ?? stock` | 导入后永不更新,fallback 会污染低库存预警 |
| `sum(StockMove.qty)` | 派生(审计流水) | 每次变动旁写 | 仅流水列表 | 从不聚合回核 qtyOnHand,无对账 |
| `sum(Lot.currentQty)` | 派生(批次余量) | 入库建 Lot、报废/手动出库扣减 | FIFO/效期/批次分析 | **销售出库(确认/bulk/差异)只扣 qtyOnHand 不扣 Lot → 批次虚高** |
| `ProductTemplate.listPrice/standardPrice/customerTaxRate` | canonical(可编辑源) | 商品编辑页 `:522` | 定价回退链 `server-pricing:253` | UI 只编辑模板层 |
| `Product.listPrice/standardPrice` | 冗余覆盖层 | 几乎无 UI 写 | server-pricing `??` 链**第一优先** | 优先级高于模板但无编辑入口,残留旧值会静默压价 |
| `Product.price` | 冗余/僵尸牌价 | 导入/旧数据 | pricing-engine `listPrice ?? price` | 与 listPrice 语义重叠 |
| `ProductTemplate.uomId` (FK) | 应 canonical 但**无写入口** | UI 无写(只写 String) | 商品列表 `products:24` | 实际常为 null |
| `ProductTemplate.unitOfMeasure` (String legacy) | legacy 但**唯一在写** | 编辑页 `:533` | 展示 | **读 FK 写 String 倒挂**,迁移声明与代码相反 |
| `ProductTemplate.purchaseUomId` (FK) | **死字段** | 无 | 无 | — |
| `OrderLine.uomId/uomName` | 未校验快照 | 下单 `:277`(原样透传前端) | 发票/送货单 | 服务端不反查商品 UoM,完全信前端 |
| `PurchaseOrderLine.unitCost` | canonical(交易价) | `purchase-orders:114` | PO 金额 | 不取自 supplierInfo.price 也不回写 |
| `PurchaseRecord.unitCost` | 孤立 legacy | `purchases:44` | 仅自身列表 | 与 PO 体系完全平行 |
| `Product.standardPrice` | canonical(定价成本) | 商品编辑手填 | pricing-engine margin | **收货从不回写**→进价变动后成本陈旧 |

### 链路 D:开票 + 收款 + 总账 + 对账 + 贷记单

| 字段 | 分类 | 写入点 | 读取点 | 问题 |
|---|---|---|---|---|
| `Invoice.lines` (Json) | 派生快照 | 创建 `invoices:119`(服务端重算前端 rawLines) | 发票详情/print | 开票后改订单不回流,永久过时;**PUT 可整体覆盖** |
| `Invoice.amountPaid/amountDue` | 派生(=Σ Payment) | `payments:92`(事务同步)、**`invoices/[id]:31` PUT `...data` 旁路** | statements、assert | **PUT 旁路:客户端可任意覆盖,绕过 Payment 同步** |
| `Invoice.subtotalExTax/totalTax/totalIncTax` | 冗余存储 | `invoices:105` | 过账凭证直取 | PUT 可篡改→凭证金额随之错 |
| `JournalEntry.totalDebit/Credit` | 冗余存储 | `accounting:69`(与行同写) | ledger | 无 Σline==total 校验 |
| 发票过账凭证 | canonical | `post:31`→`postInvoiceToJournal` | ledger | 科目缺失静默跳过→POSTED 但无凭证 |
| **收款凭证(Dr Bank/Cr AR)** | **缺口** | **无任何写入点** | — | 收款不冲减 AR→**总账 AR 只增不减,永久虚高** |
| **供应商账单/付款凭证** | **死函数/缺口** | `postVendorBillToJournal` 定义但**从不被调用** | — | 真实 AP 入账无凭证 |
| `VendorBill.amountPaid` | canonical(无流水) | `vendor-bills/[id]:56`(写绝对值) | page | **无 Payment 子表**,与 Invoice 逻辑不一致,无法审计分笔 |
| `Statement.totalSales` | 派生快照 | `statements:141`(=Σ Order.totalAmount) | — | 用订单额非发票额,口径不同,生成即冻结 |
| `Statement.totalPayments` | 派生快照 | `:142`(仅 PAID/PARTIAL) | — | **PARTIAL 状态全系统从未被设置**→部分付款漏算 |
| `CreditNote.*` | canonical(但游离) | `credit-notes:109` | page | 退款**不冲 Invoice 应收、不生成凭证、不直接产生 StockMove**,游离总账 |

**AR 四套口径**:A=Σ Invoice.amountDue(可被 PUT 篡改) / B=`finance/page.tsx:84` Σ Order.totalAmount(与收款无关,**老板看的就是这个**) / C=Statement.closingBalance(快照) / D=总账 1100 科目(因收款无凭证而虚高)。

### 链路 E:客户 / 用户 / 跨实体快照

| 字段 | 分类 | 写入点 | 读取点 | 问题 |
|---|---|---|---|---|
| `Customer.street/street2/state/zip/country` | **canonical** | 客户编辑表单 `customers/[id]/page.tsx:293` | 打印/发票/geocode/trip 主读 | `country` 前端默认 'Ireland' 与 schema 默认空串不一致 |
| `Customer.address` | 冗余副本(应降级派生) | 仅前端拼接 `:286`,**后端从不维护** | 各处仅作 fallback | schema 注释"后端自动维护"是假的 |
| `User.roles[]` | **canonical**(schema 注释优先) | 创建 `users:83`、login `:66`;**update 路由从不写** | 后端 `auth.ts:42 effectiveRoles`→`withAuth` | — |
| `User.role` (单) | 冗余副本(病灶) | 创建 `:82`、**update `users/[id]:23` 只写 role** | 前端 `permissions.ts:132 can()`、`useAbility`、`session` 只读 role | **后端用 roles[]、前端用 role,改角色只写 role→永久脱节** |
| `Customer.salesman` | canonical(自由文本) | 客户编辑 `:308`、bulk | SALES 过滤 `customers:68`、列表读 live | 非 User 引用,靠 `caller.name` 字符串匹配,改名即断 |
| `Order.salesman` | 合理快照(来源错) | 下单 `orders:270`(来自前端 salesTeam) | sales-report、pdf | place-order UI 控件同时标 "Driver" 和 "Salesman",**不取自 Customer.salesman**;列表又读 live customer.salesman→同屏两来源 |
| `Order.commissionRate` | **死字段** | **从不写入**(create 无此字段) | 仅 `:376` 回显(恒 null) | 注释承诺快照但无逻辑 |
| `Trip.driverCommission` | 死字段(生产) | **仅 seed** | settlement 只读 | 生产 API 从不计算 |
| `Customer.commissionFixed` | 近死字段 | 仅前端 form | 无消费者 | — |
| `Order.pricelistId/priceType` | **合理快照(不要动)** | 下单 `:264`(server-pricing 权威解析后冻结) | 定价回溯/报表 | 健康快照 |
| `latitude/longitude` | canonical(更新滞后) | 仅 `geocode:38`(手动批量) | 地图/排线 | 地址改后不自动重新 geocode |
| `Customer.vendorTaxRate` vs `ProductTemplate.vendorTaxRate` | 非真重复 | 各自维护 | 采购建议读 Template 的 | 命名同但语义不同(供应商默认税率 vs 商品税率) |
| `externalId` | canonical(Odoo 外键) | seed 导入 | 去重/对账 | 用途一致,无冲突 |

---

## 三、推荐的 owner 决策(待人工拍板)

> 原则:每个事实选一个 canonical owner,其余改为"引用它"或"实时派生",合理的下单快照保留。

| 事实 | 推荐 canonical owner | 处置其余 |
|---|---|---|
| 这单归谁送(司机/批次) | **`PickingWave.orderIds[]` 单一存储**(贯彻 batch/route.ts 注释意图) | `Order.driverSlotId` 降为"下单默认意向",确认/调度后一律以 wave 为准;读取统一封装一个 `getOrderDispatch(orderId)`;`Order.deliveryBatch` 字符串删除 |
| 司机名 | **`DriverSlot.driverName`** | `PickingWave.driverName`、`deliveryBatch` 改为实时经 `driverSlotId` 关联解析,不再快照 |
| 配送状态 | 选一套主状态机(建议 **wave.dispatchedAt + Order.status**),`Trip` 决策:要么废弃 Trip 改用 wave,要么明确 Trip 只做司机交账 | `PickingWave.status`(WaveStatus)删或接线;`WAVE_ASSIGNED` 删 |
| 订单明细 | **`OrderLine[]`** | **删 `Order.items` 列**,所有读 items 页面改读 lines(P0,见第五节顺序) |
| 交货日期 | **`Order.deliveryDate`** | `DeliverySlip.deliveryDate`、`wave.waveDate` 关系理顺:排程改 waveDate→出发时同步 deliveryDate,slip 实时派生或出发后刷新 |
| 库存余额 | **`Product.qtyOnHand`** | 删 `Product.stock` 及 fallback;销售出库补扣 `Lot.currentQty`(或明确 Lot 仅做效期不做余额);加 `qtyOnHand == Σ StockMove` 对账不变量 |
| 商品定价 | **`ProductTemplate` 层** | 清理 `Product.listPrice/standardPrice` 覆盖层与 `Product.price` 僵尸牌价 |
| 计量单位 | 二选一(建议补全 **FK `uomId`** 写入口,或干脆回退只用 String) | 删 `purchaseUomId` 死字段,消除读 FK 写 String 倒挂 |
| 发票金额 | **`Σ Payment`** | 移除 `invoices/[id]` PUT 的 `...data` 旁路,金额只能经 Payment 改 |
| AR 余额 | **总账 1100 科目**(并补全收款凭证) | 财务页弃用 Order.totalAmount 口径;补 Cr AR 收款凭证、接线 `postVendorBillToJournal` |
| 用户角色 | **`roles[]`** | `users/[id]` PUT 同步写 roles[];前端 `can()`/`useAbility` 改读 effectiveRoles |
| 客户地址 | **拆分五件套 street/...** | `address` 降为派生(后端按五件套拼,或前端只读展示) |

---

## 四、死字段 / 冗余清单(可直接删或补写)

**死字段(无写入或无读取,建议删除或补全逻辑)**
- `Order.deliveryBatch`(字符串副本)、`Order.commissionRate`(恒 null)、`Order.status::WAVE_ASSIGNED`(无写入)
- `PickingWave.status`(WaveStatus 整套 PICKING/SORTING 无业务流)
- `Product.stock`、`Product.price`(僵尸牌价)
- `ProductTemplate.purchaseUomId`(无读写)、`uomId`(只读不写)
- `Trip.driverCommission`(仅 seed)、`Customer.commissionFixed`(无读取)
- `postVendorBillToJournal`(死函数)

**冗余副本(已腐化,需统一)**
- `Order.items`(P0,见第五节)、`PickingWave.driverName`、`Customer.address`、`Product.listPrice/standardPrice` 覆盖层

**潜在运行时 bug(顺手修)**
- `vendor-bills/import:83` amountDue 误设为未税额;`:84` 对 Json 字段 `lines` 做嵌套 create(会抛错)
- `JournalEntry.name` 用全局 `count()+1` 与 seed 共用序列,并发易撞 `@unique`
- Invoice DELETE 级联删 Payment 但不回滚 amountPaid/凭证

---

## 五、推荐重构顺序(Strangler,前两步零风险)

严格按"先统一读 → 回填 → 再删重复写 → 最后删死字段",绝不一次性大改。

1. **(本文档)零风险映射** ✅ 已完成。
2. **owner 决策拍板**:对第三节逐条确认(尤其 Trip 去留、库存 Lot 策略)。
3. **封装统一读取口**:为"订单调度信息""库存余额""AR 余额"各写一个 server 端单一查询函数,所有列表/页面改调它(读先收口,不动写)。
4. **P0-3 先治 `Order.items`**:把读 items 的页面逐个切到 lines(可并行、可灰度),全切完后删列。这是收益最大、影响面最广的一步。
5. **P0-1/P0-2 治调度**:贯彻"单一存储=wave",`Order.driverSlotId` 与 wave 单向化;决定 Trip 去留。
6. **状态机显式化**:订单/波次状态转移集中一处定义,非法转移抛错。
7. **不变量护栏**:扩 `scripts/validate-data.ts`,加 `qtyOnHand==ΣStockMove`、`Invoice.amountPaid==ΣPayment`、`Σdebit==Σcredit`、`Order 调度信息单源` 等业务不变量,纳入 CI。
8. **E2E**:用真实 API 驱动跑通 下单→确认(扣库存)→排程→确认出发→送达→开票→收款 全链路,验证各列表同源一致。

---

---

## 六、owner 决策(2026-06-24 已拍板)

1. **调度单源**:`PickingWave.orderIds[]` 为「这单归谁送」唯一真相。`Order.driverSlotId` 降为下单默认意向,确认/调度后一律以 wave 为准;`Order.deliveryBatch` 字符串删除。
2. **Trip 去留**:Trip 只保留**司机交账**(送达/收款/佣金/settlement)职责;配送调度统一归 wave。Trip 的 restaurants/调度数据改为从 wave 派生,不再平行存储。
3. **执行节奏**:先做 **P0-3**(封装统一读取口 + 把读 `Order.items` 的页面切到 `OrderLine`),收益最大、风险最低、不依赖前两个决策即可开干。P0-1/P0-2 随后。

## 七、P0-3 实现记录(2026-06-24 已完成)

**方案**:不逐个改 115 个读取点,而是在 API 出口统一投影——`Order.items` 改为由 `OrderLine` 实时派生,Json 列变纯派生(后续可删)。页面几乎零改动,仍读 `.items` 但已是 lines 实时值。

**改动文件**:
- `lib/order-items.ts`(新)— 统一读取口 `lineToOrderItem` / `orderItemsFromLines` / `deriveOrderItems(List)`。
- `app/api/orders/route.ts` — 列表两条返回路径(分页+扁平)始终拉 lines(`include_lines=false` 时用精简 select),返回前投影 items。
- `app/api/orders/[id]/route.ts` — detail GET 投影;**修复 Trip 注入 bug**:确认订单建 Trip 时改用当前 lines 投影,不再灌入腐化的 `orderBefore.items`。
- `app/api/customer-portal/orders/route.ts` — 客户端列表投影。
- `lib/wave-zones.ts` — 顺手修复预存 build blocker(`Prisma` 误从 `@prisma/client` 导入,改为 `@/lib/generated/prisma/client`)。

**验证**:`tsc --noEmit` 全绿;`next build` ✓ Compiled successfully;事务模拟改单证明旧 items 列陈旧(2件)、新读取口返回新鲜值(9件),数据已回滚未改动。

**遗留**:`Order.items` 列现为纯派生,经一段观察期确认无人读后可 `db push` 删列;消费者页 `include_lines=false` 保留即可(服务端已统一投影)。不要给 items 列加"与 lines 一致"的不变量(改单后列本就不再同步,会误报)。

---

*本审计始于只读分析;P0-3 已落地(见第七节)。下一步:P0-1/P0-2(调度统一归 wave + Trip 仅保留交账)。*
