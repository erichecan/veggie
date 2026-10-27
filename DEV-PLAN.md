# DEV-PLAN：核销触发开票 + 对账单改按送货日期

## 读取了哪些文档

本次没有独立 PRD 文件。来源是：
1. 先派 Explore agent 调研了「发票生成触发点与订单状态流转现状」，报告见本次会话。
2. 据此向你提了 4 个 AskUserQuestion，逐字存进 `docs/20261026-核销触发开票与对账单口径-需求原话.md`。
3. 历史背景文档（只读没改）：`docs/20260924-财务模块交账对账核销梳理.md`、`docs/20260924-会计核销重构-tasks.md`——
   现在的核销（write-off）页面就是那次重构的产物，本次是在它上面接开票逻辑，不是另起一套。

## 现状调研结论（决定了下面怎么改）

- 自动开票现在挂在两处：`app/api/orders/[id]/route.ts`（订单页手动改"已完成"）和 `lib/delivery-complete.ts`
  的 `completeDeliveredOrders()`（调度台"标记完成"+ 司机端 Trip 完成共用）。两处都在状态推进到
  `COMPLETED` 的同一拍直接调 `createDraftInvoiceForOrder`。
- `deliveredQty` 现在也在同一拍被无条件覆盖成 `orderedQty`（全送），核销（`mark_returned`）这个动作
  本身完全不碰数量，只是把 `Order.returnStatus` 标成 `RETURNED/ISSUE`。
- 今天（20261026）commit `4553f8d5` 刚给核销页加了一个「批量生成 Invoice」手动按钮
  （`app/api/accounting/returns/bulk-invoice/route.ts`），调的是同一套 `createDraftInvoiceForOrder`，
  幂等（已开票的单跳过）。这是现成的"核销后开票"管道，本次要做的是把它从"手动点"变成"核销确认自动触发"，
  并且让核销这一步能先修正数量。
- 提成冻结 `recalcOrderCommission` 现在也挂在"标记完成"这一拍，用的是当时（全送）的 `deliveredQty`。
- Statement 现在两处查询（`lib/statements.ts`）按 `Order.confirmationDate` 筛选/排序，`lib/finance/statement.ts`
  的 `StatementOrderRow` 类型也叫 `confirmationDate`。
- 本地库核实（533 条可入账状态订单）：`deliveryDate` 一条不缺，`confirmationDate` 反而缺 4 条——
  改按 `deliveryDate` 统计不是风险点，是改进。生产库未核实，列进附录 A 的部署前探针。
- 不需要新增字段、不需要 migration——`OrderLine.deliveredQty`、`Order.returnStatus` 都已经在。

## 模块拆解

### A. 核销联动开票（主体改动）

1. `lib/delivery-complete.ts::completeDeliveredOrders()`：去掉里面调 `createDraftInvoiceForOrder` 的循环；
   `recalcOrderCommission` 的调用一并挪走（见模块 C）。全送覆盖 `deliveredQty=orderedQty` 这段**保留**——
   它现在变成"核销时默认值的来源"，不再是"开票前最后一次写入"。
2. `app/api/orders/[id]/route.ts`：去掉状态推进到 `COMPLETED` 时调 `createDraftInvoiceForOrder` 的那一行，
   `fillDeliveredQtyIfUnrecorded` 保留（订单页直接改完成时仍需要给核销页一个默认全送值）。
3. `app/api/orders/bulk/route.ts` 的 `mark_returned` action：
   - 批量调用（勾选多单一次性 `RETURNED`）：不改数量，按当前 `deliveredQty`（默认全送）直接核销 +
     自动调 `createDraftInvoiceForOrder` + `recalcOrderCommission`。
   - 新增单订单调用路径（见模块 B 的新 API）：核销同时可以带 `lines: [{ orderLineId, deliveredQty }]`，
     先按行更新 `deliveredQty`，再核销 + 开票 + 冻结提成。
4. `app/api/accounting/returns/bulk-invoice/route.ts` + WriteOffBoard「批量生成 Invoice」按钮：**不删**，
   改成补漏工具（类似 `lib/ledger-check.ts` 的手动补票按钮）——核销自动开票失败、或历史遗留漏票时用。
   文案改成「补开漏开的发票」。

