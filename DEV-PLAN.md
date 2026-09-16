# DEV-PLAN：拣货单「按客户展开」改为可配置（Uom.expandByCustomer）

## 读取的文档

无独立产品文档。需求来自对话中客户口述三条：

> 拣货单分两部分，整箱整袋拣货单和零散的散货拣货单。散货中有些产品需要展开，有些产品不要展开。
> 留言的展开，没有留言的不要展开。整箱拣货单没有留言就不要展开。散货拣货单没必要的就不要展开。

客户同时提出备选方案："如果不行，就在可售单位那里加一个开关。"

依据的既有代码口径：`lib/print/trip-picking-template.ts` 顶部注释与 `belongsToConsumableTable`
（分表口径，20260913 commit `6d3d820` 定下"只看销售单位 goodsType、不看 Product.type"）。

## 需求辨析：为什么不照客户的原方案做

计划成立与否取决于四个生产库实测数字（本次查证，非推断）：

| 实测项 | 结果 | 推论 |
|---|---|---|
| 近 180 天订单行写了留言的比例 | 107,589 行中 **23 条**（BULK 21 / LOOSE 2） | 「有留言才展开」= 散货表 36,772 行里展开 2 行，等于功能消失 |
| `ProductSaleUom` 活跃行数 | **147 行**（多单位销售仍是试点） | 开关挂这里覆盖不到大多数商品 |
| 近 180 天落在散货表的商品 | 475 个，其中 **444 个（93.5%）没有 ProductSaleUom 行** | 这些商品单位走 `Product.uomId` 回退路径，无处挂开关 |
| `KG` 单位下单量为小数的比例 | 9,546 行中 8.3%（`LOOSE` 为 0%） | 无法用"小数=称重"自动推断，客户下单写整数，真实重量在秤上才产生 |

结论：

1. **留言是例外通道，不是配置通道**。它按行、临时、99.98% 为空，不能承担"这个商品要不要按客户拆"这种结构属性。
2. **开关必须放在 `Uom`（37 行，其中 30 个 LOOSE）而不是 `ProductSaleUom`**。Uom 是两条解析路径
   （`OrderLine.uomId` 与回退的 `Product.uomId`）最终都会落到的层级，覆盖率 100%，且 37 行一屏可复核。
3. **"进哪张表"和"要不要展开"是两个独立决策**，现在由 `goodsType` 一个字段兼任，这是本次要拆开的根因。
   前者决定哪个组在哪个区域拣，后者决定那个组需不需要按客户分装的数字。

## 目标行为

打印规则统一为一句，两张表一视同仁：

```
展开该商品的客户明细 = 该行有留言 OR 该销售单位配了 expandByCustomer
```

- 删除现在"`goodsType === 'LOOSE'` 恒展开"的特例（`trip-picking-template.ts:348`）
- 有留言时仍只列带留言的那个客户（`onlyNoted=true`），不因一个客户有备注就把整商品展开——现状逻辑保留
- "print multi line"按钮（`expandMode='all'`）行为不变，作为需要看全量时的人工兜底

### 判定标准（客户 20260916 口述，作为配置这个字段的唯一依据）

> **要展开**：配货时现切现称、每份包装上贴客户标签的。例：冬瓜基础单位是 `KG`，
> 客户可能点 2.5kg 或 6.2kg，拣货员得知道每家各多少才能切、才能贴标。
>
> **不展开**：提前备好的定量包装，按包数拿即可。例：`Fresh Red Chilli Class I` 可售单位 `1KG`，
> 一包就是 1kg，客户点 2 公斤就给两包，拣货员只需要总包数。

这条标准直接对应 `KG` / `g` / `LOOSE`（现称现切）与其余 27 个单位（定量包装）的分界。

### 补充模块：其余客户汇总行（必须与主改动同批做）

现状 `onlyNoted=true` 只列写了留言的客户，其余客户的数量被静默并进总数，纸面上账对不上。
生产实测（20260916 拣货单截图）：`FX Udon Noodle` 总量 41，只列出 7 + 2 = 9，**剩下 32 箱没有任何一行交代**；
同页 `Red Unicorn Rice`（9 vs 7）、`Pepper Green`（7 vs 3）同样有缺口。

**这不是顺带优化，是本次改动的必要配套**：现在散货表因为恒全展开，账一直是平的（截图 5+15=20）；
改成"按单位开关 + 有留言"之后，一个 `PACKET` 商品若 4 家里有 1 家写了留言，就会变成
"总量 20、只列一行 5"——今天不会发生的缺口会被引入散货表。

做法：`onlyNoted` 模式下，把被隐藏的客户合并成一行追加在末尾。

```
FX Udon Noodle 30's*200g CASE        41
  ↳ 818 Cake Studio D13  ⚠️ DS        7
  ↳ AE D5                ⚠️ ds        2
  ↳ 其余 3 家                        32     ← 新增
```

固定一行，不随隐藏客户数增长，不退回"一条留言拖累整商品全展开"（commit `88ff11b` 当初要解决的问题）。

## Schema 设计

`model Uom` 新增一列：

