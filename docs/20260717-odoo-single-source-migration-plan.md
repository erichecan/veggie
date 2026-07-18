# Odoo 迁移改造计划：单一数据源 + 发票补录 + Odoo 优化自查

> 状态：**草案，待确认**。本文档只做调查与规划，未执行任何删除/schema 变更。

## 一、核心发现（推翻了任务开始时的前提）

用户原始指令是"这次迁移只能从 `odoodata/odoo12 (1).sql`（4.25GB 全库 SQL 备份）读取数据，删除全部 CSV 文件"。
逐一核查全部迁移脚本后，发现真实情况比这更好，需要先澄清：

1. **本次（20260717）全量迁移的 8 个脚本，无一读取 `odoodata/*.csv`**。
   逐个 grep 确认，全部读取的是 `scripts/odoo-migration/exports/*.csv`：

   | 脚本 | 读取的 exports 文件 |
   |---|---|
   | import-odoo-categories-20260717.ts | product_category.csv |
   | import-odoo-customers-20260717.ts | res_partner.csv |
   | import-odoo-missing-customers-for-orders-20260717.ts | res_partner_missing_for_orders(2).csv |
   | import-odoo-products-full-20260717.ts | product_product.csv |
   | import-odoo-pricelists-full-20260717.ts | pricelist_items.csv / pricelist_customer_counts.csv / product_product.csv |
   | import-odoo-orders-full-20260717.ts | sale_order.csv / sale_order_line.csv |
   | backfill-odoo-orderlines-20260717.ts | sale_order_line.csv |
   | backfill-odoo-stock-20260717.ts | odoo_internal_stock.csv |

   （另外 3 个更早的脚本——`import-odoo-vendors-20260714.ts` 读 `/Users/eric/Downloads/res.partner (1).csv`、
   `import-test-orders-odoo-20260714.ts`、`sync-odoo-products-20260715.ts` 读 `pic/product.product.csv`——是 07-17
   正式管线搭好之前的一次性历史脚本，已执行完毕，不在本次整改范围内。）

2. **`scripts/odoo-migration/exports/*.csv` 本身不是手工导出，而是从一个真正的本地 Postgres 库里查出来的**。
   `scripts/odoo-migration/` 是一套完整的"路 A：pg_dump 完整迁移"工具包（`00-assess.sh` → `01-dump-server.sh` →
   `02-transfer-local.sh` → `03-restore-local.sh`），流程是：SSH 上生产 Odoo 服务器 `pg_dump -Fc` → 传回本机 →
   `pg_restore` 到本地一个专门的分析库。这个库现在还在（`scripts/odoo-migration/pgdata/`，PG17 数据目录），
   我已用 `pg_ctl` 重新拉起、通过 unix socket 连接确认：**库名 `odoo_restore`，Postgres 正常运行中**。

3. **`odoo_restore` 比 `odoodata/odoo12 (1).sql` 更新、更完整，且已验证与生产库完全对得上**：

   | 对比项 | odoo_restore（本地已恢复库） | odoodata/odoo12 (1).sql（4.25GB 纯文本） |
   |---|---|---|
   | sale_order 最新 write_date | 2026-07-13 | 样本记录最新到 2026-06-23 |
   | sale_order 行数 | 149,868（与生产库 Order 表 149,868 条一致） | 未逐一核对，但明显更旧 |
   | account_invoice（发票） | **有，153,260 条** | 有（但整体更旧） |
   | 是否被现有脚本引用 | 是（07-17 全量迁移的唯一数据来源） | **否，从未被任何脚本引用** |
   | 取数方式 | 直接 SQL 查询，无需二次解析 | 需要写正则解析 4.25GB 纯文本 COPY 块，脆弱且慢 |

   抽样验证：截图订单 **D152099**（Arirang Asia Market Limited）在 `odoo_restore.account_invoice` 里能精确查到
   `number=V57071, origin=D152099, state=open, amount_total=704.33`，与订单金额、客户完全吻合。

### 结论与建议

