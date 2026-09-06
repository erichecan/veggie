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
- [ ] U3 语义模型：`lib/analytics/semantic-model.ts`
  - 验收：扩展 `DIMENSION_DEFS`（status/paymentTerm/orderSource）+ 新增 `METRIC_DEFS`（salesAmount/grossMargin，含 confirmableParams + 粒度规则），有单测覆盖"按业务员" vs "按商品"两条粒度路径
  - 依赖：U2 不需要，可并行
- [ ] U4 DSL 校验：`lib/analytics-chat/dsl-schema.ts`
  - 验收：zod schema + 业务级二次校验（维度/指标粒度兼容性），单测覆盖非法输入
  - 依赖：U3
- [ ] U5 查询编译器：`lib/analytics-chat/compiler.ts`
  - 验收：DSL → 参数化 SQL，数字与现有 `/api/analytics/margin` 同口径结果一致（交叉验证），LIMIT/超时生效
  - 依赖：U3、U4
- [ ] U6 Gemini 交互层：`lib/analytics-chat/llm.ts`
  - 验收：能把至少 8 个手工样例问题正确翻成 DSL；结果解读文本合理
  - 依赖：U3（要把白名单喂给 prompt）
- [ ] U7 确认模板：`lib/analytics-chat/confirm-template.ts`
  - 验收：任意合法 DSL 渲染出的句子覆盖该指标全部 confirmableParams
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
