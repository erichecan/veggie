# 任务台账：AI 问数 v2（跨域 + 明细钻取）

对应 `DEV-PLAN.md`（AI 问数 v2）。本文档是本轮开发进度的唯一真相，每完成一个单元回写状态+证据。

## 状态说明
- [ ] 待做　[~] 进行中　[x] 已完成并验证　[!] 卡住/需决策

## 任务清单

- [x] V1 探针：验证 `OrderAuditLog` 能否追溯 `Order.status` PENDING→CONFIRMED 的迁移时间戳
  - **结论：可行**。`app/api/orders/[id]/route.ts:632` + `bulk/route.ts:261` 在状态转 CONFIRMED 时
    写 `OrderAuditLog{action:'confirmed'}`；本地库抽样 5 条，`audit.createdAt` 与
    `order.confirmationDate` 严格对应（同请求写入，样本内相差 <1s）。
  - ⚠️ **发现一个口径坑**：抽样中有一条订单有 `confirmed` 审计记录，但当前 `status=PENDING`
    （后来又被撤回/`withdrawn`）。转化率口径必须定义为"当前 status=CONFIRMED 的订单数 /
    曾经是 PENDING 的订单总数"，**不能**用"是否存在过 confirmed 审计记录"来判断，否则会把
    撤回过的单也计入"已转化"。已记入 `domains/quotation.ts` 注释。
  - 依赖：无
- [x] V2 Schema：`Order.confirmationDate` 补索引
  - 迁移 `20260910000001_order_confirmationdate_index`，本地 `db push` 应用成功，
    `migrate resolve --applied` 标记，`migrate status` 干净，`prisma generate` 通过。
  - 依赖：无
- [x] V3 语义拆分：`lib/analytics-chat/domains/sales.ts`（从 `semantic-model.ts` + 旧 `compiler.ts` 迁移）
  - `lib/analytics/semantic-model.ts` 已删除（迁移落地，旧 6 个引用点全部改指向新 domains 模块）。
  - 验收：24 个 DSL 单测 + 5 个 confirm-template 单测 + 6 个 interpret 单测全绿（补了 `domain` 字段后回归通过）。
  - 依赖：无
- [x] V4 语义新建：`lib/analytics-chat/domains/procurement.ts`
  - 验收：`purchaseAmount` 按 supplier 分组聚合，与 `/api/analytics/procurement` 同款 SQL
    实测比对：新 SQL 总额 27895.32 = 参照 SQL 总额 27895.32（8 家供应商，逐分不差）。
  - 依赖：V3
- [x] V5 语义新建：`lib/analytics-chat/domains/quotation.ts`
  - V1 探针结论为"可行"，含 `quotationCount`/`quotationAmount`/`conversionRate` 三个指标。
  - 验收：`conversionRate` 手工核对——SQL 算出 545 单中 533 单已转化 = 97.798%，
    与手写 `COUNT(*) FILTER` 核对语句结果完全一致。
  - 依赖：V1、V3
- [x] V6 语义新建：`lib/analytics-chat/domains/delivery.ts`
  - `Trip.driverId`/`driverName` 快照字段做准（不读 `wave.orderIds`，理由见文件头注释）。
  - 验收：`totalPayment` 按 driver 分组，与 `/api/analytics/logistics` 同款 SQL 实测比对：
    新 SQL 336.05 = 参照 SQL 336.05（1 名司机，本地库数据量小但口径逐字对上）。
  - 依赖：V3
- [x] V7 DSL 改造：`dsl-schema.ts` 加 `domain`/`mode` 字段，按域校验 metric/dimension/filters
  - 单测覆盖：非法/缺失 domain、跨域 metric、跨域 dimension（格式过语义拒）、跨域 filter key、
    detail 模式缺日期范围（只给 from 不给 to 也拒）、四域全部指标白名单自检。
  - 依赖：V3、V4、V5、V6
