# 列表页分面搜索 v2：全站统一 + Odoo 语义对齐 开发计划

> 触发：客户提供 Odoo `Product Variants` 列表截图，指出两项能力缺失（同一分面多值 OR、多字段搜索下拉）。
> 上游：`docs/20260707-list-facet-search-plan.md`（v1，仅订单/报价单两页）
> 决策已定：**范围 = 全站 21 个列表页**；**分面间语义 = 改为 AND（与 Odoo 一致）**
> 规模判定：远超 5 个文件的重构 → 按 CLAUDE.md 第八节，本文含架构/质量/性能三项评估。

---

## 1. 客户诉求拆解（截图三个点）

| # | 截图证据 | 诉求 |
|---|---|---|
| ① | `Product: odlum or chef vi or salt 2 or ketch ×` + 批注「筛选出满足条件的多种产品」 | **同一分面内多值累积成 OR**，一次筛出多种产品 |
| ② | 下拉 `Search Product / Brand / Product Category / Attribute Values / Product Template / Location / Warehouse / Pricelist for: salt` + 批注「name, category, description」 | **同一段关键词可投向多个字段**，由用户选维度 |
| ③ | `Can be Sold ×` 与 `Product: ... ×` 两个 chip 并存 | **不同分面之间是 AND** |

---

## 2. 现状实测（2026-08-02）

### 2.1 三个差距

| 差距 | 证据 | 现状 |
|---|---|---|
| **同分面多值不支持** | `lib/list-filters.ts:37` `params.set(...)` | `set` 覆盖，同一维度只有最后一个值生效，能力为零 |
| **分面间是 OR，应为 AND** | `lib/orders-query.ts:117` `facetAnd.push({ OR: facetOr })` | 实际语义 `(f_code OR f_customer OR f_product OR f_category OR f_driver) AND 列筛选 AND 日期`。加条件结果变多，与直觉和 Odoo 均相反 |
| **19/21 页没有分面** | 仅 `orders/page.tsx:510`、`quotations/page.tsx:1028` 传了 `facetFields` | 其余 19 页只有单一文本框；商品页 `products/page.tsx:432` 亦然 |

### 2.2 页面分两类（决定工作量结构）

| 类型 | 页数 | 页面 | 加分面的代价 |
|---|---|---|---|
| **服务端查询**（已传参 + 服务端分页） | 7 | orders, quotations, customers, products→`/api/product-templates`, purchases, purchases/suggestions, statements | 需改对应 API 的 where 构造 |
| **客户端过滤**（全量加载后 JS 过滤 + 前端分页） | 14 | invoices, credit-notes, pricelists, users, trips, trips/[id], returns, sorting, sorter, waves/[id], driver, driver/settlement, vendor-bills, batch-analysis | **零 API 改动**，纯前端谓词即可 |

> 这条分类是本计划最重要的发现：14 页可以不碰后端。但它们「全量加载」本身是既有的性能隐患（见 §4.3），本次不修，只记录。

### 2.3 组件契约已经够用

`components/classic/OdooControlPanel.tsx` 现有 props：`facetFields: {key,label}[]`、`onFacetAdd(key,value)`、`activeFilters: {label,onRemove}[]`，**分面状态由父页面持有**。组件本身不需要重写，只需增加「分组渲染 chip」的能力（§3.3）。

### 2.4 商品侧字段可行性（对照截图下拉）

| Odoo 下拉项 | 可行 | 对应字段 |
|---|---|---|
| Product | ✅ | `Product.name` / `ProductTemplate.name` |
| Product Category | ✅ | `category.name` + `category.nameZh` |
| Product Template | ✅ | `template.name` |
| description（批注提到） | ✅ | `template.description` / `saleDescription` |
| Pricelist | ✅ | 已有 Pricelist 模型 |
| Internal Reference | ✅ | `internalRef`（截图首列） |
| Barcode | ✅ | `template.barcode` |
| Attribute Values | ⚠️ | `Product.variantAttributes` 是 `Json`，可查但需 JSON 路径查询，性能待测 |
| Location | ⚠️ | 仅有 `Product.currentZone`（库区），语义近似不等价 |
| Warehouse | ⚠️ | 需确认是否已有多仓概念 |
| **Brand** | ❌ | **schema 无 brand 字段**。截图中 `*Blue Bag*Odlums*Cream Plain Flour 25Kg` 的品牌是塞在 name 里的 |

---

## 3. 设计

### 3.1 目标语义（唯一定义，两处执行）

```
WHERE  (维度A 值1 OR 维度A 值2 OR 维度A 值3)
  AND  (维度B 值1 OR 维度B 值2)
  AND  (维度C 值1)
```

即：**同 key 内 OR，跨 key 之间 AND**。与 Odoo 搜索视图一致。

