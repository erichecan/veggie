# 全站导入导出功能审查 + 可抽离中间件清单

调查日期：2026-10-03
调查方式：只读代码审查（grep/glob + 人工复核），无代码变更

## 一、导入导出现状全表

| 模块 | 导入 | 导出 | 导入实现方式 | 导出实现方式 |
|---|---|---|---|---|
| 商品 products | 有 | 有 | **独立专属**：`components/classic/ProductImportDialog.tsx` → `app/api/products/bulk/route.ts`（注释明确写"不复用通用组件"） | 统一：registry entity `product-templates` |
| 客户 customers | 有 | 有 | 统一壳：`CsvImportDialog.tsx` → `/api/customers/bulk/route.ts`（字段校验与 suppliers 平行照抄，非共享函数） | 统一：registry entity `customers` |
| 供应商 suppliers | 有 | 有 | 统一壳：`CsvImportDialog.tsx` → `/api/suppliers/bulk/route.ts`（同上） | 统一：registry entity `suppliers` |
| 采购单 purchase-orders | 有 | 有 | 第三套：`lib/import-parser.ts` + `lib/purchase/product-match.ts`（PDF/Excel 解析订单行） | 统一：registry entity `purchase-orders` |
| 订单 orders | 无独立批量建档 | 有（**两套并存**） | — | registry entity `orders` **+** 另一套独立实现 `app/api/orders/export-csv/route.ts`（专供会计 summary/detail 口径，与 registry 版本并存不通） |
| 供应商账单 vendor-bills | 有 | 有 | 独立：`app/api/vendor-bills/import/route.ts`（走 import-parser） | 客户端模式（`useCsvExport`），**未接入 registry**，只能导出当前屏幕已加载的行 |
| 发票 invoices | 无 | 有 | — | 客户端模式，同上，未接入 registry |
| 贷项通知单 credit-notes | 无（系统从退货生成） | 有 | — | 客户端模式，同上，未接入 registry |
| 对账单 statements | 无（系统自动生成） | 有 | — | 统一：registry entity `statements` |
| 核销/付款 payments | 无 | 无 | — | — |
| 价格表 pricelists | **假按钮** | 无 | 页面 Import 按钮点击只弹 toast "Import coming soon"，未实现 | 无（`/api/pricelists/print` 是给客户看的报价单 PDF，非数据导出） |
| 单位 Uom | 无 | 无 | 只能在 settings 页面手动增删 | 无 |
| 产品类型（固定枚举） | 无 | 无 | 硬编码常量，只读展示 | 无 |
| 产品分类 ProductCategory | 无 | 无 | 只能手动增删 | 无 |
| 司机 drivers/DriverSlot | 无 | 无 | — | — |
| 波次/拣货 PickingWave | 无 | 无 | 只有 PDF 打印（pick-sheet 等），非数据导入导出 | 无 |
| 行程/提成 Trip/commission | 无 | 无 | 只有 PDF 打印 | 无 |
| 用户/角色 users/AppRole | 无 | 无 | — | — |
| 库存/批次 inventory/StockMove/Lot | 无 | 无 | 最近 FEFO 改动（commit 3cb82c1）未涉及 import/export | 无 |

### 结论

1. **导出层基本统一**（registry + useCsvExport），但有两个口子没收编：
   - `orders` 存在新旧两套导出并存（registry 版 + `export-csv` 会计专用版）。
   - invoices/vendor-bills/credit-notes 三个页面调用了统一 hook，但走的是"仅导出当前屏幕已加载行"的客户端模式，没注册进 registry，导出不了全量筛选结果——跟 statements/orders 的服务端全量导出能力不对等。
2. **导入层没有统一**，三套实现并行（通用壳 CsvImportDialog / 商品专属 ProductImportDialog / PDF解析 import-parser），彼此互不复用。
3. **价格表的"导入"是假功能**，点了只弹提示，需要明确这是待办还是已废弃的 UI 残留。
4. **9 个模块（单位/产品类型/产品分类/司机/波次/行程提成/用户权限/库存批次/付款核销）完全没有导入导出**，目前都是纯手工维护。

## 二、全站可抽离中间件清单

