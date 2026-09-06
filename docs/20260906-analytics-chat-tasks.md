# 任务台账：数据分析聊天中台（AI 问数）

对应 `DEV-PLAN.md`（数据分析聊天中台）。已确认：v1 只做销售额+毛利两个指标；Gemini 模型用现有 `gemini-3.1-flash-lite`（免费/已验证可用）；功能挂 `boss/analytics` 下，API 收紧到仅 BOSS。

## 状态说明
- [ ] 待做　[~] 进行中　[x] 已完成并验证　[!] 卡住/需决策

## 任务清单

- [x] U1 RBAC：新增权限点 `analytics.chat.read`/`analytics.chat.manage`，只发给 BOSS
  - 验收：`catalog.ts` 加模块 → `sync-sortkeys.ts` 生成新 sortKey → 迁移 SQL（Permission insert + AppRole boss 追加 + permVersion bump）→ `route-map.ts` 登记 4 条新路由。40 个 rbac 测试全过，含平迁零 diff 安全绳。route.ts 还没写，"每个 handler 都能命中规则"这条要等 U8 后复验。
  - 依赖：无
- [x] U2 Schema：`AnalysisQueryLog` + `SavedAnalysisReport` 两张表
  - 验收：`db push` 本地库同步 + 手写迁移 SQL（生产用）+ `migrate resolve --applied` 标记两条迁移 + `prisma generate` 通过
  - 依赖：U1（同一批迁移或分开均可，本次分开写更清楚）
- [x] U3 语义模型：`lib/analytics/semantic-model.ts`
  - ⚠️ **范围比计划收紧**：实现前核对了 `lib/analytics/metrics.ts` 头部注释，发现"销售口径=confirmationDate"和"毛利按税前算"是已经写死的 SSOT，不是可选项。改成：dateBasis 不作为可确认参数（固定 confirmationDate）；taxBasis 只对 salesAmount 开放，grossMargin 零可确认参数。statusScope 也不开放，固定 `SALES_COUNTED_STATUSES`。
  - 验收：直接复用 `DIMENSION_DEFS`（product/category/customer/salesUser/day/week/month）作为维度白名单，未新增维度（v1 不需要 status/paymentTerm 筛选维度，先精简）
  - 依赖：无
- [x] U4 DSL 校验：`lib/analytics-chat/dsl-schema.ts`
  - 未引入 zod（项目里只是 node_modules 里的间接依赖，从未被业务代码使用），改成手写校验，跟 `lib/customers-query.ts` 等既有风格一致
  - 验收：13 个单测全过（`tests/analytics-chat-dsl.test.ts`），覆盖非法 metric/dimension/filters/dateRange、grossMargin 不允许 taxBasis
  - 依赖：U3
- [x] U5 查询编译器：`lib/analytics-chat/compiler.ts`
  - 验收：手工交叉验证——`compileAndRun` 按 salesUser 分组算出的 salesAmount/grossMargin 与 `/api/analytics/margin?groupBy=salesUser` 返回的 revenueExTax/grossProfit **完全一致**（22.5 / 4）；incTax 换算公式对了一个真实 taxRate=23% 的行验证（38 → 46.74）；不分组时踩了一个坑：`GROUP BY '__total__'` 报 Postgres 42601"non-integer constant in GROUP BY"，改成不分组时省略 GROUP BY 子句
  - 依赖：U3、U4
- [x] U6 Gemini 交互层：`lib/analytics-chat/llm.ts`
  - 验收：实测 8/8 手工样例问题正确翻成 DSL（含 2 条应拒绝的问法："按邮编统计"、"库存周转率"，模型都正确拒绝没有瞎编）；`narrateResult` 解读文本合理，还主动指出了"未指定业务员"这个数据质量问题
  - `filters` 字段刻意没放进 responseSchema 给 LLM：v1 没做客户名/商品名→id 的解析，给了字段只会诱使模型自己编一个 id
  - **实测中发现并修复一个真 bug**：Gemini 的 nullable 字段有时吐字面 `null` 而不是干脆不带这个 key（如 `confirmedParams: null`），`parseDsl` 原来会把这种情况误判成格式错误拒绝掉——已修复三处（confirmedParams/filters/dateRange）并补了回归测试
  - 依赖：U3
- [x] U7 确认模板：`lib/analytics-chat/confirm-template.ts`
  - 验收：5 个单测覆盖——salesAmount 默认值也要列出来、grossMargin 不列任何税前税后条目、显式含税覆盖默认值、不分组文案、显式日期范围文案
  - 依赖：U3
- [ ] U8 API 路由：message / confirm / reports(POST+GET)
  - 验收：4 条路由都要求 BOSS 权限，非 BOSS 403；已登记 route-map（U1 已做，这里接线）
  - 依赖：U4 U5 U6 U7
- [ ] U9 前端页面：`boss/analytics/chat`
  - 验收：Playwright 走一遍完整对话，boss layout 导航能进入
  - 依赖：U8
- [ ] U10 端到端验证 + DEV-REPORT.md
  - 验收：CLAUDE.md 第五节清单全过，交叉验证数字口径正确
  - 依赖：全部
