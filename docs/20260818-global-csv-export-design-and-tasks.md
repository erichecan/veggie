# 全站 CSV 导出模块 —— 设计与台账

> 起因：用户在商品列表页按名称分面筛出一批商品后点「导出」，弹出「导出功能即将推出」。
> 排查发现这不是个别页面的问题，而是全站导出能力的普遍缺失 + 已有实现各写各的。
> 决策日期：2026-08-18

---

## 一、现状盘点（2026-08-18 实测）

### 1.1 已经能用的导出（7 处，各自手搓）

| 位置 | 实现方式 |
|---|---|
| 销售单列表 `operator/orders` | 服务端 `GET /api/orders/export-csv`，复用 `buildOrdersWhere` |
| 日销售中心 `operator/daily-sales` | 服务端 `GET /api/print/day-wise-report-csv` + 客户端矩阵导出 |
| 财务台 `finance/page.tsx`（2 处） | 客户端手搓字符串拼接 |
| 司机报表 `finance/driver-reports` | 客户端手搓 |
| 毛利透视 `boss/analytics/margin/PivotView` | 客户端手搓 |
| 司机提成 `boss/analytics/driver-commission` | 客户端手搓 |
| 销售报表 `boss/sales-report` | 客户端手搓 |

只有销售单那一条是「服务端 + 复用列表筛选口径」的正确形态，其余客户端实现各写一份 CSV 转义逻辑。

### 1.2 死按钮（点了只弹 toast）

- `operator/products/page.tsx:436` —— 导出
- `operator/customers/page.tsx:174` —— 导出（另有 175 行的删除也是死的）
- `operator/pricelists/[id]/page.tsx:357` —— 导出
- `operator/pricelists/page.tsx:160` —— 导入（非本次范围）
- `operator/pricelists/[id]/page.tsx:341` —— 打印（非本次范围）

这些占位自 2026-07-10（commit `20a47e7`）起就是这个样子。

### 1.3 压根没有导出入口的列表页（14 个）

发票、采购单、供应商账单、贷记单、退货、行程、行程详情、对账单、用户、采购建议、分拣、批次分析、司机端、司机结算。

### 1.4 已有的可复用底子

- `lib/export/csv.ts` —— `buildCsv()`（RFC4180 转义 + UTF-8 BOM，Excel 中文不乱码）、`csvResponseHeaders()`、`money()`
- `lib/export/order-export-rows.ts` —— 订单的行构造，已是「列定义与路由分离」的雏形
- `lib/orders-query.ts` `buildOrdersWhere()` —— 列表与导出共用筛选口径的范例
- `lib/facets/` —— `customers.ts` / `product-templates.ts` / `purchase-orders.ts` 三份分面定义已共享
- `lib/facet-sql.ts` `buildFacetWhere()` —— 分面参数 → Prisma where
- `hooks/use-server-list.ts` —— 服务端分页列表 hook（目前仅销售单、报价单在用）

---

## 二、目标与非目标

### 目标

1. 全站列表页的「导出」都是真功能，导出内容 = **当前筛选条件下的全部结果**（不是当前页 50 条）
2. 导出的列 = **屏幕上看到的列**，所见即所得
3. 新增一个页面的导出成本足够低（一份列定义 + 页面一个属性），否则下一个页面又会退化成死按钮
4. 「导出的和屏幕上不一样」这件事在结构上不可能发生 —— 靠共用同一份筛选构造和同一份列定义，而不是靠自觉

### 非目标（本次明确不做）

- **不做 .xlsx**。CSV + BOM 已能被 Excel 正确打开；真 xlsx 要引新依赖（exceljs / sheetjs），另立需求
- 不动现有 7 处已能用的导出（收敛到新模块是后续待办，见第六节 D1）
- 不做导出任务队列 / 异步邮件送达。行数上限内同步返回

---

## 三、已拍板的决策

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D-1 | 导出范围 | 当前筛选的全部结果 | 用户实际诉求就是「筛完拿走」；勾选框跨不了页，做成「只导勾选」等于阉割 |
| D-2 | 列范围 | 屏幕上有什么就导什么 | 用户拿到的表能和屏幕对上，不产生「我那列哪去了」的疑问 |
| D-3 | 权限 | 沿用该列表的查看权限，不新增 export 权限点 | 能翻页就能抄，导出只是效率差别；且新增权限点必须同步补给现有角色，漏一个就是功能对某些人静默失效（本项目 2026-08-07 踩过，见 `docs/20260807-rbac-configurable-design-and-tasks.md`） |
| D-4 | 敏感字段（成本价/提成价/信用额度/税号） | 与屏幕一致 | 屏幕能看就能导，逻辑单一；真要控制应按字段级而非按功能级 |

> D-3 的例外：销售单已有的 `sales.order.export` 权限点保留不动，避免已配置好的角色权限发生变化。

---

## 四、架构设计

### 4.1 三层结构