### 3.2 URL 编码：`set` → `append`

```ts
// 现在：params.set(`f_${key}`, v)          → 覆盖
// 改为：params.append(`f_${key}`, v)       → 累积
// 后端：searchParams.getAll(`f_${key}`)    → string[]
```

`Facet` 结构不变（每条 = 一个值，允许同 key 多条），渲染时按 key 分组。

### 3.3 核心：一套语义，两个执行器

避免 21 个页面各写一份筛选逻辑（v1 的 `orders-query.ts` 就是手写的，再复制 20 份是 DRY 灾难）。

```
                  FACET_DEFS（每种资源一份字典）
                 ┌──────────────────────────────┐
                 │ key / label / 如何匹配        │
                 └───────┬──────────────┬───────┘
                         │              │
         lib/facet-sql.ts│              │lib/facet-client.ts
         （服务端 7 页）  │              │（客户端 14 页）
                         ▼              ▼
              Prisma where 子句      JS 谓词函数
```

**服务端执行器** `lib/facet-sql.ts`
```ts
export interface FacetDef {
  key: string
  label: string
  /** 单个值 → 一条 Prisma where 子句 */
  toClause: (value: string) => Record<string, unknown> | Promise<Record<string, unknown>>
}
/** 同 key OR、跨 key AND，返回可直接并入 where.AND 的数组 */
export async function buildFacetWhere(sp: URLSearchParams, defs: FacetDef[]): Promise<Record<string, unknown>[]>
```

**客户端执行器** `lib/facet-client.ts`
```ts
export interface ClientFacetDef<T> {
  key: string
  label: string
  /** 从一行数据里取出所有可被该维度匹配的文本 */
  values: (row: T) => (string | null | undefined)[]
}
export function filterByFacets<T>(rows: T[], facets: Facet[], defs: ClientFacetDef<T>[]): T[]
```

两个执行器共用同一份 `Facet[]` 与同一套 OR/AND 规则，语义只定义一次。

**组件改造**：新增可选 `facets?: Facet[]` + `onFacetRemove?(key, value?)`，由组件负责把同 key 的值渲染成一个 chip（`产品: odlum or chef vi or ketch`），支持整组删除与单值删除。保留现有 `activeFilters` 用于非分面 chip（如状态筛选）。

### 3.4 分面间 AND 的落地

`lib/orders-query.ts:102-117` 的 `facetOr` 整体替换为 `buildFacetWhere(...)` 的输出，OR/AND 语义随引擎自动变正确，同时删掉手写分支。

---

## 4. 大改三评估（CLAUDE.md 第八节）

### 4.1 架构

- **边界清晰**：`FACET_DEFS` 是每种资源唯一的「可搜维度真相」，前后端两个执行器都从它派生，不会出现「前端能搜后端不能搜」的分叉。
- **单点故障**：两个执行器是纯函数、无 IO（`toClause` 可 async 仅为兼容 `driverNameClause` 这类需查库的维度），不引入新的运行时依赖。
- **与现有系统的关系**：`OdooControlPanel` 契约向后兼容（新增 props 全部可选），19 个未启用分面的页面在阶段推进前保持原样，不会被动受影响。

### 4.2 质量（DRY / 边界）

- **消除重复**：v1 的 `orders-query.ts` 手写分面逻辑迁入引擎，避免 21 份复制。
- **必须处理的边界**：空值 / 纯空格值 / 同 key 同值重复添加（应去重）/ 单值时不要包一层多余的 `{OR:[...]}`（会影响 Prisma 查询计划）/ 客户端执行器遇到 `null` 字段。
- **不做过度设计**：不引入通用查询 DSL、不做「保存的筛选器」云端同步（现有 `storageKey` 走 localStorage 已够）。

### 4.3 性能（⚠️ 必须正视）

| 项 | 风险 | 处理 |
|---|---|---|
| `contains` + `mode:'insensitive'` | 在 Postgres 上是 `ILIKE '%x%'`，**B-tree 索引用不上，全表扫描** | 当前量级（1718 商品、~789 单/周）无痛。**建议对 `Product.name`、`ProductTemplate.name`、`Customer.name`、`Order.code` 加 `pg_trgm` GIN 索引**，单列一个任务，可后置 |
| 同分面多值 OR | N 个值 → N 个 ILIKE，成本线性放大 | 前端限制单分面值个数（建议上限 10），超出给提示 |
| `lines: { some: { productName: like } }` | 多值 OR → 多个 EXISTS 子查询，订单行表最大 | 需在阶段 1 用真实数据量 EXPLAIN 验证；必要时改为先查 productId 集合再 `in` |
| 14 个客户端过滤页全量加载 | **既有隐患**，与本次无关但会被放大（用户以为能搜全库） | 本次不修，在计划中记录；invoices / users 增长后需单独做服务端分页改造 |

