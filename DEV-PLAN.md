# DEV-PLAN — 采购模块「询价单」新建采购单页整合

> 更新日期：2026-07-10
> 范围：仅「询价单」tab → 点「新建」进入的新建采购单页（`app/[locale]/classic/operator/purchases/new/page.tsx`），以及为支撑它而需要改动的「总览」tab
> 读取依据：无独立 PRD 文档；本轮通过对话逐项五问澄清确认（见下方"已确认决策"），未读取额外产品文档
> 前序状态：`purchases/new/page.tsx`、`app/api/products/quick-create/route.ts` 已在此前会话中新建（解决"采购商品要不要和销售商品分开"——结论是不分开，用 `canBeSold:false/canBePurchased:true` 在同一 Product 表内打标，走"当场建货"quick-create 流程，本轮不再变动）

---

## 1. 六个子需求 & 已确认决策

| # | 需求 | 关键决策（已用 AskUserQuestion 逐条确认） |
|---|------|------|
| 1 | PDF 上传→识别→非英文自动翻译成英文→自动填单；创建页可左右分屏查看 PDF | PDF 以**系统生成的文字版**为主设计假设；识别+翻译**必须调用外部 AI**（项目当前无 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`），**用户已确认现在配置接入**，费用按次产生 |
| 2 | 运费录入 + 摊入产品成本 | **按金额比例摊**：`该行摊入运费 = 运费 × (行 subtotal / 整单 subtotal)`；只影响本单"落地成本"展示/毛利参考，**不回写 `Product.standardPrice`**（避免和其他采购单/销售侧成本打架，参见历史 SSOT 教训） |
| 3 | 汇率——抓当日实时汇率 | **不限定币种**，任意 ISO 代码 + 当日汇率，接免费无需 Key 的 FX API（Frankfurter/ECB），按天缓存快照，避免历史单据汇率被事后变动污染 |
| 4 | 商品价格——抓最近一次交易价 + 弹窗看最近 10 次走势 | **按（商品+供应商）区分**——同一款菜不同供应商价格分开看，选完供应商价格才回填/画图 |
| 5 | 总览页统计：本月采购支出（已有）、供应商未付款、Top10 供应商+品类；**去掉**顶部"需要立即处理/已逾期未处理/等待你审批"三张卡片 | Top10 按**采购金额，近 12 个月滚动**；未付款按**全部未结清 `VendorBill.amountDue` 汇总**（不区分是否逾期） |
| 6 | 总览中间：库存/销量趋势→采购预测 | **复用现有建议引擎**（`lib/purchase-suggestions-fresh.ts` 的"近3日日均出货+在途-库存-安全库存"算法），换成中间卡片形式：建议关注的补货商品列表 + 每个商品近14天出库量迷你趋势图，点击跳转新建采购单；不新增预测算法 |

---

## 2. 数据库 schema 变更

```prisma
model PurchaseOrder {
  // ...existing fields...
  freightAmount      Decimal? @default(0) @db.Decimal(14, 2)  // 本单运费，人工录入
  exchangeRate       Decimal? @default(1) @db.Decimal(14, 6)  // currency → EUR 的当日汇率快照，下单时锁定
  sourceDocumentUrl  String?   // 识别用的供应商 PDF，存 GCS，创建页侧栏查看
  sourceDocumentName String?
}
```

- **不新增** `PurchaseOrderAttachment` 表——一期一单一 PDF 够用，多附件需求出现再拆表（YAGNI）。
- **不新增**任何"供应商未付款汇总"字段——总览页未付款/Top10 全部走**实时聚合查询**（对 `VendorBill`/`PurchaseOrder` group by），不落库快照，避免又制造一处需要人工同步的 SSOT 分裂。
- **不新增** `PurchaseOrderLine.landedUnitCost` 持久字段——落地成本在读取时用 `lib/purchase-landed-cost.ts` 现算，运费/汇率改了自动跟着变，不需要额外一次"重新摊销"的写操作。
- `PurchaseRecord`（已有 `productId/unitCost/supplierId/arrivedAt`）直接作为"最近价格"数据源，不改动。

一条 migration：`add_purchase_order_freight_fx_source_doc`。

---

## 3. 新增/改动的 API

| 路由 | 说明 |
|------|------|
| `POST /api/purchase-orders/pdf-extract`（新增） | 接收 PDF → 存 GCS（复用 `upload-image` 的 Storage 客户端模式，bucket 内换 `purchase-docs/` 前缀）→ `pdf-parse` 抽取文字层 → 调用 Anthropic API 做结构化抽取 + 非英文→英文翻译 → 返回 `{ supplierGuess, lines[], sourceDocumentUrl }` 供前端预填表单（**不自动提交**，人工核对后才保存） |
| `GET /api/fx-rate?base=EUR&date=YYYY-MM-DD`（新增） | 代理 Frankfurter/ECB 免费汇率接口，按天缓存（进程内内存缓存 + 兜底：接口不可用时返回 `null`，前端允许手动填汇率，不阻塞下单） |
| `GET /api/products/[id]/price-history?supplierId=`（新增） | 查 `PurchaseRecord` 最近 10 条（同 productId + supplierId），返回 `{ date, unitCost }[]` 给走势弹窗 |
| `GET /api/analytics/procurement-overview`（改） | 新增 `topSuppliers`（近12月采购额 Top10 + 品类分布）、`supplierUnpaidTotal`（全部未结清 `VendorBill.amountDue` 按供应商汇总）；**移除** `criticalCount`/`overdueCount`/`toApproveCount` 三个字段的 KPI 卡片输出（生成建议列表的底层逻辑不动，只是不再喂给顶部卡片） |
| 复用 `lib/purchase-suggestions-fresh.ts` 输出 | 总览中间"建议关注补货商品"卡片直接读现有 `PurchaseSuggestion` 表（`status=pending`，按 `priority` 排序取前几条），不新建生成逻辑 |
| `POST /api/purchase-orders`、`lib/create-purchase-order.ts`（改） | 接收 `freightAmount`、`exchangeRate`、`sourceDocumentUrl` 并落库；`lib/purchase-landed-cost.ts`（新文件）导出 `computeLandedUnitCost(line, po)` 供页面和后续报表统一调用 |

---

## 4. 页面改动

**`purchases/new/page.tsx`**
- 顶部加「上传 PDF 识别」按钮：上传后调 `pdf-extract`，展示识别结果供确认，确认后预填供应商/行项目；同时开启右侧栏 PDF 预览（左表单/右 PDF，类似侧边栏抽屉，可收起）
- 表单加：运费输入框（税前金额）、币种保持现有下拉但联动 `GET /api/fx-rate` 自动回填汇率（可手动覆盖）
- 每个商品行加"查看价格历史"按钮 → 弹窗：最近一次成交价自动回填单价参考 + 最近 10 次价格走势迷你图（按当前选中供应商过滤）
- 总计区加"落地成本"小计（`subtotal + 摊入运费`），供下单前核对毛利

**`purchases/overview/page.tsx`**
- 移除三张顶部提醒卡片
- 新增 Top10 供应商表格（金额+品类分布）
- 中间新增"建议关注的补货商品"卡片（迷你趋势图+一键跳转新建）
- 供应商未付款作为一张统计卡片保留在顶部区域

---

## 5. 大改评估（按项目 CLAUDE.md 第十三节）

- **架构**：PDF 识别是唯一引入外部依赖（AI API）的部分，做成独立 API 路由 + 独立 `lib/pdf-extract.ts`，前端拿到结构化结果后仍要走人工确认才保存，不会因识别出错直接污染数据库；汇率/价格历史/预测三块都是纯读取现有数据，无新的单点故障。
- **质量**：运费摊销、汇率取值统一收敛到 `lib/purchase-landed-cost.ts` 和 `GET /api/fx-rate`，避免在多处重复计算逻辑；不新增未付款/Top10 的落库快照，直接复用已有 `VendorBill`/`PurchaseRecord`/`PurchaseSuggestion`，避免重复造一套新的统计口径。
- **性能**：Top10 供应商/未付款走 group by 聚合查询，需确认 `VendorBill` 数据量级决定是否加索引（`vendorId` 上应有索引，若无则本轮一并加）；FX 汇率按天缓存避免每次下单都打外部 API。

---

## 6. 风险点

1. **AI 调用费用不可控**——已获用户确认接入，但需要在 `pdf-extract` 路由加基本速率限制（复用现有 `lib/rate-limit.ts` 模式），防止误操作/重复上传导致费用累积。
2. **pdf-parse 对复杂表格排版 PDF 抽取可能错位**——识别结果是"预填草稿"，不允许跳过人工核对直接保存，表单必须让用户逐行确认修改。
3. **免费 FX API 可用性无 SLA**——接口失败时不能阻塞下单，允许手动填汇率并给出"未取到实时汇率"提示。
4. **`VendorBill.amountDue` 聚合口径**需要与财务模块现有"应付账款"报表口径核对，避免总览页和财务页数字对不上（历史教训：list-facet-search-20260707、sales-accounting-tax-convention-20260701 都出现过口径不一致的问题，本轮上线前需交叉核对一次数字）。

---

## 需要你确认后开始开发

1. **AI Key**：请把可用的 `ANTHROPIC_API_KEY`（或 `OPENAI_API_KEY`）加到 `.env.local`，不需要发给我明文——我读环境变量即可。本地没有配置的话，PDF 识别/翻译这部分我会先把其余 5 项做完，等 Key 到位再接这一块。
2. 以上范围、schema 变更、six 模块的划分是否确认？确认后我按 §2→§4 顺序开始开发，中途不再逐项确认。
