# DEV-PLAN — 可售单位在打印单据上的可读性 + 价格表按可售单位差异化定价

> 更新日期：2026-08-23
> 读取依据：无独立 PRD 文档；需求由用户对话直接描述（附两张实拍截图：波次拣货单、报价单打印页），本轮未读取额外产品文档。
> 触发背景：`可售单位`（多单位销售）功能刚上线（见上一轮 DEV-REPORT），用户复核打印单据时发现同一商品在拣货单上因为单位显示不一致而容易让拣货员看错数量，并提出两个后续需求：① 打印单据要让司机/拣货员看懂"这一行到底是多少货"；② 价格表要支持按可售单位对不同客户差异化定价。

---

## 0. 现状（实测代码 + 实拍截图，不是猜测）

### 0.1 截图诊断：拣货单同一商品两行单位不一致，是真 bug，不是本次新功能引入的

拣货单截图第 2、3 行都是「Pepper Green 5KG CASE」（同一 `productId`，两个不同客户各点了一次），单位列一个显示 `Unit(s)`、一个显示 `CASE`。

- 拣货单按 `${productId}::${uomId}` 分组（`lib/print/trip-picking-template.ts:87`），两行 `uomId` 确实不同，分组本身没错。
- 但 `uomName` 一个是空的。追到源头：`Product.uomName` 由 `template?.uom?.name ?? null` 派生（`app/api/products/route.ts:67,94`）——**该商品的 `ProductTemplate.uomId` 当时没设**，前端多处兜底成通用占位字符串 `'Unit(s)'`（`place-order.tsx:677/712/758/1763` 等 5 处硬编码 `?? 'Unit(s)'`）。
- 后果：两个客户点的其实很可能是同一种"箱"，只是其中一单是在这个商品还没配基准单位时下的，打印出来却像是两种不同货——拣货员没法靠这张单判断要不要合并拣、拣多少。

### 0.2 打印模板现状：已经有"商品名 + 规格(spec)"两行，但没有"换算说明"

四个司机/仓库侧模板（`trip-picking-template.ts` / `trip-sales-template.ts` / `trip-delivery-template.ts` / `trip-receipt-template.ts`）用的都是同一套字段：`productName`（大字）+ `spec`（商品名下方一行小灰字，`OrderLine.spec` 快照）+ `uomName`（单独一列）。用户报价单/发票打印页（`app/[locale]/classic/print/[id]/page.tsx`）也是同一套。

`spec` 是"这个商品长什么样"的自由文本快照（如"红包菜 Red Only"），跟这次的"可售单位换算关系"是两回事——**现在没有任何地方告诉看单据的人「这一行的 5 PKT，换算成基准单位是多少」**。截图里的"整箱整袋"分组标题已经暗示了拣货员是按"箱/袋"这种物理单位在找货，可售单位一旦精细到"1 箱拆成 40 小袋卖"，不显式换算出来，拣货员没法一眼判断该去拿几箱。

### 0.3 价格表现状：已经间接影响可售单位价格，但没有"按可售单位单独定价"的能力

`OdooPricelistItem`（`lib/types.ts:551-589`）只有 `applyOn: global/category/product/variant` 四种匹配范围，`resolvePrice()`（`lib/pricing-engine.ts:49`）算出的价格是**该商品基准单位**下的价格。下单/报价三处（`place-order.tsx:659` / `orders/[id]/page.tsx:163` / `quotations/[id]/page.tsx:245`）都是先用 `resolveCustomerPrice()` 拿到这个基准价，再用 `priceOf(rows, lineUomId, basePrice)` 按可售单位的系数/公式往下折算——**所以价格表规则已经会间接影响所有可售单位的价格**，改一条价格表规则，AUTO/FORMULA 两种模式的可售单位价格全部自动跟着变（这正是用户这次要求在页面上提示的行为，且已经是事实，不需要新写计算逻辑，只需要把这句话说清楚）。

