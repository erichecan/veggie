# 财务中心补全 — 重新实现任务台账（20260902）

> 背景：`.claude/worktrees/purchase-rfq-copy-history` 里有一份同名 WIP（设计文档见该 worktree 下
> `docs/20260731-finance-center-completion-plan.md`），业务逻辑思路可参考，但鉴权模式过时（旧
> `withAuth`+硬编码角色数组，未在 `route-map.ts` 登记）、两个迁移文件对应字段已在共享开发库上被
> 冲掉重来（20260823 事故），且距今一个多月，main 的 schema/权限体系已经往前走了（比如 `ap-aging`
> main 已有更好实现、`Account` 表已多出 `6000 运营费用` 科目）。本台账是**重新设计**，不是照抄 WIP。
>
> 范围：利润表 / 结算周期自动生成对账单 / 客户预付款 / 供应商三单核销，共 4 项。`ap-aging` 不在
> 本次范围内（main 已有）。

## 关键发现：这4项功能不需要新增任何权限点

逐一核对 `lib/rbac/catalog.ts` 现有权限点后发现，4 项功能全部能复用已存在的权限点，**不需要跑
`sync-sortkeys.ts`，不需要 bump `permVersion`**：

| 功能 | 复用的权限点 | 说明 |
|---|---|---|
| 利润表（读） | `analytics.finance.read` | 与 `ar-aging`/`ap-aging` 同一个权限点（`lib/rbac/catalog.ts:430`），角色口径直接对齐 |
| 结算周期字段（改） | `master.customer.update` | `settlementCycle` 只是 Customer 的一个新字段，走现有客户更新接口的权限 |
| 结算周期字段（看） | `master.customer.read_credit` | 该权限点本来就是"查看信用与账期"（`catalog.ts:358`），结算周期属于账期范畴 |
| 供应商三单核销（读，计算得出） | `finance.vendor_bill.read` | 现算现得，不新增字段，挂在现有 GET 详情接口权限上 |
| 供应商三单核销（人工调整） | `finance.vendor_bill.update` | 复用现有"修改"动作 |
| 预付款登记 | `finance.payment.create` | `finance.payment` 模块已有 `read`/`create`（`catalog.ts:306-310`） |
| 预付款查余额 | `finance.payment.read` | 同上 |
| 预付款冲抵发票 | `finance.invoice.pay` | 复用现有"收款"动作（`catalog.ts:301`），语义上冲抵发票就是一种收款方式 |
| 定时任务触发（cron） | 不走权限点，走共享密钥 | `x-cron-secret` header，与 `app/api/cron/backup-database` 同一模式 |

⚠️ **命名坑，之前踩过**：`lib/rbac/catalog.ts:336` 已经存在一个 `finance.settlement` 模块，但那是
"**司机交账**"（Driver Settlement），跟本次"客户结算周期"完全是两回事。本次绝对不能复用或改名这个
模块，也不要另起一个容易混淆的 `finance.settlement_cycle` —— 直接用 `master.customer.update` 即可，
不需要新模块。

## 1. Schema 变更

当前最新迁移：`20260901000001_sale_uom_commission_price`。新迁移从 `20260902000001` 开始，按依赖顺序
编号，避免相互冲突（4 项功能共用的基础设施先行，具体业务字段按依赖关系排在后面）：

### 20260902000001_customer_settlement_cycle（结算周期用）
```sql
ALTER TABLE "Customer" ADD COLUMN "settlementCycle" TEXT NOT NULL DEFAULT 'NONE';
-- 值域: NONE | WEEKLY | MONTHLY，应用层校验，不建 CHECK 约束（本仓库现有字段风格一致，如 Customer.priceType）
```
纯新增可选字段（有默认值），对现有数据零影响，可安全 `migrate deploy`。