```
lib/export/csv.ts                 序列化层（已存在）
  buildCsv / csvResponseHeaders / money / downloadCsv(新增，浏览器端)
        ▲                                    ▲
        │                                    │
lib/export/columns/<entity>.ts    列定义层（新增）—— 纯函数，无 Prisma 依赖
  export const PRODUCT_EXPORT_COLUMNS: ExportColumn<ProductTemplate>[]
        ▲                                    ▲
        │ 服务端用                            │ 客户端用
lib/export/registry.ts            实体注册表（新增）
app/api/export/[entity]/route.ts  统一导出路由（新增）
        ▲                                    ▲
        └──────── OdooControlPanel exportEntity / exportRows 属性 ────────┘
```

### 4.2 列定义层（关键）

```ts
export interface ExportColumn<T> {
  header: string          // 中英各一份，按 locale 取
  headerEn: string
  get: (row: T) => unknown  // 纯函数，不依赖 Prisma / React
}
```

**同一份列定义，服务端路由和浏览器端都能 import。** 这是「导出与屏幕不分叉」的结构保证：
客户端筛选的页面用它在本地把 rows 转 CSV，服务端筛选的页面用它在路由里转，格式完全一致。

### 4.3 两种导出模式（因页面数据流而异）

| 模式 | 适用页面 | 做法 |
|---|---|---|
| **S 服务端导出** | 服务端分页 + 服务端筛选的页面 | 前端把列表当前的 querystring 原样丢给 `/api/export/<entity>`，路由复用列表 API 同一个 `buildXxxWhere` |
| **C 客户端导出** | 全量拉到前端 + 客户端筛选的页面 | 用同一份列定义把屏幕上已筛好的 rows 转 CSV 本地下载 |

⛔ **不允许**给 C 类页面硬套服务端导出 —— 服务端不认识那些客户端筛选条件，结果会是「导出全部」而屏幕只显示一部分，正是本设计要杜绝的分叉。

### 4.4 统一路由

```
GET /api/export/<entity>?<列表页原样的筛选参数>
→ 200 text/csv (UTF-8 BOM)，Content-Disposition: attachment
→ 超过行数上限时截断并置 X-Export-Truncated: <实际匹配总数>
```

registry 每个实体登记：`{ permission, buildWhere, fetch, columns, filenamePrefix, rowLimit }`。

行数上限：默认 20000 行（沿用 `EXPORT_ROW_LIMIT`）。商品 4700 余条、客户 1600 余条均在限内。

### 4.5 前端接入

`OdooControlPanel` 新增两个互斥属性：

- `exportEntity="product-templates"` + `exportParams={queryParams}` → S 模式
- `exportRows={() => ({ rows: filtered, columns: INVOICE_EXPORT_COLUMNS })}` → C 模式

按钮的 loading 态、失败 toast、截断提示（「结果超过 2 万行，已导出前 2 万行」）统一由面板管，页面不再各写一遍。

---

## 五、实施台账（核心 8 个）

> 一周期 = 一条任务：做 → 验证 → 提交 → 回写本表状态。
> 每条的验收都必须**实际下载一次 CSV 并核对行数与筛选条件**，不能只看 build 通过。

- [ ] **E0 基建：序列化 + 列定义类型 + registry + 统一路由 + 面板接入**
      验收：以第一个登记的实体走通全链路，返回带 BOM 的 CSV；无权限角色返回 403；
            未登录返回 401；`OdooControlPanel` 传 `exportEntity` 后按钮渲染且有 loading 态
      产出：`lib/export/csv.ts`(改)、`lib/export/types.ts`、`lib/export/registry.ts`、
            `app/api/export/[entity]/route.ts`、`components/classic/OdooControlPanel.tsx`(改)
      依赖：无

- [ ] **E1 商品（S 模式）—— 本次的起因**
      验收：分面筛 `名称: 26/30 or onion` 后导出，CSV 行数 = 列表页显示的 total；
            列与屏幕一致（Internal Reference…Commission Price）；中文名在 Excel 中不乱码；
            叠加「负库存」筛选后再导，行数 = 页面角标显示的负库存种数
      产出：`lib/products-query.ts`（把 `app/api/product-templates/route.ts` 内联的 ~70 行
            where 构造抽出，含 facet / cf_ / cfm_ / 数值子串两步查 / 库存告警），
            `lib/export/columns/product-templates.ts`，两处页面接线
      依赖：E0
      ⚠️ 风险：抽 where 时若行为发生偏移，列表页筛选会跟着错。抽完必须对同一组参数
            比对「抽取前 / 抽取后」列表返回的 total 与首页 id 序列，一致才算过

- [ ] **E2 客户（S 模式）**
      验收：按销售员分面筛选后导出行数 = total；SALES 角色导出时行级隔离生效
            （只拿到自己的客户，与列表口径一致，见 `lib/row-scope.ts`）
      产出：`lib/customers-query.ts`（抽 where，含 `salesRowScope`）、
            `lib/export/columns/customers.ts`、页面接线
      依赖：E0

- [ ] **E3 报价单（S 模式，成本最低）**
      验收：报价单列表任意分面组合下导出行数 = total
      产出：`lib/export/columns/quotations.ts` + registry 登记（where 直接复用现成的
            `buildOrdersWhere`，无需新抽）、页面接线
      依赖：E0