```prisma
/// 拣货时是否需要按客户拆开列明细。true = 称重分装类（拣货动作本身就是按客户过秤），
/// 拣货员必须看到每家各多少；false = 可数包装（整包拿，按总数拣即可，下游分拣再按送货单拆）。
/// ⛔ 与 goodsType 是两个独立维度：goodsType 决定进哪张表（哪个组、哪个区域），
/// 这个字段决定那张表里要不要列客户明细。不要用其中一个去推另一个。
expandByCustomer Boolean @default(false)
```

迁移（手写 SQL，不用 `db push`）：

```sql
ALTER TABLE "Uom" ADD COLUMN "expandByCustomer" BOOLEAN NOT NULL DEFAULT false;

-- 只有真·称重单位需要按客户展开；其余 27 个 LOOSE 单位都是可数包装，保持 false
UPDATE "Uom" SET "expandByCustomer" = true
WHERE "goodsType" = 'LOOSE' AND upper(btrim(name)) IN ('KG', 'G', 'LOOSE');

-- PALLET 分类纠正（客户 20260916 确认）：托盘是最大的整装单位，不该出现在零散货表。
-- 它已被停用（active=false），但停用只影响新建/编辑的下拉，历史订单行仍按 id 解析到它，
-- 打印时照样进散货表 —— 所以必须改 goodsType，不能靠停用解决。
-- ⛔ 只改分类，不动任何订单数据：那 3 条行所在的两张单里还有 11 条真实商品行。
UPDATE "Uom" SET "goodsType" = 'BULK' WHERE upper(btrim(name)) = 'PALLET';
```

按 `name` 而非 `id` 匹配的理由：本地开发库与生产库的 Uom 行不同源（本地 27 行 / 生产 37 行），
按 id 写死在本地回填不到。已实测生产 30 个 LOOSE 单位名单，`KG` / `g` / `LOOSE` 三个名字唯一，
`1KG` / `500g` 这类定量包装不会被 `upper()` 精确匹配误伤。

**回填后的结果（需你确认）**：展开 = `KG`、`g`、`LOOSE` 三个；收起 = 其余 27 个，包括
`PACK`(8154 行) `PACKET`(5670) `PKT`(5189) `TRAY`(880) `PUNNET`(348) `BOTTLE`(316) `EACH`(272)
`JAR`(270) `TIN`(181) `PALLET`(5) 以及 `1KG` `2KG` `2.5KG` `3KG` `5KG` `500g` `100g` `UK 4KG` `CAF 4KG` 等定量包装。

## 模块拆解（按依赖顺序执行）

| # | 模块 | 内容 |
|---|---|---|
| 1 | 数据层 | `prisma/schema.prisma` 加列 + 手写迁移 + 回填；同一迁移里把 `PALLET` 的 `goodsType` 改成 `BULK` |
| 2 | 装载层 ⚠️ | **两条** loader 各自把新字段取出来并挂到行上 |
| 3 | 模板层 | `pickBreakdownRows` 规则统一，删 LOOSE 特例 |
| 4 | 模板层 | `customerBreakdownRows` 在 `onlyNoted` 模式下追加「其余 N 家 合计 X」汇总行 |
| 5 | 配置入口 | 设置页「计量单位」表加一列开关；两个 uoms API 加字段白名单 |
| 6 | 文档 | help 页「如何新建/管理计量单位」补一句说明 |

## 文件清单（约 9 个）

```
prisma/schema.prisma                                    加列
prisma/migrations/<timestamp>_uom_expand_by_customer/   新建迁移
lib/print/trip-common.ts                                TripLine 加 expandByCustomer 字段
lib/print/trip-loader.ts                                ⚠️ 路径 A：取值 + 挂行
lib/print/dispatch-loader.ts                            ⚠️ 路径 B：取值 + 挂行（与 A 逻辑重复但独立）
lib/print/trip-picking-template.ts                      AggProduct 带字段 + pickBreakdownRows 改规则
app/api/uoms/route.ts                                   POST 白名单
app/api/uoms/[id]/route.ts                              PUT 白名单
app/[locale]/classic/operator/settings/page.tsx         列表加一列开关
app/[locale]/classic/operator/help/page.tsx             说明文案
```

## 路由清单

不新增任何路由。受影响的既有入口：

**写入（2 个）**：`POST /api/uoms`、`PUT /api/uoms/[id]` —— 加字段白名单，权限沿用现有配置，不动 route-map。

**读取 / 打印（4 个入口，2 条装载路径）**：

| 打印入口 | 装载路径 |
|---|---|
| `app/[locale]/classic/print/trip/[id]/_TripPrintClient.tsx`（浏览器打印·行程） | `trip-loader.ts` |
| `app/api/trips/[id]/picking-pdf/route.ts`（服务端 PDF·行程） | `trip-loader.ts` |
| `lib/print/dispatch-print-html.ts`（浏览器打印·配送中心） | `dispatch-loader.ts` |
| `app/api/print/dispatch-picking-pdf/route.ts`（服务端 PDF·配送中心） | `dispatch-loader.ts` |

（已核实 `app/api/waves/[id]/pick-sheet/route.ts` 只读波次记录，不走打印模板，不受影响。）