### B. 核销页支持改数量

1. `lib/accounting/returns.ts`：`ReturnRow` 目前只有订单级摘要，没有行信息。新增一个按需拉明细的接口
   （倾向 `GET /api/accounting/returns/[id]/lines`，点开一行才请求，列表接口不跟着变重）。
2. `components/accounting/WriteOffBoard.tsx`：单行「确认核销」旁加一个「核对数量」展开/弹窗——
   展示这一单的每一行 `productName / orderedQty / 实际送达数量（输入框，默认=orderedQty）`，
   确认后把 `lines` 一起 POST 给 `/api/orders/bulk`（`mark_returned` + `status=RETURNED`）。
   批量「确认核销」按钮维持现在的"直接核销"语义，但补一句提示：「有差异的单请逐单核对数量后再核销，
   批量核销按默认送达量计」。

### C. 提成冻结时点跟着挪（技术决策，不是用户要求，理由写进 commit）

`recalcOrderCommission` 从"标记完成"挪到"核销确认"（`mark_returned=RETURNED` 成功之后）。
理由：提成和发票现在用同一个最终 `deliveredQty`，如果提成还在完成时冻结、发票在核销时按改过的数量开，
两个数字会对不上——这是技术正确性问题，不是风格选择，我自己决定，不占用你的判断。

### D. 对账单改按送货日期

1. `lib/statements.ts`：`orderSelect`/`toRow` 以及两处 `where`（历史期初余额查询 + 本期订单查询）
   把 `confirmationDate` 换成 `deliveryDate`；`orderBy` 同步换。
2. `lib/finance/statement.ts`：`StatementOrderRow.confirmationDate` 重命名为 `deliveryDate`，
   `resolveStatementPeriod`/`summarizeStatement` 里引用的字段名跟着改。
3. 老订单兜底：`deliveryDate` 为空时按原逻辑会把这张单漏出对账区间——附录 A 加一条部署前探针，
   在生产库跑一次「可入账状态订单里 deliveryDate 为空的有几条」，为空则在那批历史单上用
   `confirmationDate` 兜底，不新增字段、不改 schema。

## 本次不碰的东西（范围外）

- `CreditNote`（贷记单）生成逻辑（`generate-from-returns`，从 Trip 退货记录生成）——跟本次"核销时编辑
  `deliveredQty`"是两条独立路径，不打通。
- Trip 级退货审核流程（`app/api/trips/[id]/returns/route.ts`）——继续按原样运作，如果一单先走了这条
  路径改过 `deliveredQty`，核销时看到的就是已经调整过的值，默认不再二次改（除非又发现新差异）。
- 历史已开票订单——这次改动只影响上线之后新产生的订单，老发票不动。

## 路由/文件清单

| 文件 | 改动 |
|---|---|
| `lib/delivery-complete.ts` | 去掉自动开票循环 + 提成冻结循环 |
| `app/api/orders/[id]/route.ts` | 去掉 COMPLETED 时的自动开票调用 |
| `app/api/orders/bulk/route.ts` | `mark_returned` 加 `lines` 可选参数，RETURNED 成功后触发开票+提成冻结 |
| `lib/accounting/returns.ts` | 新增单订单明细查询（供编辑数量用） |
| 新增 `app/api/accounting/returns/[id]/lines/route.ts` | GET 单订单行明细 |
| `components/accounting/WriteOffBoard.tsx` | 单行核对数量的展开/弹窗交互 |
| `app/api/accounting/returns/bulk-invoice/route.ts` | 保留，文案改为补漏工具 |
| `lib/statements.ts` | 两处查询字段 confirmationDate → deliveryDate |
| `lib/finance/statement.ts` | `StatementOrderRow` 字段改名 |
| `tests/invoice-from-order.test.ts`、`tests/finance-statement.test.ts` 等 | 同步改期望值 |

## 风险点

1. **提成冻结时点挪动**（见模块 C）——技术决策，我自己定，理由写进 commit message。
2. **批量核销不支持改数量**——会计如果图省事把有差异的单也走批量核销，数量会按默认全送算，这是操作
   流程风险不是代码风险，靠 UI 提示缓解，不强制拦截（强制拦截需要先判断"有没有差异"，但"有没有差异"
   本身要等核销这一步才知道，鸡生蛋）。