- [ ] **E4 采购单（S 模式）**
      验收：按供应商/状态筛选后导出行数 = total
      产出：`lib/purchase-orders-query.ts`（抽 where，已有 `PURCHASE_ORDER_FACET_DEFS` 可复用）、
            `lib/export/columns/purchase-orders.ts`、页面接线
      依赖：E0

- [ ] **E5 发票（C 模式）**
      验收：屏幕筛选后导出行数 = 屏幕行数；改一个筛选条件重导，行数跟着变
      产出：`lib/export/columns/invoices.ts`、页面接线
      依赖：E0
      备注：该页现为 `?page=1&pageSize=200` 一次性拉取 + 客户端筛选，属技术债 D2

- [ ] **E6 供应商账单（C 模式）**
      验收：同 E5
      产出：`lib/export/columns/vendor-bills.ts`、页面接线
      依赖：E0

- [ ] **E7 贷记单（C 模式）**
      验收：同 E5
      产出：`lib/export/columns/credit-notes.ts`、页面接线
      依赖：E0

- [ ] **E8 对账单（S 模式）**
      验收：按客户/期间筛选后导出行数 = total
      产出：`lib/statements-query.ts`（抽 where）、`lib/export/columns/statements.ts`、页面接线
      依赖：E0

- [ ] **E9 收尾：回归 + 报告**
      验收：8 个实体逐一实际下载核对（表格记录：筛选条件 / 屏幕 total / CSV 行数 / 是否一致）；
            `npm run build` 通过；`npm run lint` 无新增错误；生产部署后至少在商品页实测一次
      依赖：E1–E8

---

## 六、后续待办（本次不做，但已识别）

- [ ] **D1 收敛现有 7 处手搓 CSV 到新模块**
      财务台 2 处、司机报表、毛利透视、司机提成、销售报表各有一份 CSV 拼接逻辑，
      转义规则不一定与 `buildCsv` 一致（含逗号/引号/换行的字段有产生错列的风险）。
      风险：这些是目前**正常工作**的功能，改动需逐个回归，因此不与新功能同批做。

- [ ] **D2 ⛔ 21 个列表页的数据加载方式不统一（用户点名的技术债）**

      | 加载方式 | 页面 | 问题 |
      |---|---|---|
      | 服务端分页 + 服务端筛选 | 商品、客户、销售单、报价单、采购单、对账单、采购建议 | 正确形态 |
      | 伪分页（`pageSize=200` 一次拉）+ 客户端筛选 | 发票 | 超过 200 条即静默丢数据 |
      | 全量拉取 + 客户端筛选 | 供应商账单、贷记单、价格表、行程、退货、用户、分拣、批次分析 | 数据量增长后必然拖垮页面；导出只能走 C 模式 |

      后果不只是导出：**筛选、排序、总数都在前端算，数据一多就静默出错**（发票页现在
      就只看得到最新 200 张）。且只有销售单、报价单两页在用 `hooks/use-server-list.ts`，
      同一个抽象没有推开。
      建议方向：把 `useServerList` 补上 facet / 列筛选支持后作为列表页统一底座，
      逐页迁移；每迁一页，其导出自动从 C 模式升级为 S 模式。
      工作量预估：8–10 个页面，每页涉及前后端各一半，属独立项目，需单独立台账。

- [ ] **D3 剩余 13 个列表页的导出**（退货、行程、用户、采购建议、分拣、批次分析、
      价格表、司机结算…）。E0 落地后每页成本 ≈ 一份列定义 + 一行属性，
      但 C 模式页面要等 D2 迁移后导出才真正可靠。

- [ ] **D4 真 .xlsx 导出**（若客户明确要求多 sheet / 格式 / 公式）。需引入 exceljs 或
      sheetjs，注意 `CLAUDE.md` 私有化部署铁律：纯 JS 库无宿主依赖，可接受。

- [ ] **D5 价格表详情页导出 + 价格表列表导入**（两个占位按钮，不在核心 8 个内）

---

## 七、风险

1. **抽 where 构造是本次最大风险**（E1/E2/E4/E8）。这些 where 现在内联在列表 API 里，
   抽出时任何行为偏移都会让**列表页筛选跟着错**——受影响的是每天在用的功能，不是新功能。
   缓解：每次抽取都做「抽取前后同参数比对 total 与 id 序列」的验证，写进该条验收。
2. **行级权限**：SALES 角色的客户/订单行级隔离必须在导出路由上同样生效。导出是批量拿数据，
   隔离漏掉一次的后果比列表页漏掉一次大得多（参考 2026-08-02 `/api/customers` 匿名泄露事件）。
   缓解：导出路由复用列表同一个 where 构造 + 同一套 row-scope，不另写查询。
3. **大结果集内存**：droplet 只有 2 vCPU / 3.8 GB 且无 swap（见服务器基线备忘）。
   20000 行订单带 lines 的序列化是有内存压力的操作。缓解：保持行数上限，超限截断并明确提示。
