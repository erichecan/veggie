# 赠品行在打印单据上的标识（20260918）

## 背景

`OrderLine.isGift`（20260913 上线）目前只活在三个订单编辑页的勾选框里：下单页、销售单详情页、
报价单详情页。打印链路**一处都没读它** —— 客户实测截图里 `Fresh Green Jujube 500g PKT` 是赠品，
发票上印出来是「€0.00 / 0% / €0.00」，跟一个「刚好免费」的普通商品完全无法区分。

客户拍板（20260918）：

1. **呈现形式**：有价格列的单据，价格列与金额列印 `GIFT` 代替 `€0.00`。
2. **覆盖范围**：全部有商品行的单据（含拣货单、日报等内部单据）。

没有价格列的单据（送货单、拣货单）退化为商品名后加 `GIFT` 徽标 —— 这是形式 1 在无价格列场景下
的等价物，由开发判断，不再回问。汇总类单据（送货汇总单按客户、日报 day 模式按订单、
日报 summary 模式按商品×星期）没有商品行粒度，不在范围内。

## 单元清单

| # | 单元 | 文件 | 验收标准 | 状态 |
|---|------|------|----------|------|
| 0 | 统一呈现 helper | `lib/print/gift-mark.ts`（新） | 导出 `giftMoneyCell()` / `giftBadgeHtml()`，纯函数无依赖 | [x] |
| 1 | 发票/销售单 PDF | `lib/order-pdf.ts` | PRICE 与 INCL VAT 两列印 GIFT；PDF 下载与邮件附件同一份模板自动同步 | [x] |
| 2 | 单据打印页（销售单/送货单） | `app/[locale]/classic/print/[id]/page.tsx` | 有价格列印 GIFT；`docType=delivery`（hidePrice）走徽标 | [x] |
| 3 | Trip 行类型 | `lib/print/trip-common.ts` | `TripLine.isGift?: boolean` | [x] |
| 4 | 两条 loader | `lib/print/trip-loader.ts`、`lib/print/dispatch-loader.ts` | 都把 `l.isGift` 映射进 TripLine（两份独立代码，漏一条就静默丢字段） | [x] |
| 5 | 销售单模板 | `lib/print/trip-sales-template.ts` | PRICE / INCL VAT 印 GIFT | [x] |
| 6 | 送货单模板 | `lib/print/trip-delivery-template.ts` | 无价格列 → 商品名后 GIFT 徽标 | [x] |
| 7 | 客户签收单 | `lib/print/trip-receipt-template.ts` | 金额列印 GIFT | [x] |
| 8 | 拣货单 | `lib/print/trip-picking-template.ts` | 聚合出 giftQty：全赠品印 GIFT，部分赠品印 GIFT ×N；客户明细行同规则 | [x] |
| 9 | 日报商品明细 | `lib/print/day-wise-report-template.ts` + loader、`app/[locale]/classic/print/day-wise-report/page.tsx` | multiline 与 day 模式单价/金额印 GIFT。⚠️ 日报有**两份独立实现**：lib 版给 PDF API，页面版是纯客户端自己拼行，只改一份会漏；summary（商品×星期）与 order-summary（订单级）没有商品行金额粒度，不动 | [x] |
| 10 | 发票模块 | `lib/invoice-from-order.ts`、`app/[locale]/classic/operator/invoices/[id]/print/page.tsx`、详情页 | 快照行带 isGift；打印页金额列印 GIFT。历史发票无此字段 → 按非赠品渲染，不臆造 | [x] |
| 11 | 验证 | — | `npx tsc --noEmit` 通过；本地起 dev，造一张含赠品行的订单，逐张单据实际渲染核对 | [x] |
| 12 | 发票详情页（屏幕，20260918 追加） | `components/shared/gift-amount.tsx`（新）、`operator/invoices/[id]/page.tsx`、`.../[id]/print/page.tsx` | 屏幕与打印同口径印 GIFT；两个发票页共用 `<GiftAmount>`，不再各写一份 | [x] |
| 13 | CSV 导出（20260918 追加） | `lib/export/order-export-rows.ts`、`app/api/print/day-wise-report-csv/route.ts` | 订单产品明细、日销售中心产品明细两份 CSV 各加一列「赠品/Gift」（是 / Y），金额列保持数值 | [x] |

