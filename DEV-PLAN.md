# DEV-PLAN：数据分析聊天中台（自然语言问数，BOSS 专属）

## 读取的文档

无独立 PRD。需求来自本次对话逐轮讨论确认，没有冲突文档需要合并。核心结论回顾：

- 客户已确认"只给老板级别看、数据出境合规客户自行解决"，权限/合规不是本轮要处理的问题
- LLM（Gemini）只负责"自然语言 → 结构化查询参数（DSL）"，不生成 SQL/Prisma 代码
- 指标公式与正确性规则（税区、时区边界、防重复计数）锁死在代码里，不给 LLM/客户选；只有"税前/税后""按哪个日期口径""哪些状态算销售"这类真正的业务口径可以做成"可确认参数"，每次都摆出来给老板确认
- 维度/筛选/join 走白名单，采用"路线 2"（通用语义层），但要在建表前先核对真实 schema——已发现 `Order.restaurantId`/`Invoice.customerId` 是约定型软外键，没有声明 Prisma relation，需要手写 join
- 要支持"学习并固化"：记录问题日志用于个性化默认值 + 老板确认后可存成常用报表；但**新增指标/维度/join 永远需要开发者审核**，不能靠使用频率自动扩展白名单

## 现状核实（复用性检查，避免重复造轮子）

`lib/analytics/pivot.ts` 的 `DIMENSION_DEFS` 已经是一份可工作的"维度白名单 + 原始 SQL 片段"机制（`app/api/analytics/margin/route.ts` 在生产上跑着），并且已经用 `o."restaurantId"` 直接处理了 Order→Customer 这条软外键 join，跟本次讨论的方案完全一致——**这次是扩展这套机制，不是另起一套**。`lib/analytics/metrics.ts` 已经是"锁死规则"的唯一真相来源（`SALES_COUNTED_STATUSES`、`resolveDateRange`、`BUSINESS_TIMEZONE`）。`lib/purchase/ai-pdf-parser.ts` 已经有一套验证过的 Gemini 调用范式（`@google/genai`、JSON mode + `responseSchema` 强约束输出、模型选型踩坑记录：`gemini-2.5`/`3.6` 在这个 API 项目上全系 404，能用的是 `gemini-3.1-flash-lite`），本次直接复用这套调用方式。

## 架构决策摘要

1. LLM 只产出结构化 DSL，不产出可执行代码——杜绝"LLM 写的查询直接跑在生产库上"这个最大风险
2. 每个指标声明：锁死公式（含正确性规则）+ 一组可确认参数（如 `taxBasis`/`dateBasis`/`statusScope`）+ 默认粒度 + 允许的维度集合
3. 维度/筛选走白名单，复用并扩展 `DIMENSION_DEFS`
4. 执行层复用 `$queryRawUnsafe` + `$N` 参数化占位符（margin route.ts 同款手法），带行数上限和语句超时
5. 确认环节用固定模板把 DSL 渲染成一句人话，不让 LLM 自由描述查询过程——保证"客户确认的话术"与"实际会跑的查询"100% 对得上
6. 学习/固化：日志驱动个性化默认值 + 老板手动确认后"存为常用报表"；指标/维度/join 白名单本身只能由开发者扩展

## Schema 设计（新增，需要迁移）

```prisma
model AnalysisQueryLog {
  id              String    @id @default(cuid())
  userId          String
  user            User      @relation("AnalysisQueryLogUser", fields: [userId], references: [id])
  rawQuestion     String
  dsl             Json
  confirmedParams Json
  status          String    // 'confirmed' | 'rejected' | 'failed_validation' | 'unsupported'
  rowCount        Int?
  durationMs      Int?
  errorMessage    String?
  createdAt       DateTime  @default(now())

  @@index([userId])
  @@index([createdAt])
}

model SavedAnalysisReport {
  id         String    @id @default(cuid())
  userId     String
  user       User      @relation("SavedAnalysisReportUser", fields: [userId], references: [id])
  name       String
  dsl        Json
  useCount   Int       @default(0)
  lastUsedAt DateTime?
  createdAt  DateTime  @default(now())

  @@unique([userId, name])
  @@index([userId])
}
```

`User` model 需要补两条反向关系字段。本地开发库是多 worktree 共用的 Neon 库，动之前先 `prisma migrate status` 核对没有别的 worktree 落下的未应用迁移。

## 模块拆解