但如果要的是"客户 A 买这个商品的 CASE 就该是固定 €X，不走系数换算"这种直接针对某个可售单位的定价，现在的规则做不到——`applyOn=product/variant` 匹配范围里没有"只对这个商品的某个可售单位生效"这一档。

---

## 1. 模块拆解 & 已确认决策

| # | 模块 | 范围 | 是否需要 schema | 状态 |
|---|------|------|:---:|:---:|
| D | 价格表编辑页加提示文案："这个价改了，商品配置的其他可售单位会自动跟着变" | 纯文案，1 个文件 | 否 | ✅ 已完成 |
| A | 修复「Unit(s)」占位符与真实单位混排导致误读 | 打印模板 + 下单/报价/订单编辑 3 个页面的兜底逻辑 + 审计脚本 | 否 | ✅ 已完成 |
| B | 打印单据加"可售单位换算说明"，让拣货员/司机看懂这一行等于多少基准单位 | 5 处打印模板 + `orders/[id]` GET 路由 + 新文件 `lib/print/uom-conversion.ts`（实施中改为 live 查询，见§2） | 否（原计划要，实施中推翻） | ✅ 已完成 |
| C | 价格表支持按可售单位差异化定价 | `OdooPricelistItem` 加可选单位范围 + 定价引擎 + 价格表编辑页 UI + 下单/报价/订单编辑 3 处调用点 + 服务端权威定价 | **是（仅 TS 类型，无需迁移）** | ✅ 已完成 |

D 与 C 互不依赖，文案描述的是**已经成立的事实**（见 0.3），可以先于 C 完成上线；C 上线后需要把 D 的文案再补一句"除非该单位单独设了固定价"。A、B 互相独立，可以并行。

### 已确认决策

| # | 决策点 | 采用方案 | 理由 |
|---|--------|---------|------|
| 1 | A：缺 `uomId` 商品的兜底展示 | 打印/下单页不再用容易和真实单位混淆的通用占位字符串 `Unit(s)`；改为更醒目的提示（如带 ⚠ 标记 + 商品原名截取的规格片段），并生成一份「缺基准单位商品」清单落到 action-log/审计脚本，供你抽空去商品页逐个补 `Unit of Measure` | 截图暴露的问题是"看着像两种货"，根源是数据没配全；先让展示层不再制造误解，同时不悄悄吞掉这个数据缺口——留痕比自动瞎猜一个单位更安全 |
| 2 | B：换算说明的呈现形式 | 系数 <1 时按倒数换算成"1 大单位 = N 小单位"（如 `1 CASE = 40 PKT`），系数 ≥1 时直接顺述（如 `1 CASE = 6 × 2KG`）；两种都优先用 `netWeight`（如有）换算出实物重量作为第二行小字辅助（如 `≈ 1.5kg`） | 拣货员认物理包装不认小数系数，"1 箱 = 40 袋"比"factor=0.025"直观；重量是仓库场景里除了个数外最直接的第二参照 |
| 3 | B：换算说明存哪 | ⚠️ 实施中推翻原计划：**不给 `OrderLine` 加快照字段**，改为打印时 live 查询 `ProductSaleUom`——发现 `lib/print/trip-loader.ts` 里已有的 `packSpec`（拆箱用）就是同一类"包装规格"信息，走的正是"live 查询、不落库快照"这条路，是已经验证过的既有模式；这类纯展示用的换算说明和金额/库存快照不是一回事，跟着抄一份现成模式比新开一条 schema 更省，也更符合"能否复用现有代码"的评估原则。新文件 `lib/print/uom-conversion.ts` | 与 `productName`/`spec`/`uomName` 三个既有快照字段的治理原则不冲突——那三个是"下单当时的事实"必须冻结；换算系数是"商品现在长什么样"，跟包装规格（`packSpec`）同一类，本来就该是 live 的 |
| 4 | C：可售单位范围只对 `applyOn ∈ {product, variant}` 生效 | `category`/`global` 范围的规则不支持限定到某个可售单位（不同商品的可售单位配置互不相同，"这个分类下所有商品的 CASE"没有统一意义） | 与 Odoo 语义、及现有 `matchesItem()` 的四档范围保持一致，不强行让语义不通的组合能选 |
| 5 | C：单位限定规则与不限定规则的优先级 | 复用现有 `sequence` 排序机制，不额外发明"更具体的规则优先"——用户自己把限定单位的规则往前排（`sequence` 数字小）即可命中；不限定单位的规则退化成"对该商品所有可售单位都生效"的兜底规则 | 少一套新的隐式优先级规则，价格表已有的排序心智模型直接复用，界面上不用新解释一套"精确匹配优先"的隐藏逻辑 |
| 6 | C：命中单位限定规则后，是否还叠加可售单位自身的 factor/formula | 不叠加——单位限定规则算出来的就是该单位的最终价（跟现在 `fixed/percentage/formula` 三种算法直接输出"这个商品的最终价"是同一语义），不再乘以 `ProductSaleUom.factor` | 否则会出现"规则里填的数字"和"实际生效的数字"不一致，用户在价格表页填了 €10，下单却显示 €10×系数，无法用界面数字直接对账 |