## 已知边界

- **历史发票**：`Invoice.lines` 是 JSON 快照，20260918 之前开的发票里没有 `isGift`，一律按非赠品
  渲染。不拿 `unitPrice === 0` 反推赠品 —— 生产库里价格为 0 的行还有别的成因（漏价、样品、
  Odoo 导入脏数据），反推会把它们全误标成赠品。
- **拣货单聚合**：同一商品在同一趟车里可能一部分订单是赠品、一部分不是，主行总量混着算。
  所以主行印的是 `GIFT ×N`（N = 赠品数量），不是简单的「是/否」。
- **汇总口径不变**：赠品不计销售额/毛利/提成这条规则由 `lib/commission.ts`、
  `lib/analytics/metrics.ts` 管，本次只动打印呈现，不碰任何金额计算。

## 完成记录（20260918）

12 个文件改完，`npx tsc --noEmit` 通过，新增 `tests/print-gift-mark.test.ts`（8 条，全绿）。

浏览器实测（本地 dev server :3100，Neon 开发库）逐张核对，都印出了 GIFT：
销售单打印页、送货单打印页、发票/销售单 PDF（`/api/orders/[id]/pdf`）、调度拣货单、
调度销售单、调度送货单、日报商品明细（multiline）、发票打印页。

全量 `npm test`：925 条 / 916 过 / 7 败。7 条失败与本次改动无关 —— 在 HEAD（`15c64b8`，
不含本次改动）的只读 worktree 上重跑同样的 7 条，失败一模一样：analytics-pivot 维度定义、
role-reachability 与 rbac 可达性基线（有 4 个新 analytics handler 没同步进快照）、
pricelist 那条依赖库内数据。

### 验证期间动过的本地开发库数据

- `OP-260720-001`（Golden Kitchen）的 `Red Unicorn Long Grain Rice 20kg BAG` 行、
  `OP-260710-005`（Old Garden）的 `Tongkwa KG` 行 → 标成赠品（`isGift=true`，单价/小计归零）。
  **保留着**，方便随时在页面上复看效果；要还原就把这两行的 `isGift` 改回 false 并填回单价。
- 为验发票打印页建过一张 DRAFT 发票 `INV-00001`，验完已删；配套临时改的 `deliveredQty` 已改回 0。

## 追加（同日，客户要求把这两处也补上）

### 发票详情页

屏幕页与打印页同口径印 GIFT。两个发票页原本各写一份 JSX 小函数，抽成
`components/shared/gift-amount.tsx` 的 `<GiftAmount>` 共用 —— 同一张发票在屏幕上和
打印出来长得不一样，是最容易被当成"数据错了"的那类问题。

### CSV 导出

⛔ **不是把金额写成 "GIFT"，而是新增一列「赠品」/「Gift」**（值 `是` / `Y`，普通行留空），
金额列原样保留 `0.00`。打印单据给人看，CSV 给 Excel 算 —— 金额列一旦混进文字，
整列在 Excel 里变成文本，会计的求和公式当场失效。这是与打印形式唯一的口径差异，
理由写在 `giftFlag()` 的注释里。

两份行级 CSV 都改了（订单级/发票级导出没有商品行，不涉及）：

| 入口 | 端点 | 实测 |
|---|---|---|
| 订单列表「导出产品明细」 | `/api/orders/export-csv?kind=detail` | `OP-260720-001 … Red Unicorn Long Grain Rice 20kg BAG,是,1,0.00,0.00,0.00` |
| 日销售中心「导出产品明细」 | `/api/print/day-wise-report-csv?kind=detail` | zh 印「是」、`lang=en` 印 `Y`，均已实测 |

测试补到 `tests/print-gift-mark.test.ts`（11 条全绿），其中一条专门锁住
「金额列必须还是数值字符串」。全量 `npm test` 928 / 919 过 / 7 败，失败仍是那 7 条既有的。