**不建议按原指令重新灌入 `odoo12 (1).sql`**——它更旧、从未被使用、且需要额外花时间/磁盘重新恢复一个 4.25GB
的库；`odoo_restore` 才是 07-17 全量迁移实际使用、且仍在本机可查询的单一数据源，功能上完全等价甚至更优。

如果坚持要"物理上只保留一个源文件"这个治理目标（而不是"必须是 odoo12(1).sql 这个具体文件"），建议改成：
用 `pg_dump` 把 `odoo_restore` 重新导出成一份新的、干净的、经过验证的全量备份文件，替代 `odoo12 (1).sql` 存档，
之后所有取数都只认这一份文件/这一个库。**这一步需要您确认是否采用**，因为它决定后续清理动作的范围。

---

## 二、迁移脚本审计结论

本次审计的两个问题：

**Q1：现有脚本是否依赖了该删除的 CSV？** 否，07-17 系列脚本全部只依赖 `scripts/odoo-migration/exports/*.csv`
（源自 odoo_restore），不依赖 `odoodata/*.csv`，本身已经符合"单一数据源"的治理目标，不需要重写。

**Q2：`odoodata/` 目录下的原始文件何去何从？**

| 文件 | 现状 | 建议 |
|---|---|---|
| `product.pricelist (2).csv` / `product.product*.csv` / `res.partner (1).csv` / `sale.order (1~5).csv` | 06-20/21 手工从 Odoo UI 导出，早已被 07-17 的 pg_dump 管线取代，**当前无任何脚本引用** | 删除（已确认安全） |
| `odoo12 (1).sql`（4.25GB） | 独立的另一份全库快照，同样**当前无任何脚本引用**，且比 odoo_restore 更旧 | 建议删除或搬出项目目录；**这是您手工获取的原始数据备份，执行前需您明确确认** |
| `backup-20260620/*.json` | 经核实是**本系统自己**在 06-20 迁移前的数据快照（含 `EVT-SO-`/`EVT-INV-` 前缀的种子数据，不是 Odoo 数据），用于误操作回滚兜底 | 保留，与本次 Odoo 数据源整改无关 |

---

## 三、新增导入计划：发票（本次真正要做的事）

Odoo 里的真实发票模型是 `account_invoice`（Odoo 12，`account_move` 只是会计凭证，不含发票号），
在 `odoo_restore` 里已确认存在且完整：

| 表 | 行数 | 用途 |
|---|---|---|
| `account_invoice` | 153,260 | 发票/贷记单主表 |
| `account_invoice_line` | 1,325,775 | 发票行明细（含每行自己的 `origin`，可精确归属到具体订单） |

**字段观察**：
- `type`：`out_invoice`(148,493，客户发票) / `out_refund`(4,749，贷记单/退款) / `in_invoice`+`in_refund`(18，供应商发票，超出本次范围)
- `state`：`paid`(115,323) / `open`(34,263，已过账未收款) / `cancel`(3,591) / `draft`(83，未定稿，通常无正式发票号)
- `origin`：绝大多数是单个订单号（如 `D152099`），但**存在一对多合并开票**的情况（如 `D002151, D002131`），
  需要按逗号拆分后关联多个 `Order.externalRef`
- `number`：真正的发票号（如 `V57071`、`INV/2022/0191`），153,145 条有 `origin`，149,586 条有 `number`

**导入方案**：

1. 从 `odoo_restore` 按 `type IN ('out_invoice','out_refund')` 导出 `account_invoice` + `account_invoice_line`
   到 `scripts/odoo-migration/exports/account_invoice.csv` / `account_invoice_line.csv`（跳过 `in_invoice`/`in_refund`，
   那是供应商发票，不在销售发票范围内）。