---

## 2. Schema 改动

**模块 B 原计划给 `OrderLine` 加 `uomFactor` 快照字段——实施中推翻，改为 live 查询复用 `lib/print/trip-loader.ts` 里已有的 `packSpec` 模式（详见上面决策#3），不再需要这条迁移，也不需要在下单/编辑三个页面写任何东西。这次 schema 改动只剩模块 C 一项。**

```prisma
/** 价格计算方式不变，OdooPricelistItem 仍是 OdooPricelist.items 里的 JSON 数组元素（非独立表），
 *  加一个可选字段即可，不需要迁移脚本 —— TS 类型层面加，JSON 里没有这个字段的旧数据视为"不限定单位"。 */
export interface OdooPricelistItem {
  // ...既有字段不变...
  /** 20260823：仅 applyOn ∈ {product, variant} 时可选填。填了则这条规则只对该商品/变体的这一个
   *  可售单位（ProductSaleUom.uomId）生效；不填 = 对该商品所有可售单位（含基准单位）都生效，与现状一致。 */
  uomId?: string
}
```

`OdooPricelist.items` 是 `Json` 字段（`prisma/schema.prisma:654`），加 `uomId` 不需要写 `.sql` 迁移，只改 TypeScript 类型定义 + 定价引擎读取逻辑。

---

## 3. 涉及文件清单

### 模块 A（占位符修复，无 schema）
- `app/[locale]/classic/operator/place-order/page.tsx`（5 处 `?? 'Unit(s)'`）
- `app/[locale]/classic/operator/orders/[id]/page.tsx`
- `app/[locale]/classic/operator/quotations/[id]/page.tsx`
- 新增审计脚本 `scripts/audit/products-missing-uom.ts`：扫描"有过订单行但 `ProductTemplate.uomId IS NULL`"的商品，量化清单规模，决定是否需要批量提醒运营去补

### 模块 B（打印换算说明，实施后无 schema，已完成 ✅）
- `lib/print/uom-conversion.ts`（新文件：`loadUomConversionMap()` live 查询 + `formatUomConversionHint()` 纯格式化函数，决策#2 的倒数/顺述两种phrasing + netWeight 重量估算都在这）
- `lib/print/trip-common.ts`（`TripLine` 加 `uomConversion` 字段）
- `lib/print/trip-loader.ts` / `lib/print/dispatch-loader.ts`（两条各自独立查询 Order 的 loader，都要接 `loadUomConversionMap`——已验证 `dispatch-loader.ts` 原本连 `packSpec` 都没接，是既有缺口，这次顺带一起补齐 uomConversion 但不管 packSpec）
- `lib/print/trip-picking-template.ts`（拣货单：按聚合后的 `totalQty` 现算）
- `lib/print/trip-sales-template.ts` / `trip-delivery-template.ts` / `trip-receipt-template.ts`（按单行 `orderedQty` 现算）
- `app/api/orders/[id]/route.ts`（GET 返回每行加 `uomConversionHint`/`uomWeightHint` 两个已格式化字符串，供客户端打印页用，不需要在客户端重新实现一遍换算逻辑）
- `app/[locale]/classic/print/[id]/page.tsx`（客户报价单/发票打印页，渲染上面两个字段）
- 下单/报价/订单编辑三个页面**不需要改**——原计划"行提交时写快照"的方案已作废