**M1 指标与维度注册表扩展** — `lib/analytics/semantic-model.ts`（新文件）
复用 `DIMENSION_DEFS` 现有 7 个维度（product/category/customer/salesUser/day/week/month），新增 `status`/`paymentTerm`/`orderSource` 三个筛选用维度。新增 `METRIC_DEFS`：v1 先做 **销售额、毛利** 两个指标，各自声明 `confirmableParams`（`taxBasis`/`dateBasis`/`statusScope`）、默认粒度（Order 级）、以及"按产品分组时切换到 OrderLine 粒度公式"的规则。库存需求/ATP、司机提成、客户欠款先不做，验证链路跑通再扩展——这是上几轮定下的"保守路线，按实际提问频率长大"。

**M2 DSL 校验** — `lib/analytics-chat/dsl-schema.ts`
zod schema 对齐 M1 白名单；编译前二次校验维度是否与指标粒度兼容（哪怕 Gemini 的 `responseSchema` 已经卡过一次格式，业务级约束还要再查一遍，双保险）。

**M3 查询编译器** — `lib/analytics-chat/compiler.ts`
DSL → `$queryRawUnsafe` + 参数数组；处理软外键 join；固定 `LIMIT`；确认 Prisma 连接的语句超时配置，没有就显式加，防止理解错的大查询拖垮 2vCPU 的生产机器。

**M4 Gemini 交互层** — `lib/analytics-chat/llm.ts`
两个用途：① 自然语言 → DSL（`responseSchema` 强约束）② 聚合结果 → 自然语言解读（纯文本）。模型先沿用 `gemini-3.1-flash-lite`；校验失败重试上限 2 次，把错误原文喂回去。

**M5 确认渲染模板** — `lib/analytics-chat/confirm-template.ts`
纯函数：DSL → 人话，覆盖该指标声明的每一个 `confirmableParams`。

**M6 API 路由**（均需登记进 `route-map.ts`，否则 middleware 层直接全员 403）
- `POST /api/analytics-chat/message`（BOSS-only）：问题 → DSL 校验 → 返回确认文案，不执行不落库
- `POST /api/analytics-chat/confirm`（BOSS-only）：确认后的 DSL → 二次校验 → 执行 → 写 `AnalysisQueryLog` → 生成解读 → 返回结果
- `POST /api/analytics-chat/reports`（BOSS-only）：保存常用报表
- `GET /api/analytics-chat/reports`（BOSS-only）：拉取 + 一键重跑（跳过 LLM，直接执行存好的 DSL）

**M7 前端页面**
`app/[locale]/classic/boss/analytics/chat/page.tsx`：聊天式 UI（输入框 + 消息流 + 确认卡片 + "存为常用报表"），挂进 boss layout 导航。layout 本身放行 BOSS+OPERATOR，API 层用 `withAuth(req, h, ['BOSS'])` 单独收紧，满足"只给老板看"。

## 风险点

1. **LLM 理解质量是最大不确定性**：`gemini-3.1-flash-lite` 只在 PDF 抽取这种窄任务上验证过，能否稳定应对"多指标+多维度+多轮追问"没有实测过。计划开发中用 10-15 个真实问题手工测准确率，不够再考虑升级模型档位（增加成本/延迟）。
2. **粒度切换**（按产品分组要换成 OrderLine 级公式）是编译器最容易写错的地方，必须专门写单测覆盖"按业务员" vs "按商品"两条路径，确认不会重复计数。
3. **多轮追问的增量修改**若第一版做不稳，降级为"每次当新问题重新理解"，避免为了体验引入难排查的状态管理 bug。
4. **数据库迁移**：本地开发库要先核对 `migrate status`，避免冲掉其它 worktree 的改动。

## 验证清单

- BOSS 账号问"本月销售额"类问题，走完 确认→执行→解读 全流程，数字与现有 `/api/analytics/margin` 页面同口径下的结果一致（交叉验证正确性，这是最重要的验收标准）
- 非 BOSS 账号调用 `/api/analytics-chat/*` 一律 403
- 问一个白名单外的维度（如"按邮编分组"），系统友好拒绝，不 500、不瞎编
- 追问里前后矛盾（先说税前又说含税），确认卡片反映最新一次选择
- `npm run build` 无报错，迁移在本地库跑通

---

📋 计划已生成，请确认以下几点后我再开始写代码：

1. **v1 指标范围**：先只做「销售额」「毛利」这两个指标（复用现有 margin 口径），其余（库存需求、司机提成、客户欠款）先不做，OK 吗？
2. **模型选型**：先用现有 `gemini-3.1-flash-lite`（省事、已有踩坑记录），效果不够再评估升级，这个节奏可以吗？
3. 功能挂在 `boss/analytics` 下新增一个"AI 问数"页面，API 层单独收紧到仅 BOSS 角色，这个位置合适吗？

回复"确认，开始开发"后我就按这个计划开始写代码。