3. **今天刚上线的"批量生成 Invoice"按钮**改成补漏工具保留，不删——避免误删一个刚上线几小时的功能。
4. **生产库 deliveryDate 缺失情况未核实**——本地库（demo/anonymized 数据，533 条）全部不缺，生产库需要
   部署前额外跑一遍同样的 count 查询（附录 A）。
5. CreditNote / Trip 退货两条路径不打通——范围外，已在"本次不碰"里写明。

## 附录 A：技术验收标准（追加到 `scripts/verify.sh`）

- 探针 1：测试订单 确认出发(扣库存) → 标记完成(IN_DELIVERY→COMPLETED) → 断言**没有**生成发票
  （改动前这里会生成，改动后必须不生成）
- 探针 2：核销确认（`mark_returned RETURNED`，不带 `lines`）→ 断言生成 1 张发票，金额 = Σ(orderedQty × unitPrice)
- 探针 3：核销确认时带 `lines` 改一行数量（比如少 1 箱）→ 断言 `OrderLine.deliveredQty` 落库为改过的值，
  发票金额按改过的数量算
- 探针 4：「补开漏票」按钮对已有发票的单返回 `skipped`，不重复开票（幂等不破）
- 探针 5：提成冻结时间点 —— 标记完成后查 `commissionFrozenAt` 应为空，核销确认后才非空
- 探针 6：Statement 按 `deliveryDate` 生成 —— 构造一单 `confirmationDate` 和 `deliveryDate` 落在不同周的订单，
  断言账单落在 `deliveryDate` 对应的周期
- 探针 7（部署前跑一次，非 CI 常驻）：生产库 `count(status in BILLABLE_STATUSES and deliveryDate is null)`，
  非 0 则先处理历史数据兜底再上线
- 既有探针（tsc / build / migrate status / 路由可达 / 鉴权 401-401-403）照常跑，不许因为本次改动退化

---

📋 计划已生成。三块内容，只有第 1 块需要你判断：

【需要你判断 — 场景清单】
用你的话描述做完之后是什么样，逐条标注来源：
- [你说的] 以前"标记完成"订单就立刻开出草稿发票；现在改成——无论这单有没有问题，都要等会计在核销页点一下
  「核销确认」之后才生成发票
- [你说的] 核销确认这一步，如果这一单有少送/差异，会计要能直接在核销框里把这一行的实际送达数量改掉，
  改完之后发票就按改过的数字开
- [你说的] 对账单(Statement)以前按"确认日期"统计这个客户这段时间欠多少钱，现在改成按"送货日期"统计
- [我推断的] 批量「确认核销」按钮只给完全没有数量差异、照单送达的订单用；要改数量的单必须逐单打开编辑，
  不支持批量改量
- [我推断的] 今天刚上线的「批量生成 Invoice」按钮，改完之后保留为补漏工具，不是主要开票入口了
- [我推断的] 提成冻结的时间点，一并从"标记完成"挪到"核销确认"，保证提成金额和最终发票金额用同一个送达数量
推断项最容易错，请重点看这几条，尤其是最后一条（提成挪动点）——我是从"数字要对得上"这个技术角度推的，
不代表你的业务流程里提成本来就该等核销才定。

【我负责 — 你不用看】
技术验收标准见上方附录 A。性能、鉴权、类型、查询效率由我定标准、我自证、我贴证据。
技术栈/部署沿用现有（Next.js + Prisma + Neon 开发库/生产 droplet PostgreSQL），本次不涉及新基建。

【一次性告知 — 不同意就说】
歧义清单：无——这次是当面问清楚的，没有需要我按"保守解释"猜的地方。
假设清单：
- 历史已开票订单不受影响，只影响上线后新产生的订单
- 生产库 `deliveryDate` 缺失情况假设跟本地库一样基本不缺，附录 A 探针 7 会在部署前实测，
  如果缺失严重会先处理历史数据兜底，不会让对账单漏单

回复"确认"后我不再就实现细节打断你。