### 模块 C（价格表按可售单位定价，含 schema，已完成 ✅）
- `lib/types.ts`（`OdooPricelistItem` 加 `uomId?`）
- `lib/pricing-engine.ts`（`PriceResolution` 加 `matchedUomId?`；`matchesItem()` 加单位过滤；`resolvePrice()`/`resolveViaPricelistChain()`/`resolveCustomerPrice()`/`computeItemPrice()` 签名加可选 `uomId` 参数并逐层透传，含嵌套 `formulaBase='pricelist'` 递归）
- `app/api/pricelists/[id]/route.ts`（`normalizeItems()` 加 `uomId` 白名单：只有 `applyOn ∈ {product, variant}` 时保留，否则丢弃，避免切回 category/global 后残留一个悄悄拦规则的死值）
- `app/[locale]/classic/operator/pricelists/[id]/page.tsx`（`applyOn=product/variant` 时加"限定可售单位"下拉，按 `productTemplateId`/`productVariantId` 现查该商品的 `ProductSaleUom`；命中单位限定规则时在 Price Computation 区块顶部用醒目色块标出"这条规则算的是【CASE】的最终价"，对应风险点#3；切 applyOn 或换商品/变体时自动清空 `uomId`；表格 Applicable On 列加小徽章显示限定单位）
- `app/[locale]/classic/operator/place-order/page.tsx` / `orders/[id]/page.tsx` / `quotations/[id]/page.tsx`（`computeLinePrice`/`selectProductIntoLine`/`switchLineUnit` 调用 `resolveCustomerPrice` 时把 `lineUomId` 一起传下去；命中单位限定规则(`res.matchedUomId`)时**不再**额外乘 `factor`，直接用规则结果；`orders`/`quotations` 两个编辑页的 `switchLineUnit` 原本刻意不重新触发定价引擎（保护用户手改过的价），这里加了一次"仅探测有没有单位限定规则命中"的调用，命中才改用规则价，不命中则维持原有的按比例换算逻辑，不影响那条既有保护）
- **⚠️ 计划外但必须一起改，否则模块 C 在服务端权威定价这一步会被判"超出容差"而失效**：`lib/server-pricing.ts` 的 `resolveOrderLines()`——
  1. `resolveCustomerPrice(...)` 调用补上 `item.uomId`，否则单位限定规则在服务端永远不会命中
  2. 命中 `resolution.matchedUomId` 时 `authoritative` 直接取 `resolution.price`，不再走 `scaleAuthoritativePrice()` 二次乘 factor（决策#6 服务端对齐）
  3. 顺带修了一个在这次改造前就存在、与本次目标相关的独立 bug：`scaleAuthoritativePrice()` 换算非基准单位时读的是**全局 `Uom.factor`**（生产库 Unit 类目下恒为 1），跟 20260819 起客户端已切到的 `ProductSaleUom.factor` 口径脱节——服务端"权威价"因此对非基准单位一律算成基准价，客户端按箱规算对的价格反而会被判超出容差。已改成直接用已经查到的 `ProductSaleUom.factor`，与 `lib/sale-uom.ts:priceOf()` 同源；顺带删掉了因此变得多余的一次 `Uom.findMany` 查询。
  该函数是 `POST /api/orders`、`PUT /api/orders/[id]`、`POST /api/orders/[id]/lines`、customer-portal 下单共用的唯一入口，不改这里，模块 C 在编辑页里看着生效，一提交订单就会被服务端悄悄打回基准价——且不会报错，属于风险点#2 的同类陷阱。