---

## 5. 分阶段计划

### 阶段 1：引擎 + 商品页（客户诉求直接对应）

| # | 任务 | 文件 |
|---|---|---|
| 1.1 | `Facet` 多值化，`applyFacets` 改 `append`，加去重 | `lib/list-filters.ts` |
| 1.2 | 新建服务端执行器 | `lib/facet-sql.ts` |
| 1.3 | 新建客户端执行器 | `lib/facet-client.ts` |
| 1.4 | 组件支持分组 chip + 单值删除 | `components/classic/OdooControlPanel.tsx` |
| 1.5 | 商品页 `FACET_DEFS`：名称/内部编号/类目/模板/描述/条码 | `app/api/product-templates/route.ts` + `products/page.tsx` |
| 1.6 | 两个执行器的单元测试（同 key OR、跨 key AND、空值、去重） | `tests/` |
| 1.7 | 真实数据量 EXPLAIN 验证多值 OR | — |

**阶段 1 出口**：商品页能复现截图行为（多值 OR + 多字段下拉），可以拿给客户看。

### 阶段 2：语义修正 + 服务端类其余 6 页

| # | 任务 |
|---|---|
| 2.1 | `orders-query.ts` 接入引擎，**分面间 OR → AND**（订单 + 报价单同时生效） |
| 2.2 | customers / purchases / purchase-suggestions / statements 四个 API 接入 |
| 2.3 | 回归：订单页现有筛选、列筛选、时间快捷、My 筛选不受影响 |

⚠️ 2.1 会改变订单/报价页现有行为（加条件从「变多」变「变少」），需**提前告知实际使用的同事**，并在发版说明里写清楚。

### 阶段 3：客户端类 14 页

纯前端，按页接入 `filterByFacets` + 各自的 `FACET_DEFS`。建议按业务重要度分批：
1. invoices, credit-notes, vendor-bills（财务，字段多、最受益）
2. users, pricelists, returns
3. trips, trips/[id], waves/[id], sorting, sorter, driver, driver/settlement, batch-analysis

### 阶段 4（可选，后置）

- `pg_trgm` GIN 索引
- Brand 字段（若客户确认需要，涉及 schema + 1718 商品数据回填）
- Attribute Values / Location / Warehouse 三个 ⚠️ 维度

---

## 6. 每页可搜维度字典（建议值，**需业务确认**）

引擎本身不难，真正的工作量在「每页搜什么」这 21 份字典。以下是我按现有字段给的建议，需要你或客户过一遍：

| 页面 | 建议维度 |
|---|---|
| 商品 | 名称 / 内部编号 / 类目 / 模板 / 描述 / 条码 |
| 客户 | 名称 / 编号 / 城市 / 业务员 / 价格表 |
| 发票 | 单号 / 客户 / 状态 / 关联订单号 |
| 贷记单 | 单号 / 客户 / 原订单 |
| 采购单 | 单号 / 供应商 / 商品 |
| 供应商账单 | 单号 / 供应商 |
| 用户 | 姓名 / 邮箱 / 角色 |
| 价格表 | 名称 / 关联客户 / 商品 |
| 行程 / 波次 / 分货 | 司机 / 时段 / 批次 / 客户 |
| 对账单 | 客户 / 期间 |

---

## 7. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| **AND 语义变更影响在用同事** | 订单页筛选结果变少，可能被当成"数据丢了" | 提前通知 + 发版说明；必要时先在订单页加一次性提示 |
| 21 份维度字典需逐页业务确认 | 拖慢阶段 3 | §6 先给建议值，让业务一次性批注，不要一页一页问 |
| ILIKE 全表扫描随数据增长劣化 | 搜索变慢 | 阶段 1.7 先 EXPLAIN 摸底，阶段 4 上 pg_trgm |
| 客户端 14 页全量加载 | 数据涨了会卡死浏览器 | 本次不解决，但需记录为独立技术债 |
| Brand 缺字段 | 客户可能认为「没做完」 | 需先确认客户是否真的要按品牌搜；若要，走阶段 4 |

---

## 8. 需要确认的问题

1. **Brand 要不要做？** 现在品牌塞在商品名里（`*Blue Bag*Odlums*...`）。加独立字段需要 schema 变更 + 1718 个商品的数据回填与人工校对。
2. **Attribute Values / Location / Warehouse 三项**是客户真实需求，还是只是 Odoo 自带的下拉项？这三项成本明显高于其他维度。
3. **§6 的 21 份维度字典**是否认可，有无要增删的维度。
4. **阶段 2.1 的 AND 变更**，需要提前通知哪些人？