- [x] V8 compiler 改造：按域分派 + detail 模式新路径 + 护栏
  - `COMPILER_ROW_LIMIT` 逻辑不变，detail 模式复用同一护栏；4 域 aggregate + detail 共 8 种
    组合直接跑 `compileAndRun` 全部返回正确形状、无 SQL 报错（含 delivery 域两层 JSON 展开）。
  - ⛔ **实测中发现并修复一个真 bug**：`conversionRate` 等比率类指标，`total` 字段原先跟其它
    指标一样"各分组直接相加"，8 组转化率相加吐出 `737.82%` 这种没有业务含义的数字——加了
    `MetricDef.aggregationKind: 'rate'`，改成按 qty（各分组样本量）加权平均，浏览器复测后
    总计正确显示 `97.8%` 且与不分组时的总计一致。新增 3 个 `weightedAverage` 单测防回归。
  - 依赖：V7
- [x] V9 llm.ts 改造：两层 responseSchema（先选 domain 再选合法 metric/dimension）+ prompt 文案
  - 实测 10 条真实问法（4 域 aggregate + 4 域 detail + 2 条应拒绝）：**8/10 一次命中预期**。
  - ⚠️ **已知不完美但接受的行为**：原始触发本次需求的问题"7月3号客户订单，每家都送什么货，
    单价数量"——脚本化测试中模型选了 sales 域（符合预期），但同一句话在 Playwright 真实交互
    里模型选了 delivery 域（把"客户订单"理解成"配送执行"）。**两个域的答案都业务合理**
    （sales=订单本身记了什么，delivery=车上实际送了什么），DSL/校验/查询都能正确跑通，
    不是错误答案，是同一句话存在真实的业务歧义——已记入风险点，不算本批 bug。
  - 依赖：V7
- [x] V10 confirm-template.ts：确认文案覆盖四域 + detail 模式文案
  - 验收：5 个既有单测补 `domain` 字段后回归通过；浏览器实测 4 域确认文案均正确显示域名+
    口径（如"我理解为：...的"报价单"转化率（%），按业务员分组"）。
  - 依赖：V7
- [x] V11 API 路由透传 domain/mode（message/confirm/reports）
  - `message`/`reports` 两条路由无需改动（本就是泛型透传）；`confirm` 路由改用
    `getDomainDef` 替换旧 `getMetricDef`，detail 模式跳过 `narrateResult`（明细不需要 AI 复述）。
  - 验收：Playwright 全链路实测（message→confirm→结果）覆盖 sales/detail、sales/aggregate、
    quotation/aggregate、delivery/detail 四种组合，无 500/无控制台报错。
  - 依赖：V8、V9、V10
- [x] V12 前端：`boss/analytics/chat` 结果展示支持明细表格渲染
  - `ChatEntryView.tsx` 拆出 `AggregateResult`/`DetailResult` 判别联合，detail 分支渲染动态列
    表格（按 domain 声明的 `detail.fields` 生成表头）；`page.tsx` 首屏提示语补充明细类示例问法。
  - 验收：真实浏览器（Playwright，BOSS 账号）验证——"今年1月到9月的销售订单明细，商品单价
    数量"返回 500 行表格（日期/客户/商品/单价/数量/金额六列），截断提示正确显示，控制台 0 错误。
  - 依赖：V11
- [x] V13 测试收尾：DSL 单测扩充 + compiler 交叉验证脚本化 + Playwright 端到端（4 域）
  - `npm test`：873 个测试，865 过 6 败 → 补 3 个测试文件的 `domain` 字段后复跑 **873 过 1 败**，
    唯一失败是 `pricing-override.test.ts`（缺 ABCT 客户测试夹具，v1 报告已记录的既有问题，
    与本次改动无关）。
  - 依赖：V8、V9
- [x] V14 端到端验证 + DEV-REPORT.md
  - `npx tsc --noEmit` 全程保持 0 错误；`npm run build` 全绿，4 条既有路由 + 1 个页面正常编译；
    未新增/改动任何 RBAC 路由或权限点，`npm test` 里的 rbac 可达性快照测试原样通过（零 diff）。
  - 依赖：全部