⚠️ 这个字段名和上一版 WIP 的迁移文件同名，但**不要复用那个旧迁移文件**——它是针对一个月前的
schema 状态生成的，`prisma migrate` 按文件名+checksum 识别迁移，旧文件的 checksum 对不上当前迁移
链，直接复制过来会在 `migrate deploy` 时报 checksum 不一致或顺序错乱。必须用
`npx prisma migrate dev --name customer_settlement_cycle` 在当前 schema 基础上重新生成。

### 20260902000002_payment_prepayment_support（预付款用）
```sql
ALTER TABLE "Payment" ALTER COLUMN "invoiceId" DROP NOT NULL;
ALTER TABLE "Payment" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'CASH';
-- 值域: CASH | PREPAYMENT_RECEIVED | PREPAYMENT_APPLIED（沿用 WIP 的三态设计，理由见下）
CREATE INDEX "Payment_source_idx" ON "Payment"("source");
```
同样是纯增量（放宽 NOT NULL + 加带默认值的新列），不删不改现有列，安全。

**沿用 WIP 的三态设计而非布尔字段**：`Payment.isPrepayment: Boolean` 无法区分"收到预收款"（借银行/贷
预收款负债）和"用预收款核销发票"（借预收款负债/贷应收账款，不产生新现金流）这两个记账方向相反的
事件，三态字段能让 `lib/accounting.ts` 里的过账分支直接按值选科目方向，不用额外查上下文。

### 供应商三单核销：不加字段
沿用 WIP 最终版的决定（WIP 文档里写明了这个转向）：不加 `VendorBill.reconciliationStatus` 存储字段，
现算现得。理由与 WIP 一致且更充分——本项目已经因为"派生状态存成字段、和源头数据脱节"吃过多次亏
（`docs/20260624-data-ownership-audit.md` 记录的 SSOT 审计），核对成本很低（一次 GET 详情页请求内
按 `PurchaseOrderLine.receivedQty` vs `VendorBill` 行 qty 比较），没必要存。**这项不需要 migration。**

### 会计科目：新增 2300 客户预收款
`lib/accounting.ts` 的 `STANDARD_ACCOUNTS`（第 283-296 行）加一行：
```ts
{ code: '2300', name: 'Customer Prepayments', nameZh: '客户预收款', type: 'LIABILITY' },
```
⚠️ **这一步不能只改代码**——`STANDARD_ACCOUNTS` 只在 `prisma/seed.ts` 里被消费（本地全新库跑
`prisma db seed` 时才会 upsert 进库），生产库不会重新跑 seed。需要额外写一条数据迁移（放在
`20260902000002_payment_prepayment_support` 迁移的 SQL 里一并 `INSERT ... ON CONFLICT (code) DO
NOTHING`），确保 `migrate deploy` 时生产库也拿到这个新科目，不依赖手工操作。

## 2. API 路由清单

