# 打印模板中英文切换 — 任务台账

背景：用户反馈拣货单(`trip-picking-template.ts`)全是硬编码中文，要求"检查全部打印模板，都要实现中英文切换"。
已确认两个决策：
1. 切换机制 = 跟随当前页面语言（`useLocale()`/URL locale，复用发票打印页 `invoices/[id]/print` 已有先例的思路），不做打印时手动选择。
2. 范围 = 一次性把全部模板都改完，不分批上线。

> ⚠️ 这份台账曾被多个并行 fork 同时改写过（各自只知道自己那个单元，互相覆盖过彼此的勾选），
> 20260908 由协调者统一核对所有 fork 回报内容后重写为准确状态。以后改这份文件前先看这行。

## 架构约定（所有单元共用）

- `lib/print/print-i18n.ts`：`PrintLang = 'zh' | 'en'` + `resolvePrintLang(v)`（非 'en' 一律按 'zh'）。
- 每个模板文件内部就近定义 `const T = { zh: {...}, en: {...} }` 字典，不做全局 next-intl messages 抽取。
- 英文优先的文件（`app/[locale]/classic/print/[id]/page.tsx`、`pricelist/page.tsx`、`day-wise-report-template.ts`）默认 `lang='en'`，保证不传参时行为不变；中文优先的文件默认 `lang='zh'`。
- 服务端 API route 从 `searchParams.get('lang')` 解析（`resolvePrintLang`），客户端组件从 `useLocale()` 算出。

## 单元清单（8 个模板 + 基础设施，全部已完成）

- [x] U0 `lib/print/print-i18n.ts` 新建；`trip-common.ts` 的 `timeSlotLabel`/`fullAddress`/`formatTripDriverList` 加 lang 参数
- [x] U1 `lib/print/trip-picking-template.ts`（拣货单）——`generateTripPickingHtml(data, variant, lang='zh')`
- [x] U2 `lib/print/trip-delivery-template.ts`（送货单）——`generateTripDeliveryHtml(data, lang='zh')`；本来就接近全英文，只有 3 处"中文/英文并列"拆成真正切换，其余英文字段原样进 zh 字典（避免臆造未曾存在的中文）
- [x] U3 `lib/print/trip-sales-template.ts`（销售单）——`generateTripSalesHtml(data, lang='zh')`
- [x] U4 `lib/print/trip-summary-template.ts`（送货汇总单）——`generateTripSummaryHtml(data, lang='zh')`，8 处中英并列拆成真正切换
- [x] U5 `lib/print/trip-receipt-template.ts`（客户签收单/POD）——`generateTripReceiptHtml(data, lang='zh')`
- [x] U6 `lib/print/day-wise-report-template.ts`（司机日报）——`buildOrderSummaryHtml/buildMultilineHtml/buildSummaryHtml/wrapHtml(..., lang='en')`（英文优先文件）
- [x] U7 `app/[locale]/classic/print/[id]/page.tsx` 的 `buildOrderHtml`——fork 最终被系统 kill(状态 killed，非 completed)，但读文件+`tsc`核实主文件改造已完整正确：`buildOrderHtml(order, customer, opts, lang='en')`，默认英文输出逐字保留
- [x] U8 `app/[locale]/classic/print/pricelist/page.tsx` 的 `buildPricelistHtml`——`buildPricelistHtml(pricelists, lang='en')`
- [x] U9 `lib/print/dispatch-print-html.ts`——`DISPATCH_PRINT_RENDERERS` 包一层统一 `(data, variant, lang)` 签名；`getDispatchPrintTitle(type, lang)` 取代旧的 `DISPATCH_PRINT_TITLES`(留了 deprecated 别名兼容)；`DispatchPrintParams` 加 `lang` 字段
- [x] U14 `lib/export/order-export-rows.ts`（day-wise-report-csv 实际用的是这个，不是 U6 那个模板）——`orderSummaryHeaders(lang)`/`orderDetailHeaders(lang)`/`buildOrderSummaryRows(orders, lang)` 取代旧的固定 zh 常量(留 deprecated 别名兼容)

## 还没做（接下来按顺序推进）