2. 新脚本 `import-odoo-invoices-20260718.ts`：
   - `type=out_invoice` → 写入 `Invoice` 表；`type=out_refund` → 写入 `CreditNote` 表（schema 里已有专门模型，
     两者都天然带 `@unique(name)`，可直接按发票号/贷记单号幂等 upsert）
   - `origin` 按逗号拆分，关联 `Order.externalRef` 填充 `Invoice.saleOrderIds`
   - `account_invoice_line` 按 `origin` 分组算出每个订单在这张合并发票里的金额，拼成 `Invoice.lines` 的 Json
   - `state` 映射：`draft→DRAFT`、`open→POSTED`、`paid→PAID`、`cancel→CANCELLED`
   - 金额映射：`amount_untaxed→subtotalExTax`、`amount_tax→totalTax`、`amount_total→totalIncTax`、
     `amount_total - residual→amountPaid`、`residual→amountDue`
   - `date_invoice→postedAt`、`date_due→dueDate`
   - 跳过 `number` 为空的记录（草稿态未定稿，没有真正发票号）
3. 幂等：按 `Invoice.name`/`CreditNote.name` 判重（已有 `@@unique`），可安全断点续跑，与 07-17 其余脚本手法一致。

---

## 四、补齐 externalId/externalRef 唯一约束

现状核查（读 `prisma/schema.prisma` + 生产库查询）：

| model | 字段 | DB 唯一约束 |
|---|---|---|
| ProductCategory | externalId | 已有 `@unique` |
| ProductTemplate | externalId | 已有 `@unique` |
| Product | externalId | 已有 `@unique` |
| Customer | externalId | 已有 `@unique` |
| OdooPricelist | externalId | 已有 `@unique` |
| **Order** | **externalRef** | **无**（唯一漏网的一处） |

生产库实测（149,868 条订单，149,820 条有 `externalRef`）：只有 **1 组**重复值——
`externalRef = 'seed-shortage-demo'`，18 条，是演示/种子数据用的占位字符串，不是真实 Odoo 引用。

**修复步骤**：
1. 把这 18 条 `seed-shortage-demo` 订单的 `externalRef` 置空（它们本来就不该被当成"从 Odoo 导入"的订单）
2. `schema.prisma` 给 `Order.externalRef` 加 `@unique`
3. 生成迁移、`prisma migrate deploy`

---

## 五、Odoo 十几年经验五条优化——落地自查结果

### 1. 外部 ID 幂等导入 —— **基本达标，一处漏网**
见第四节。其余 5 个模型的 externalId 都已有 `@unique`；`Invoice.name`/`CreditNote.name` 这类"发票号即幂等键"
的设计也已经到位。只差 `Order.externalRef` 一处，方案见上。

### 2. 每个外键自动建索引 —— **核心链路已覆盖，5 处非核心字段有缺口**
（已用独立 agent 通读全部 46 个 model 核对）

结论：所有通过 Prisma `@relation` 正式声明的外键（39 处，含 `OrderLine.orderId/productId`、`Order.driverSlotId`
等高频大表字段）**全部已有索引**，最左字段覆盖良好。

项目大量使用"软引用"（`xxxId` 字段但不声明 `@relation`，属于团队有意选择），这类字段里找到 5 处确实完全没索引：

| model | 字段 | 优先级 |
|---|---|---|
| OrderLine | uomId | 低（很少作查询条件） |
| OrderDiscrepancy | productId | 中（若做"按商品统计差异"报表会全表扫描） |
| OrderDiscrepancy | substituteProductId | 低~中 |
| PurchaseOrderLine | uomId | 低 |
| Order | printedById | 低 |

Prisma 本身不像 Odoo ORM 那样自动挂索引，目前的高覆盖率是团队手动补出来的，机制上没有"自动兜底"，
但实质缺口很小且都不在主链路上。建议按优先级顺路补上，不需要单独立项。

### 3. 该存的计算字段就存下来 —— **只有一个实例，没有推广**
`DailyBusinessSnapshot`（`lib/analytics/snapshot.ts` 的 `computeDayMetrics`）是全项目唯一的"物化报表"模式，
被 `overview` 接口读取昨日快照复用。除此之外，月度/年度汇总（如年度采购计划）、司机提成汇总等**全部是实时查询**，
没有落表缓存。数据量/访问频率还没到非物化不可的地步，但如果以后司机结算月报、年度经营汇总变大，
目前没有现成的"快照"基础设施可以直接复用，需要单独设计。**建议**：暂不强推，等真正出现慢查询再照
`DailyBusinessSnapshot` 的模式扩展。