| 路径 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/api/analytics/income-statement` | GET | `withCachedAuth` + `require: 'analytics.finance.read'` | 输入 `periodStart`/`periodEnd` query 参数，返回营收/COGS/毛利（口径见下） |
| `/api/customers/[id]` | PATCH（已存在，扩展） | 现有 `master.customer.update`，不变 | 允许更新体里带 `settlementCycle` 字段，走现有校验分支加一个值域检查 |
| `/api/customers/[id]/prepayment-balance` | GET | `withAuth`/`withCachedAuth`（余额会随时变化，**不能用 `withCachedAuth`**，见下）+ `require: 'finance.payment.read'` | 按 `customerId` 汇总 `source IN (PREPAYMENT_RECEIVED)` 减去 `(PREPAYMENT_APPLIED)` 的净额 |
| `/api/invoices/[id]/apply-prepayment` | POST | `require: 'finance.invoice.pay'` | 事务内：校验预付款余额充足 → 写一条 `source=PREPAYMENT_APPLIED` 的负向 Payment（冲减发票 `amountDue`）→ 过账 `postPaymentToJournal` 走"借预收款/贷AR"分支 |
| `/api/vendor-bills/[id]` | GET（已存在，扩展） | 现有 `finance.vendor_bill.read`，不变 | 响应体加 `reconciliation: { status, poQty, receivedQty, billedQty, diff }`，调用 `lib/vendor-bill-reconciliation.ts` 现算 |
| `/api/cron/generate-statements` | POST | `x-cron-secret` header（同 `backup-database`），不经过用户权限体系 | 遍历 `settlementCycle != 'NONE'` 的客户，按周期计算区间，复用现有 `POST /api/statements` 的生成逻辑（抽成公共函数，不要复制粘贴一份） |
| `app/[locale]/classic/boss/analytics/income-statement/page.tsx` | 页面 | `page.boss.access`（已有，layout 白名单不用改，boss 下的子路由默认在白名单里，新增页面前实测确认一下） | 参照 `ar-aging/page.tsx` 布局 |

⚠️ `withCachedAuth` 的选用要谨慎——`lib/analytics/cache.ts` 的注释写得很清楚：缓存的前提是"输入是
已完成的历史订单，短时间内结果不变"。`prepayment-balance` 这个接口的结果会因为"财务这一刻登记了一
笔预付款"而立刻变化，用户操作完马上要看到新余额，缓存会让人以为操作没生效——**这个接口必须用不缓存
的 `withAuth`，不能照抄 `withCachedAuth` 的写法**。`income-statement` 如果查询区间不含今天可以缓存
（复用 `ttlFor` 现有逻辑），含今天的区间同样要给「real-time」的 TTL，这块直接照抄 `ar-aging` 现成
的调用方式即可。

## 3. cron 触发方式设计

`POST /api/cron/generate-statements`，header 带 `x-cron-secret`，值取 `process.env.CRON_SECRET`——
与现有 `app/api/cron/backup-database/route.ts` 完全一致的模式（该文件注释里甚至已经提前写了这条
路由的名字，说明这个设计早就是预期中的下一步，不是本次臆造）。触发方是"任何能发 HTTP POST 的东西"
（droplet 上用 crontab/systemd timer 即可），符合 CLAUDE.md 铁律，不引入云平台专属调度依赖。

幂等性：按 `(customerId, periodStart, periodEnd)` 加唯一约束或者生成前先查是否已存在同周期
Statement，避免定时任务重复跑或者手动补跑时重复生成——`finance.statement` 模块已有的
`POST /api/statements` 如果本来就没做这层校验，这次要顺带补上（不管是不是本次任务原计划范围，
这是数据正确性的前提，不能跳过）。

## 4. 利润表口径（需要你确认一个范围问题，WIP 当时也卡在这里）

现状核实（今天重新查证，WIP 的判断已经过时一部分）：
- `Account.type` 有 `INCOME`/`EXPENSE` 分类，当前实际有转账记录（JournalEntry 过账）的只有
  `4000 Sales Revenue` 和 `5000 Purchases/COGS`
- `6000 Operating Expenses` **科目本身已经存在**于 `STANDARD_ACCOUNTS`（WIP 写这份计划时说"没有"，
  但现在 main 已经有了）——但全仓库搜索后确认**从未被任何过账函数实际使用过**（`lib/accounting.ts`
  里除了定义它自己，没有第二处引用 `6000`），也就是说：科目占位已经在，但运营费用（工资/房租/物流）
  录入入口和过账逻辑仍然不存在，这一点和 WIP 的结论实质上一致，只是"科目已建"这个事实要更新一下。

**沿用 WIP 建议的选项 A**：利润表按 `Account.type IN ('INCOME','EXPENSE')` 通用查询（不写死科目
code），本次上线时因为只有 4000/5000 有数据，算出来的实际是"毛利"，但代码不需要因为将来运营费用
科目开始被使用而改——这是自动前向兼容的设计，比写死科目号更好。页面上明确标注"当前为毛利口径
（营收-COGS），运营费用尚未纳入"，不冒充"净利润"，避免误导。

## 5. 测试计划

| 测试文件 | 类型 | 覆盖点 |
|---|---|---|
| `tests/income-statement-calc.test.ts` | 纯函数单测 | 从一组 JournalEntryLine fixture 算出营收/COGS/毛利，边界：空区间、只有INCOME无EXPENSE |
| `tests/prepayments.test.ts` | 纯函数单测 | `lib/prepayments.ts` 的余额计算（RECEIVED求和-APPLIED求和）、余额不足时拒绝冲抵的校验逻辑 |
| `tests/vendor-bill-reconciliation.test.ts` | 纯函数单测 | `lib/vendor-bill-reconciliation.ts` 的三单比对，覆盖 MATCHED/OVER_RECEIVED/UNDER_RECEIVED 三种场景 |
| `tests/api-write-gates.test.ts`（扩展现有文件，不新建） | API鉴权测试 | 新增的 4 个受保护路由分别验证：无token 401、错误角色 403、正确角色通过——本仓库这类测试统一收在这一个文件里，别再散开建新文件 |
| `tests/rbac-route-map.test.ts`（扩展现有文件） | 路由表一致性测试 | 新路由必须出现在 `route-map.ts` 里，这个测试本来就是防止"漏登记导致全员403"这个已知坑的守卫 |
| `tests/generate-statements-cron.test.ts` | API测试 | 无 `x-cron-secret` 返回401；同一周期重复调用不重复生成 Statement（幂等性） |

## 6. 实施顺序

按依赖关系排列，**不是**"四个都做完再一起验证"那种一次性大爆炸，而是共享基础设施先行、业务功能
可并行：

```
Step 0（公共基础设施，其余4项都要用，必须最先且只做一次）
  └─ 两个迁移文件生成 + route-map.ts/tests 里"新路由必须登记"的检查跑一遍
     （因为不新增权限点，这一步比原WIP轻很多，不涉及 catalog.ts / sync-sortkeys.ts / permVersion）