- 新增测试 `tests/pricing-engine-uom-scope.test.ts`（7 条，覆盖决策#4/#5/#6 + `resolveCustomerPrice` 透传）

### 模块 D（价格表提示文案，无 schema，可独立先上）
- `app/[locale]/classic/operator/pricelists/[id]/page.tsx`：在 `Price Computation` 区块三种算价方式（fixed/percentage/formula）各自已有的灰字提示"The computed price is expressed in the default Unit of Measure of the product."后面，各加一句：
  > 英文：This price is the base unit price. Other sellable units configured for this product (e.g. CASE, PKT) will automatically follow it — unless a unit-specific rule (see below) overrides them.
  > 中文：这是基准单位的价格。该商品配置的其他可售单位（如箱/袋）会自动跟着这个价联动 —— 除非下面为某个单位单独设了限定规则。
  括号里"see below"那句要等模块 C 上线才成立，模块 C 未上线前先用不含这句的版本（见下方"分阶段"）。

---

## 4. 风险点

1. **B 的 `uomFactor` 只是打印用快照，不能被误用去算钱**：命名和注释要明确"仅用于打印说明"，避免以后有人图省事拿它去参与金额计算（金额口径已经在 `unitPrice` 里，多一条平行路径就是新的 SSOT 分裂风险，参照 `[[data-ownership-audit-20260624]]` 的教训）。
2. **C 改变了定价引擎的对外签名**（`resolvePrice`/`resolveCustomerPrice` 加参数），三处调用点（下单/报价/订单编辑）漏改一处就会导致该页面"按单位定价"规则不生效，且不会报错——只是价格算错，容易被当成正常功能验证通过。上线前必须三处都真实下单验证，不能只测一处就类推另外两处。
3. **C 的"命中单位规则后不再乘 factor"**（决策#6）如果运营不理解，会在价格表里填了一个"基准价"却以为是"这个单位的价"，导致填错数量级（比如把 CASE 的价填成了跟 PKT 一样的数字）。价格表编辑页在单位限定规则生效时要把当前选中单位的名字醒目标出来（如"这条规则算出的是【CASE】的最终价"），不能只在小字里带过。
4. **A 的审计脚本可能扫出较大数量的历史商品**（生产库 1718 个商品中有多少从未配过 `uomId` 未知，需要先跑脚本拿到真实数字才能决定要不要做批量提醒/强制补全），这属于"先测再定方案"的一步，不在这份计划里先假设数字。
5. **不属于本次范围**：`day-wise-report-template.ts`（日报表）目前按 `productName` 分组汇总、不区分单位（`lib/print/day-wise-report-template.ts:204`），是否要在日报里也拆开显示不同可售单位，这次不动，只做前面 5 个"按单据行"打印的模板。

---

## 5. 分阶段建议（可拆成独立可验证的交付单元）

1. **D 独立先上**（不含"see below"那句、不依赖 C）：价格表页面加提示文案，1 个文件、纯文案，验证方式=打开任意价格表规则截图对比。
2. **A**：审计脚本先跑出数字 → 定占位符展示方案 → 改 3 个页面。
3. **B**：加 `uomFactor` 迁移 → 3 处下单/编辑页写入 → 5 处打印模板渲染换算说明。
4. **C**：`OdooPricelistItem` 类型加字段 → 定价引擎改造 → 价格表编辑页 UI → 3 处下单/编辑页调用点 → 回头把 D 的文案补上"see below"那句。

每一步都能独立验证、独立提交，互不阻塞（除了 D 的收尾要等 C）。

---

📋 计划已生成，请确认：
- 上面 6 条"已确认决策"（尤其 #2 换算说明的呈现形式、#4 单位限定规则只对 product/variant 生效、#6 命中单位规则后不再叠加 factor）是否符合你的预期？
- 是否按"D → A → B → C"这个顺序推进，还是你有别的优先级？

回复"确认，开始开发"（或指出要调整的地方）后我再开始动手。