### 4. 报表脱离 ORM 直查 SQL —— **数据分析中心已达标，中心之外有 6 处反模式**
`/api/analytics/*` 下 13 个路由里 12 个已经是 `$queryRawUnsafe` + `resolveDateRange` 限流（`ANALYTICS_MAX_RANGE_DAYS=400`
防全表扫描），做得很规范。发现的问题集中在"分析中心之外"：

| 位置 | 问题 | 严重度 |
|---|---|---|
| `app/api/analytics/ar-aging/route.ts:26-87` | 唯一一处在 analytics 目录内仍是纯 ORM：`Invoice.findMany` **无日期范围**拉全部未清欠款发票，JS 算账龄桶 | **高**——随发票总量线性增长，没有上限保护，风格和其余 13 个路由不一致 |
| `lib/analytics/zone-inventory.ts:36-121` | 每个温区各拉一次全量 ACTIVE 商品，JS reduce 求库存值/比对温区 | 中，SKU ~1700+ 暂不大 |
| `lib/analytics/inventory-overview.ts:48-70` | `getInventoryOverviewKPIs` 全量商品 JS reduce，但**同文件里** `getInventoryByCategoryGroup` 已经用 SQL `SUM…GROUP BY` 做了同样的事——团队知道怎么写好，这一处没统一 | 低，顺手统一即可 |
| `lib/purchase-suggestions-annual.ts:59-80` | 拉 24 个月采购行 JS reduce 求和/加权均价 | 低，按钮触发非每次加载 |
| `app/[locale]/classic/operator/daily-sales/_components/SalesStats.tsx:115-299` | 前端拉最多 5000 单(含行)到浏览器，四种维度全部客户端 reduce，**超过 5000 条静默截断** | 中——数据量大时"看到的统计"和实际不符，且不报错 |
| `app/[locale]/classic/boss/purchase-analysis/page.tsx:255` | `limit=500` 硬编码，"全部"视图本质是"最近 500 单"，量大后旧数据从统计里消失 | **中**——这是正确性问题，不只是性能问题 |

`lib/analytics/loss-dashboard.ts` 里的几处 `findMany`（退货扫描、损耗趋势）已在代码注释里明确承认是"数据建模限制
（退货明细是 JSON 字段，SQL 难以直接分组），非本次范围内修复"，属于合理妥协，不算遗漏。

**建议**：`ar-aging` 优先改成 SQL（同目录其余路由已经证明可行）；`purchase-analysis` 的 `limit=500` 建议改成
按日期范围查询而不是硬编码条数上限，避免"全部"视图丢历史数据。

### 5. 后台任务与 web 请求分开跑 —— **基本达标，一处已知取舍值得关注**
`scripts/` 目录下所有迁移/回填脚本经 grep 确认**没有任何 `app/api/**` 路由或 Server Action 引用**，全部走
`node --import tsx scripts/xxx.ts` 命令行方式，符合"批量任务独立跑，不进请求路径"的要求。

项目也没有 Vercel Cron / node-cron，唯一的定时任务入口是 `app/api/action-logs/cleanup/route.ts`（`x-cron-secret`
校验 + 单条 `deleteMany`），任务很轻量，没有问题。

**唯一值得注意的例外**：`lib/analytics/overview` 等接口每次请求都会同步调用 `ensureSnapshots()`
（`lib/analytics/snapshot.ts:164-200`），自动补齐缺失的 `DailyBusinessSnapshot`（最多一次补 120 天 × 5 段 SQL）。
项目文档 `docs/20260703-dev-plan-analytics-center.md` 里说明这是有意为之——Cloud Run `min-instances=0`，没有常驻
进程可以跑 cron，所以选择"请求时惰性补齐"。日常只补 1 天，代价很小；但**首次上线或服务长时间停机后的第一次
访问**，会在一次 GET 请求里同步补满 120 天，存在超时风险。这是部署成本权衡后的已知取舍，不是疏忽，
建议后续可以加个超时保护或改成后台任务+轮询，但不算本次迁移计划的必做项。