| 优先级 | 项目 | 重复位置 | 问题性质 | 建议 |
|---|---|---|---|---|
| **P0** | 审计日志写入 | `orders/route.ts:393`、`orders/[id]/route.ts:835`、`orders/bulk/route.ts`(6处)、`daily-sales/shortage/apply/route.ts`(3处)、`bulk-adjust/route.ts:291`、`order-discrepancies/[id]/route.ts:249`，共15+处手写 `orderAuditLog.create` | 真重复，字段形状一致 | 抽 `logOrderAudit(tx, {...})` helper |
| **P0** | 时区裸写 bug | `lib/analytics/loss-dashboard.ts:34,44`、`procurement-overview.ts:176`、`purchase-suggestions-annual.ts:114`、`api/purchase-suggestions/route.ts:97`、`analytics/overview/route.ts:26`、`analytics/customers/route.ts:84`、`analytics/snapshots/route.ts:41` 共7处仍用服务器本地时 `setHours(0,0,0,0)`，未接入 `lib/analytics/metrics.ts` 的 `businessDayStart`(Europe/Dublin) | **数据正确性 bug**，非风格问题，夏令时切换时"今天"算错1小时 | 改用 `businessDayStart/Range`，`products-query.ts` 已是正确范本 |
| **P1** | 分页逻辑 | `orders/route.ts:54-141`、`purchase-orders/route.ts:55-115`、`products/route.ts:15-62`、`customers/route.ts:16-135`、`invoices/route.ts:32-77`、`suppliers/route.ts:21-55`、`stock-takes/route.ts:32-37` 至少7处几乎逐字重复 page/pageSize→clamp→skip/take→count→totalPages | 真重复，可无损抽象 | 抽 `paginate(model, {page,pageSize,where,orderBy,legacyFlat})`，7处维护点→1处 |
| **P1** | bulk 字段校验 | `customers/bulk/route.ts:44-55` 与 `suppliers/bulk/route.ts:35-45` 的 slice 截断逐行相同（name/phone/email/address/zip/vatNumber/notes） | 真重复，与"互相照抄"问题同根 | 抽 `sanitizeContactFields()` |
| **P1** | CSV 解析实现分裂 | `lib/csv-export.ts:9` 的 `parseCsv` 支持引号/CRLF 是正规实现；`lib/import-parser.ts:189` 的私有 `parseCsv` 裸 split，**不认引号内逗号** | **真 bug**：采购单 CSV 若商品名含逗号会解析错位 | import-parser 改用 csv-export 的分词逻辑 |
| P2 | 三套导入收口 | CsvImportDialog / ProductImportDialog / import-parser | 业务差异较大（扁平建档 vs PDF/Excel订单行解析 vs 商品专属字段） | 不强行统一，收益有限，可延后 |

已核实**无需改动**的部分（结构良好，不是重复点）：
- 鉴权：`lib/auth.ts` 的 `withAuth`+`userHasPermission` 全覆盖，app/api 里 0 处手写角色绕过。
- PDF 生成：`lib/print/render-pdf.ts` 单一 Puppeteer 引擎，模板间已共享 `formatVatRate` 等工具。
- 缓存：`withCachedAuth` 已覆盖 27 个 analytics 路由；orders/products 等列表接口故意没接（写频繁+带用户维度，强行缓存有脏读风险，语义不同不该抽）。

## 三、如果要动手，建议顺序

1. 先修 P0 的两个——审计日志抽 helper、时区 bug 修掉7处（这是正确性问题，不是风格问题）。
2. P1 三项（分页/字段校验/CSV解析）收益明确、改动范围可控，适合打包成一次"小改"（3-5 文件以内走简化流程，超了按大改走 DEV-PLAN）。
3. 导入层统一（P2）和给单位/产品类型/产品分类/库存批次等模块补导入导出，属于新功能范畴，需要先确认业务上这几个模块是否真的需要批量导入导出（目前数据量小、变更频率低，手工维护可能本来就够用——这是值得先问一句的点，不是默认都要做）。
4. `orders` 导出两套并存、价格表导入假按钮，建议先决定："保留哪个/是否补全"，再排期。