Step 1（三项互相独立，可并行开发）
  ├─ 1.1 利润表（income-statement）—— 只读，风险最低，建议第一个验证通过
  ├─ 1.2 结算周期字段 + cron 路由（generate-statements）—— 依赖 Step 0 的迁移
  └─ 1.3 供应商三单核销 —— 不需要迁移，纯新增 lib 文件 + 扩展现有 GET 接口

Step 2（依赖 Step 0 的科目变更，且逻辑上依赖"预付款"概念先立住）
  └─ 2.1 预付款（prepayment）—— 涉及记账分录方向，建议放最后，出错影响面最大（真金白银的负债科目）

Step 3（用户要求的"一起验证上线"）
  └─ 四项功能分别的单测 + 鉴权测试全部跑绿后，一次性合并进 main、一次性部署上线
```

## 7. 验收标准

- [ ] `npx tsc --noEmit` 全绿，无 `as any` 绕过（WIP 版本里 cron 路由用了 `prisma as any`，本次因为
      迁移在当前 schema 基础上重新生成、且合并前跑过 `prisma generate`，不应该再出现这个绕过）
- [ ] `npm test` 全绿，含上面列的 6 个新增/扩展测试文件
- [ ] 4 个新路由全部出现在 `lib/rbac/route-map.ts`，`rbac-route-map.test.ts` 断言通过
- [ ] 利润表：取一个月区间，营收 = 该月 `Invoice` 总额 − `CreditNote` 抵扣额，毛利 = 营收 − COGS，
      手工核对一致
- [ ] 结算周期：设一个 `WEEKLY` 客户，手动 POST 一次 cron 路由，生成的 `Statement` 区间正确；连续
      调用两次不重复生成
- [ ] 供应商三单核销：构造一个收货量少于 PO 下单量的场景，`GET /api/vendor-bills/[id]` 返回的
      `reconciliation.status` 正确显示为 `UNDER_RECEIVED`
- [ ] 预付款：记一笔无发票预收款 → 分录借银行贷 `2300`；开票后调用 apply-prepayment 冲抵 → 分录借
      `2300` 贷应收账款、预付款余额相应减少；余额不足时接口正确拒绝并返回错误信息
- [ ] 权限：非 BOSS/FINANCE 角色访问这4个新接口全部拿到 403（不是 500，不是静默放行）