---

## 七、执行记录（2026-07-18）

第六节 5 个确认问题的最终处理：

| 问题 | 决定 | 结果 |
|---|---|---|
| 数据源 | 用 odoo_restore 代替重新灌入 odoo12(1).sql | 已用 odoo_restore 完成发票导出 |
| odoo12(1).sql | 先搬到项目外保留 | 已移至 `/Volumes/datacenter/04-eric/AIcoding/_archive/odoo12-full-dump-20260716.sql` |
| odoodata/ 旧 CSV | 直接删除 | 已删除 9 个文件 |
| odoo_restore 本地库 | 做完就关停删除 | 已 `pg_ctl stop` + 删除 `pgdata/`（释放 7GB） |
| Order.externalRef 唯一约束 | 确认按方案执行 | 已清空 18 条 seed-shortage-demo 占位数据 + 加 `@unique`（迁移 `20260718000000_order_externalref_unique`） |

发票导入结果：新脚本 `scripts/import-odoo-invoices-20260718.ts`，从 `account_invoice`/`account_invoice_line`
导出（`type IN ('out_invoice','out_refund')` 且 `number`/`origin` 非空）导入 **148,285 张 Invoice + 1,096 张
CreditNote**（1,320 行贷记单明细）。截图订单 D152099 验证：发票号 V57071，金额 €704.33，与订单完全吻合。

同时按用户要求追加修复的两处正确性隐患：
- `app/api/analytics/ar-aging/route.ts`：整表拉发票 + JS 算账龄桶 → 改为 SQL `GROUP BY` 聚合，返回行数从
  "随发票总量增长"变成"客户数 × 6 个桶"的有界规模。
- `app/api/purchase-orders/route.ts` + `purchase-analysis/page.tsx`：硬编码 `limit=500` 上限提到 5000，
  达到上限时前端显示提示条而非静默丢弃历史数据。

Odoo 五条优化里"低优先级"项的后续处理（用户要求补做）：
- **5 处外键索引缺口**：全部补齐——`OrderLine.uomId`、`OrderDiscrepancy.productId`/`substituteProductId`、
  `PurchaseOrderLine.uomId`、`Order.printedById`（迁移 `20260718010000_low_priority_fk_indexes`）。
- **`ensureSnapshots()` 冷启动阻塞风险**：加 `MAX_FILL_PER_CALL=20` 天/次的封顶，长时间停机后的缺口
  分几次请求逐步追平，不再可能一次请求同步补满 120 天。
- **DailyBusinessSnapshot 模式推广到月度/年度/司机提成汇总**：与用户确认后**暂不做**——当前没有实际
  慢查询（司机提成的 SQL 聚合本身已经写得很规范），维持原建议，等真正出现性能问题再扩展。

验证：`npm run build` 编译通过（两次，分别在发票导入后和索引改动后各跑一次）。

---

## 六、需要您确认的问题

1. **数据源**：同意用已在跑的 `odoo_restore` 本地库代替重新灌入 `odoo12 (1).sql` 吗？（强烈建议同意，理由见第一节）
2. **odoo12 (1).sql（4.25GB）**：确认删除，还是先搬去别处保留？
3. **odoodata/ 下那 7 个旧 CSV**：确认删除（已确认无引用，风险最低）？
4. **`odoo_restore` 本地库**：发票导入做完之后，是否保留以备将来还要补别的表（比如收款 account.payment）？
   还是这次做完就可以关停删除，标记"Odoo 迁移正式收尾"？
5. **Order.externalRef 加唯一约束**：确认按第四节方案执行（18 条种子占位数据清空 + 加约束）？

以上确认后即可按第三、四节执行。