## 风险点

**R1 ⚠️ 最高：两条 loader 漏改一条。** `trip-loader.ts:249` 与 `dispatch-loader.ts:386` 各写了一份
完全相同的 goodsType 解析逻辑，是两份独立代码。只改一条，另一条打印入口会静默拿到 `undefined`，
表现为"行程单是对的、配送中心单不对"。
同类历史事故：20260801 `attachWaveDisplay` 漏了发票 PDF 与日报两条打印路径，102 单中 83 单司机错/缺。
**对策**：改完四个入口逐个实际出纸核对，不靠读代码判断。

**R2 配置错误是静默的。** 这个字段配错不会报错、不会留白，只会在打印出来的实体单据上错。
同类历史事故：20260907 `TRAY` 被配成 BULK，商品被印到错误的表。
**对策**：回填名单先给用户确认（见上），上线后拿真实波次打样核对，不只看设置页能存。

**R3 迁移回填误伤。** 已实测名字唯一性，`upper()` 精确匹配不会命中 `1KG`/`500g` 等定量包装。

**R4 `PALLET` 只改分类，绝不动订单数据。** 客户原话是"把 pallet 的历史订单取消"，核查后发现
那 3 条 `Transport PALLET`（€160 运费项，type=CONSU）分布在两张单上，而这两张单里还有 **11 条真实商品行**
（OP-260721-001 有 9 条：豆芽/茴香/辣椒/大米/蘑菇/洋葱/马蹄/西瓜…，OP-260718-001 有 2 条）。
整单取消会连带废掉这些真货，且 `CANCELLED` 在应用层是终态（`CANCELLED: new Set()`），取消后改不回来。
已与客户确认改为**只改 goodsType**（见迁移 SQL），订单一个字不动。

**R6 汇总行的"其余 N 家"必须用隐藏客户数，不能用总客户数。** 容易写错成
`byCustomer.size - 已列出数` 之外的口径。数量同理：必须是 `总量 − 已列出客户数量之和`，
不能重新去查库（那会引入与主行不同源的第二份真相）。

**R5 迁移执行方式。** 按既有约定写迁移文件，不用 `db push --accept-data-loss`（共享开发库会冲掉
其他 worktree 的字段）。生产走 `git push` → GitHub Actions → `migrate deploy`，不手动跑迁移
（会与 Cloud Build 的 migrate 步骤抢 advisory lock）。

## 大改附加评估

**架构边界**：不新增表、不新增模块，只在既有 `Uom` 上加一列布尔。不引入任何云厂商专有依赖，
符合项目「一切按迁到客户自有服务器设计」的铁律。

**复用而非新造**：完全复用既有的单位解析链路（`OrderLine.uomId` → 回退 `Product.uomId` → `Uom`），
新字段与 `goodsType` 在同一条 `$queryRaw` 里一起取，不新写解析逻辑、不新增解析分支。

**N+1 / 分页**：无。新字段并入既有的两条批量查询（`SELECT id, "goodsType" FROM "Uom" WHERE id = ANY(...)`
与 Product 基础单位 JOIN），查询次数不变。拣货单本身按整趟车聚合，无分页。

## 验证清单

- `npm run build` 与 `npx tsc --noEmit` 通过
- 迁移在本地跑通；生产经 Actions `migrate deploy` 应用成功
- 设置页开关能存、刷新后能回读、toast 正确
- **四个打印入口各出一张纸**，核对四件事：
  1. 称重货（`KG` / `LOOSE`）客户明细仍在 —— 冬瓜那类现切货必须能看到每家各多少
  2. 可数包装（`PACK` / `PKT` / `TRAY` / `1KG`）收成总量行，不再逐客户列
  3. 带留言的行仍然醒目展开，且只列写了留言的客户
  4. **每一个展开的商品，纸面上的账要平**：主行总量 = 列出的各客户数量之和 + 「其余 N 家」行的数量。
     拿截图里的 `FX Udon Noodle`（41 = 7 + 2 + 32）做基准用例逐个核对
- 生产库抽查：确认回填后 `expandByCustomer=true` 的恰好是 3 个单位；`PALLET` 的 goodsType 已是 `BULK`
- 回归确认：`PALLET` 那两张历史单（OP-260718-001 / OP-260721-001）的订单行、金额、状态一个字没变

## 已确认的决策（20260916）

1. **回填名单**：只有 `KG` / `g` / `LOOSE` 三个单位展开；其余 27 个（含 PACK / PKT / PACKET / TRAY /
   PUNNET / BOTTLE / JAR / TIN / EACH 及 1KG / 3KG / 500g / 2.5KG / 2KG / 5KG / UK 4KG 等定量包装）
   一律收起。依据是客户给的判定标准（见「目标行为」节）：现切现称贴标签的展开，按包数拿的收起。
2. **`PALLET`**：只改 goodsType 为 BULK，不动订单数据（见 R4）。
3. **其余客户汇总行**：与主改动同批实现，不拆开（见「补充模块」节）。
4. **配置入口只做设置页**，不进「按可售单位查看商品」页的批量编辑——37 行不值得再建一套批量工具。
