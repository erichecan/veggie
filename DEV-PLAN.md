# DEV-PLAN：可售单位（多规格）提成价按单位换算

## 背景

商品在**基础单位**上有一个司机提成价 `Product.commissionPrice`（如"每 kg 提成 €1"）。给商品加了"可售单位"（如箱装 = 10kg）之后，司机送这一整箱，提成应该怎么算？

### 现状（已核实，不是猜的）

- `ProductSaleUom`（可售单位表）目前**没有任何提成字段**，提成价只在 `Product` 基础单位层存一份。
- 提成总额目前**已经在按换算系数 `factor` 自动缩放**：`lib/commission.ts:sumCommission()` 把订单行的实送数量通过 `toStockQty()` 换算回基础单位等量，再乘以基础单位的 `commissionPrice`。数学上等价于「提成价 = 基础提成价 × factor，再乘以该单位的数量」——跟价格的 `AUTO` 模式（`price = basePrice × factor`）算法一致。
- **缺口**：可售单位的价格支持三种模式——`AUTO`(按 factor 折算)、`FIXED`(自定义一口价，如"箱装立减")、`FORMULA`(按 factor 再打折/加价)。但提成的换算**只认 factor，不认价格模式**——某个可售单位设了 FIXED 一口价或 FORMULA 折扣/加价，提成不会跟着变，仍然只按 factor 线性折算。跟 2026-08-27 那次修复成本/毛利换算（commit `839829b`）是同一类问题。

### 已与你确认的方向

提成价要**照抄价格的完整机制**：`ProductSaleUom` 每一行可以像价格一样，单独设一个提成价（override / 按公式加减），不填就默认按 factor 从基础提成价折算——跟现状行为完全一致。

## 模块拆解

### 1. Schema：`ProductSaleUom` 新增 4 个字段（迁移文件 + 一次性数据回填）

```prisma
commissionPriceOverride Decimal? @db.Decimal(12, 2)
commissionPriceMode     SaleUomPriceMode @default(AUTO)  // 复用价格那个枚举，语义完全一致
commissionDiscountPct   Decimal  @default(0) @db.Decimal(6, 4)
commissionSurcharge     Decimal  @default(0) @db.Decimal(12, 2)
```

**数据回填（必须落在迁移文件本身，不能是旁路脚本——见项目记忆里的教训）**：
新字段全部默认 AUTO/0/null，对**未来**新建订单行不影响正确性。但**存量** `OrderLine.commissionPrice` 目前存的是"基础单位提成价原值"，改造后这一列的语义要变成"该行在其选用单位下、已经折算好的提成单价"（详见下一节）。迁移里要对存量 `OrderLine` 做一次性 UPDATE：

```sql
UPDATE "OrderLine" ol
SET "commissionPrice" = ol."commissionPrice" * psu.factor
FROM "ProductSaleUom" psu
WHERE ol."commissionPrice" IS NOT NULL
  AND ol."uomId" = psu."uomId"
  AND ol."productId" = psu."productId"
  AND psu."isDefault" = false;
```
（`isDefault=true` / 没配多规格的行不动，factor 恒为 1，改不改结果一样。）这条 UPDATE 用的是当前 factor，跟现在 `toStockQty` 运行时用的是同一个数字来源——不会比现状更不准，只是把"运行时算一次"变成"落库存一份"，效果一致。

### 2. `lib/sale-uom.ts`：新增 `commissionPriceOf()`，逐字镜像 `priceOf()`

```ts
export function commissionPriceOf(
  saleUoms: SaleUomRow[],
  lineUomId: string | null | undefined,
  baseCommissionPrice: number | null,
): number | null
```
- 找不到配置/选的就是基础单位 → 原样返回 `baseCommissionPrice`（跟现状逐字一致）。
- `FIXED`：`commissionPriceOverride` 有值就用，否则 `round2(base × factor)`。
- `FORMULA`：`round2(base × factor × (1 + commissionDiscountPct/100) + commissionSurcharge)`；`base` 为 null 时按 0 算（只有 override/surcharge 能凭空造出提成）。
- `AUTO`（含未配置的旧行为）：`commissionPriceOverride` 有值就用，否则 `round2(base × factor)`。
- `baseCommissionPrice` 为 null 且没有 override → 返回 null（该商品本来就不计提成，任何单位都不该无中生有）。

同时扩展 `SaleUomItemInput` / `SaleUomRow` 加上 4 个新字段，`validateSaleUomItems()` 加对应校验（跟价格的校验规则一样：override 0–1,000,000、discountPct 0–100、surcharge ±1,000,000）。

### 3. 提成解析改为「按行选用单位」解析，而不是「按商品基础值」

- `lib/server-pricing.ts:resolveOrderLines()` 已经在算价格时批量拉了 `saleUomMap`（第 343 行附近）——顺手在同一循环里用 `commissionPriceOf()` 算出这一行的 `resolvedCommissionPrice`，作为 `ResolvedLine` 新增字段返回。这是价格换算的**唯一权威入口**，提成挂在它上面而不是另起一套查询，才是真正"像价格一样算"。
- `app/api/orders/route.ts`（新建订单/报价单）：删掉现在直接从 `Product.commissionPrice` 建 `commissionPriceMap` 那段（288–291 行），改用 `resolveOrderLines` 返回的 `l.resolvedCommissionPrice`。
- `app/api/orders/[id]/lines/route.ts`（订单里加行，93/109 行）：`resolveCommissionPrice(productId)` 改签名为 `resolveCommissionPrice(productId, uomId)`，内部查 `Product.commissionPrice` + 该商品 `saleUoms`，用 `commissionPriceOf` 算出per-行值。
- `app/api/orders/[id]/route.ts`（PUT 编辑订单重建行，326/415 行）：`newLineCommissionMap` 同理要按 `productId+uomId` 而不是只按 `productId` 建。

