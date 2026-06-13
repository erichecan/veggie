# 04 · 功能模块与报表系统

> 按 `app/api/*` 与 `app/[locale]/classic/*` 罗列功能模块，并详述透视报表引擎与 BOSS 报表页。

---

## 1. 功能模块（按域）

### 销售
- **orders**（`api/orders` + `operator/orders`）：订单全生命周期；支持 bulk、状态过滤、include_lines、按客户/编号搜索；幂等（Idempotency-Key）。
- **quotations / place-order**：报价单与代客下单 UI。
- **invoices**（`api/invoices` + `operator/invoices`）：开票、过账（`[id]/post`）。
- **credit-notes**（`api/credit-notes` + `operator/credit-notes`）：退货贷记单，`generate-from-returns`。
- **order-discrepancies**：拣货差异（缺货/替代/称重差）。

### 采购
- **purchase-orders**（+ `operator/purchases`）：PO 生命周期，`import`、`[id]` 动作机。
- **purchase-suggestions**：补货建议（算法生成）。
- **vendor-bills**：供应商账单。
- **purchases / goods-receipts**：收货入库。
- **suppliers**：供应商主数据（isVendor 客户）。

### 库存
- **products / product-templates / product-categories**：商品目录。
- **stock-moves**：手动出入库/调整。
- **lots**（+ `lots/expiring`）：批次效期。
- **scrap**：报废。
- **batch-analysis**：批次质量/效期分析。
- **inventory**（operator）：库存总览/盘点。

### 物流
- **waves**（+ `waves/generate-daily`、`[id]/assign`）：拣货波次。
- **trips**（+ `[id]`、`dispatch-print-data`）：司机行程。
- **driver-slots**：配送批次。

### 财务
- **finance/historical-debt**：历史欠款。
- **statements**：客户对账单。
- **payments**：收款流水。
- **accounts**：会计科目。
- accounting/finance 页：核销、交账、总览。

### 主数据/系统
- **customers**（+ bulk）、**pricelists**（+ print）、**uoms / uom-categories**、**users**。
- **auth**（login/change-password）、**mfa**、**action-logs**、**notifications**、**gdpr**（export/delete）、**health**、**demo/reset**。
- **geocode / distance-matrix / tile**：地图与配送距离。
- **upload-image**：图片上传。
- **customer-portal**（products/orders）：C 端 API。

---

## 2. 透视报表引擎

**文件**：`lib/reports/definitions.ts`（注册表）、`lib/reports/sql-builder.ts`（SQL 生成）、`app/api/reports/[type]/route.ts`（接口 + RBAC）。

### 角色访问（ROLE_REPORT_ACCESS）
```
OPERATOR / BOSS / FINANCE → sales, purchasing, logistics（全部）
SALES   → sales（自动按 salesman 过滤）
DRIVER  → logistics（自动按 driver_name 过滤）
```

### SQL 生成器（sql-builder.ts）
- SELECT：维度（日期维度可 DATE_TRUNC：day/week/month/quarter/year）+ 度量（带聚合函数）。
- WHERE：支持 `= != > < >= <= like in not_in between`（参数化 $1,$2…）。
- GROUP BY 全维度；ORDER BY 默认首维度；LIMIT 上限 10000；额外跑 countSql（去重组数）与 totalsSql（总计）。
- 序列化：BigInt→Number，Date→ISO。

### 三大报表

| 报表 | 视图 | 主要维度 | 主要度量 |
|---|---|---|---|
| **sales** | `veggie_sales_report` | 客户(name/city/country/payment_term)、商品/分类、salesman/created_by、司机/time_of_day、order_status、payment_method、uom、5 种日期 | line_subtotal、line_total_inc_tax、tax_amount、ordered/delivered/invoiced_qty、qty_to_deliver/invoice、total_weight/volume、commission_amount、unit_price(AVG)、line_count |
| **purchasing** | `veggie_purchasing_report` | 供应商(name/city)、商品/分类、po_status、order/expected/confirmed 日期 | subtotal_ex_tax/inc_tax、tax_amount、ordered/received/invoiced_qty、qty_to_receive、unit_cost(AVG)、line_count |
| **logistics** | `veggie_logistics_report` | driver_name、time_slot、trip_status、settlement_status、wave_id、created/settled 日期 | total_payment、driver_commission、cash/online_collected、total_collected、restaurant_count、trip_count |

> ⚠️ sales 报表**无毛利/成本**度量（见 03 §8）。

---

## 3. BOSS 报表页（实际为 4 个，非预想的 19 个）

`boss/layout.tsx`（行 17-23）导航 5 项，对应页面：

| 页面 | 路径 | 展示 | 数据源 |
|---|---|---|---|
| **经营总览** | `boss/page.tsx` | KPI 卡 + 趋势/排名/状态饼图 | `/api/orders`、`/api/purchase-orders`、`/api/customers`(含 isVendor)、`/api/finance/historical-debt`；组件 DashboardKpis/Charts/Rankings |
| **销售分析** | `boss/sales-analysis/page.tsx` | 饼/柱/列表，交互图例 | `/api/orders?include_lines=false` + items 聚合；维度 业务员/商品/客户；度量 数量/金额/未税/单价/佣金等；时间过滤 全部/今日/本周/本月 |
| **采购分析** | `boss/purchase-analysis/page.tsx` | 饼/柱/列表 | `/api/purchase-orders?limit=500` + lines 聚合；维度 供应商/商品/PO 状态；KPI：PO 数/未税总额/收货数/供应商数 |
| **销售报表** | `boss/sales-report/page.tsx` | 可筛选/排序表 + 打印 + CSV 导出 | `/api/orders` + items；筛选 日期/业务员/报价/商品类型/客户/商品；打印 销售汇总/明细行/订单级；CSV 列：日期/单号/客户/业务员/状态/产品/数量/单价/小计 |
| 财务总览(链接) | → `/classic/finance` | — | boss 导航跳财务模块 |

> 「19 个专项报表页」是早期规划假设，**代码未证实**。BOSS 下实际 4 个分析页；更多明细分析（销售/采购/物流透视）在 `operator/reports` 走透视引擎。如需更多专项报表，属未来工作。

---

## 4. 打印与导出

`print/` 下 9 个模板：通用 `[id]`、day-wise-report、dispatch/{delivery,picking,summary}、pricelist、trip/[id]/{picking,delivery,summary}。
导出：pricelists/print、销售报表 CSV（`downloadCsv`）、`orders/dispatch-print-data`、`xlsx` 库支持 Excel。
打印模板加载器在 `lib/print/*`。

---

## 关联文档
[00 概览](00-overview.md) · [01 数据模型](01-data-model.md) · [02 角色与工作流](02-roles-and-workflows.md) · [03 业务规则](03-business-rules.md) · [05 数据来源与种子现状](05-data-sources-and-seed-state.md)