- [x] U10 API route 透传 `lang` query（全部 6 个已确认，其中 trips/[id] 两个是发现时已经改好，来源不明但读文件核实内容正确）：
      - [x] `app/api/print/dispatch-picking-pdf/route.ts`
      - [x] `app/api/print/day-wise-report-csv/route.ts`
      - [x] `app/api/print/day-wise-report-pdf/route.ts`（另外把路由自己拼的 meta/页脚摘要文案也做了字典化，不止是透传给模板）
      - [x] `app/api/print/dispatch-summary-pdf/route.ts`
      - [x] `app/api/trips/[id]/picking-pdf/route.ts`
      - [x] `app/api/trips/[id]/summary-pdf/route.ts`
- [x] U11 客户端调用点透传 `lang`（从 `useLocale()` 派生）——发现 `PrintCenter.tsx`/`_DispatchPrintClient.tsx`(协调者本人做的)/`_TripPrintClient.tsx` 已经全部接好了 `lang`，来源不明(疑似某个 fork 顺手做的，超出了它被分配的单文件范围)，逐个读文件+`tsc`核实内容正确：
      - [x] `SalesStats.tsx`
      - [x] `PrintCenter.tsx`（约 8 处调用，`lang: PrintLang = isEn ? 'en' : 'zh'` 已算好并透传）
      - [x] `app/[locale]/classic/print/dispatch/_DispatchPrintClient.tsx`（协调者本人改的，已切到 `getDispatchPrintTitle`）
      - [x] `app/[locale]/classic/print/trip/[id]/_TripPrintClient.tsx`
      - [x] `buildOrderHtml` 的其它调用点 `print/batch/page.tsx`、`operator/quotations/page.tsx`——都已接好 `lang`；quotations 页多补了一处遗漏的 `<html lang="en">` 硬编码，改成跟随 `isEn`
- [ ] U13 `app/[locale]/classic/print/day-wise-report/page.tsx`：**判定为死代码，不做**——全仓库 grep 找不到任何地方链接到 `/classic/print/day-wise-report` 这个路由，实际打印入口是 `SalesStats.tsx` 调的 `/api/print/day-wise-report-pdf`(已在 U10/U6 做完)，这个页面是被那条服务端 PDF 路径取代后留下的旧客户端实现，没有用户能点到，翻译它是无意义功。
- [x] U12 验证：全部通过
      - `npx tsc --noEmit`：0 错误（全项目）
      - `npm run build`：exit 0，无编译错误
      - 本地起 dev server(port 4123)，登录后实测 `dispatch-picking-pdf`(拣货单，用户截图那张) 和 `dispatch-summary-pdf`(送货汇总单) 各拉 zh/en 两版 PDF：
        - zh 版跟改造前逐字一致(拣货单跟用户截图完全对得上：配送日期/司机批次/客户数/装货顺序图例/整箱整袋STOCKABLE/零散货CONSUMABLE 等全部保留中文)
        - en 版对应位置全部正确切换成英文(Delivery Date/Driver/Batch/Customers/Load Order/Full Case-Bag (STOCKABLE)/Loose Goods (CONSUMABLE) 等)，商品名称/规格等实际业务数据不受影响(仍是数据库里存的原文，不该被"翻译")
      - `/tmp/dev-i18n.log` 检查无新增 error/warning(只有一条无关的 Sentry webpack 插件废弃警告)

## 收尾总结

8 个打印模板 + 2 个发现时已有隐患的关联文件(`order-export-rows.ts` CSV 表头、`dispatch-print-html.ts` 标题表)全部支持中英文切换，机制统一为跟随当前页面语言(`useLocale()`)。`day-wise-report/page.tsx` 经排查是无路由链接的死代码，未处理(判断依据见 U13)。过程中发现协调多个并行 fork 时，台账文件本身被多方并发写导致状态失真一次(已订正，见文件顶部备注)，教训：以后类似"多文件独立套用同一模式"的任务，台账更新应收口到协调者一人，不能让 fork 各自去改共享文件。

## 验收标准

- 切到英文页面打印出来的单据里，硬编码中文的位置全部变英文，不能中英混杂残留
- 默认语言的输出必须和改造前逐字一致（回归，不能顺手改措辞）——各文件"默认语言"以其改造前的主要语言为准（中文优先文件默认 zh，英文优先文件默认 en）
- 不改变任何排版/CSS/分页逻辑，只换文案来源