### 4. `lib/commission.ts:sumCommission()` 简化

`OrderLine.commissionPrice` 从此已经是"该行单位下折算好的提成单价"，不再需要在算提成总额时二次调用 `toStockQty` 折算数量——直接 `commissionPrice × deliveredQty`（`deliveredQty` 本来就是这一行自己单位下的数量，不用再换算）。去掉对 `toStockQty` 的依赖，逻辑更短也更对（现在 FIXED/FORMULA 场景下 `toStockQty` 完全不知道价格模式，去掉它反而修掉了这个不一致）。

### 5. `lib/analytics/driver-commission.ts`：`UOM_RATIO_SQL` 同步去掉

现在 `item_total` SQL 里手动拼了一段 `UOM_RATIO_SQL` 去乘换算比（169–219 行），跟 `lib/commission.ts` 保持"逐条对齐"全靠人工记着两边同步（本身就是脆弱设计）。改造后 `OrderLine.commissionPrice` 已经是折算好的值，这段 SQL 直接删掉，`item_total` 只需要 `SUM(commissionPrice × deliveredQty)`。少一份要人工对齐的重复实现。

### 6. 商品编辑页 UI（`app/[locale]/classic/operator/products/[id]/page.tsx`）

在可售单位每一行（非基础行）现有价格公式行（804–835 行 `€stepPrice + pct% + surcharge = €finalPrice`）下面，加一行同款提成公式编辑器：`Commission: €stepCommission + pct% + surcharge = €finalCommission`，复用同一套 `NumericInput` + `priceOf`-风格调用（换成 `commissionPriceOf`）。基础行沿用现有的顶层 "Commission Price" 输入框（620/629 行），不需要改。

### 7. `app/api/products/[id]/sale-uoms/route.ts`：PUT 接受并落库新字段

96–119 行 upsert 的 `create`/`update` 里加上 `commissionPriceMode`/`commissionPriceOverride`/`commissionDiscountPct`/`commissionSurcharge`，写法完全照抄现有 `priceMode`/`priceOverride`/`priceDiscountPct`/`priceSurcharge` 那四行。

### 8. 测试/审计补齐

- `scripts/audit/driver-commission-test.ts` 现在对多单位/FIXED/FORMULA 提成场景零覆盖（调研已确认），补一组用例：基础单位提成、AUTO 折算、FIXED override、FORMULA 折扣+加价四种场景各构造一单核对总额。
- `tests/pricing-engine-formula.test.ts` 或新建 `tests/commission-uom.test.ts` 补 `commissionPriceOf()` 的单元测试（镜像 `priceOf` 现有测试用例结构）。

## 风险与边界

- **不改变现有产品行为的默认值**：新字段全部默认 AUTO + 空 override，未特意配置的商品/可售单位算出来的提成总额跟改造前一字不差（历史 5474 个从没配过多规格的商品完全不受影响，这是延续现有 `sale-uom.ts` 顶部注释里定下的规矩）。
- **数据回填不可逆但可复算**：回填用的是"当前" `factor`，如果某个可售单位的 factor 在历史订单成交之后又改过，回填出来的值会用新 factor 而不是下单时的 factor——这跟现状（`toStockQty` 运行时永远用当前 factor）风险等同，不是本次引入的新问题。
- **已冻结（COMPLETED）订单的 `driverCommissionTotal`**：回填不会主动触发重算，只有后续因退货等原因调用 `recalcOrderCommission` 时才会用新口径重算——由于回填保证了 AUTO 模式下总额不变，只要 factor 没变过，重算结果与冻结前一致。
- **`FIXED`/`FORMULA` 提成模式是新增能力**，需要在商品编辑页里操作员主动去配置才会生效；不配置的商品行为不变。

## 涉及文件清单

| 文件 | 改动 |
|---|---|
| `prisma/migrations/<新迁移>/migration.sql` | 加 4 个字段 + 存量 `OrderLine.commissionPrice` 回填 |
| `prisma/schema.prisma` | `ProductSaleUom` 新增 4 字段 |
| `lib/sale-uom.ts` | 新增 `commissionPriceOf()`，扩展类型与校验 |
| `lib/server-pricing.ts` | `resolveOrderLines` 顺带算出 `resolvedCommissionPrice` |
| `lib/commission.ts` | `resolveCommissionPrice` 加 `uomId` 参数；`sumCommission` 去掉 `toStockQty` 依赖 |
| `lib/analytics/driver-commission.ts` | 删 `UOM_RATIO_SQL` 乘法 |
| `app/api/orders/route.ts` | 建单：改用 `resolveOrderLines` 返回的提成值 |
| `app/api/orders/[id]/lines/route.ts` | 加行：`resolveCommissionPrice` 传 `uomId` |
| `app/api/orders/[id]/route.ts` | 编辑单：`newLineCommissionMap` 按 `productId+uomId` |
| `app/api/products/[id]/sale-uoms/route.ts` | PUT 落库新字段 |
| `app/[locale]/classic/operator/products/[id]/page.tsx` | 可售单位行加提成公式编辑器 |
| `scripts/audit/driver-commission-test.ts` | 补多单位/FIXED/FORMULA 用例 |
| 新增 `tests/commission-uom.test.ts`（或并入现有测试文件） | `commissionPriceOf()` 单测 |

---

📋 计划已生成，请确认：涉及 schema 迁移 + 存量数据回填（`OrderLine.commissionPrice`），影响约 12 个文件。确认后我会按「迁移 → lib 逻辑 → API → UI → 测试」顺序开发并自测。回复"确认，开始开发"后我才继续。
