# DEV-PLAN：AI 问数 v2 —— 跨域(quotation/配送/采购) + 明细钻取

## 读取的文档

无独立 PRD。需求来自客户发来的第三方系统截图（"7月3号客户订单，每家都送什么货，单价数量"被系统拒答，
只支持销售额/毛利两个聚合指标）+ 本次对话确认。另参考已存档的
`docs/20260807-flexible-analysis-requirements.md`（灵活分析需求存档）、
`docs/20260906-analytics-chat-tasks.md`（v1 任务台账，v1 已于 2026-09-06 上线）。

## 需求与范围（本次对话确认）

- v1 现状：`analytics.chat.read/manage` 权限点只发 BOSS；DSL 只认两个指标（销售额/毛利），
  单一 sales domain，只能聚合、不能吐明细行。
- v2 目标：**一批开发全部四个能力并上线**（不分期）：
  1. **明细钻取**——不聚合，直接吐订单行原始字段（商品/单价/数量/客户）
  2. **quotation 报价单域**——报价单数量、转化率等
  3. **配送中心域**——司机/波次/线路相关问数
  4. **采购域**——采购额、到货量等
- 明确不做：
  - 权限范围不变，**仍然只给 BOSS**（不跟 dataScope 挂钩，不给销售经理/操作员开放）
  - 司机提成考核报表（排名/绩效对比）**不在本批**，那是固定报表形态，另安排
  - 不新增第三方 BI/自然语言前端框，复用现有 `boss/analytics/chat` 页面和 Gemini 交互层

## 现状核实（复用性检查，`lib/analytics-chat/` + `app/api/analytics-chat/`）

- **v1 完全没有 domain 概念，是单一 domain 硬编码**：`dsl-schema.ts` 的 `metric` 是字面量联合
  `'salesAmount' | 'grossMargin'`，`filters` 只认 4 个写死 key。加新 domain 不是"扩枚举"，
  是要在 DSL 里新开一个 `domain` 字段，`parseDsl`/`validateDslSemantics`/`compiler`/`llm` 四层
  全部要按 domain 分派。
- **compiler.ts 只有一条"永远聚合"的路径**（固定 `FROM OrderLine JOIN Order`，输出恒为
  `{key,name,value,qty}` 一行一个聚合值），"明细钻取"不能复用，需要新开一条 `mode: 'detail'`
  分支。`COMPILER_ROW_LIMIT=500` 是唯一现存护栏，对明细模式更关键（聚合查询命中 500 行是极端
  情况，明细查询随手一问就可能命中）。
- **DIMENSION_DEFS 复用自 `lib/analytics/pivot.ts`**，是 sales 域私有的 7 个维度，不含
  quotation/procurement/logistics 维度，四个域各自需要一份自己的维度/指标白名单。
- **llm.ts 的 responseSchema 是静态常量**，`metric`/`dimension` 枚举由白名单生成。四域后
  schema 会膨胀，需要改成"先选 domain，再从该 domain 的合法目录里选 metric/dimension"的
  两层结构，prompt 文案也要跟着改（v1 是单一目录文案）。
- **AnalysisQueryLog / SavedAnalysisReport 两张表不需要迁移**：`dsl` 字段本来就是
  `Json?`/`Json`，加 `domain` 字段自然落进 JSON。
- **v1 从未接缓存**（`withCachedAuth`、`lib/analytics/cache.ts` 都没接入 analytics-chat），
  文档里担心的"缓存 key 空间爆炸"目前不是要解决的问题——**本批不新增缓存**，跟 v1 保持一致，
  等真的出现性能问题再评估。
- **quotation 域没有独立表**：`Order.status = PENDING` 就是报价单，`sentAt` 是"已发送"子状态，
  没有 `convertedToOrderId`——报价单和订单本来就是同一行记录，"转化"= `PENDING → CONFIRMED`
  的状态迁移。**转化率类指标要靠 `OrderAuditLog` 才能拿到"何时从 PENDING 变 CONFIRMED"**，
  开发时第一步要先探针验证这张表能不能查到状态迁移时间戳，查不到就退化成只做
  "存量 PENDING 单数量/金额"这类静态指标，不做转化率——**这是本计划唯一一个可能收窄范围的
  技术不确定项**，先做技术验证（≤0.5 天），验证结果记入台账，不阻塞其余三个域开工。
- **配送中心域数据模型是数组/JSON，不是关系表**：`PickingWave.orderIds` 是 `String[]`
  （查询要用 `orderId = ANY(w."orderIds")`，不能标准 JOIN）；`Trip.restaurants` 是
  `Json`（存 `[{orderId,restaurantId,productId,qty,...}]` 快照数组）。现有
  `/api/analytics/logistics` 从未下钻到订单/商品明细。**这是四个域里实现复杂度最高的一个**，
  需要 `JOIN LATERAL unnest()` 或解 JSON，单独多写测试用例。另外 `Order.driverSlotId` 与
  `wave.orderIds` 历史上分叉过（见 memory `driver-slot-divergence-fixed-20260708`），查询以
  哪个为准要在实现时明确写注释，别选错。
- **采购域结构与 sales 域高度对称，复用成本最低**：`PurchaseOrder`/`PurchaseOrderLine` 字段
  与 `Order`/`OrderLine` 基本一一对应，现有 `/api/analytics/procurement` 已经是干净的两表
  JOIN，可以直接照抄 compiler.ts 的聚合模式改表名；供应商复用 `Customer` 表（项目里客户/
  供应商是同一张表）。
- **明细钻取的索引缺口**：`OrderLine` 只有 3 个索引（orderId/productId/uomId），`Order` 的
  索引列表里**没有 `confirmationDate`**——v1 能扛住是因为先靠 `status` 索引把订单表筛小再
  join；明细钻取如果允许"某天某客户"直接按日期范围查，在 133 万行 OrderLine 上有全表扫风险。
  **本批加一条迁移：`Order.confirmationDate` 补索引**。

## Schema 设计

```prisma
model Order {
  // ...现有字段不变
  @@index([confirmationDate])  // 新增：明细钻取/quotation 域按日期范围查询需要
}
```

`AnalysisQueryLog.dsl` / `SavedAnalysisReport.dsl` 保持 `Json` 类型不变，新增的 `domain` /
`mode` 字段直接落进现有 JSON 列，不改表结构。

## 模块拆解

1. **数据层**：`prisma/schema.prisma` 加 `Order.confirmationDate` 索引 + 迁移。
2. **DSL 改造**（`lib/analytics-chat/dsl-schema.ts`）：加 `domain`（'sales'|'quotation'|
   'procurement'|'delivery'，必填）、`mode`（'aggregate'|'detail'，默认 'aggregate'）两个
   字段；`metric`/`dimension`/`filters` 的合法值改成按 `domain` 查表校验，不再是全局白名单。
3. **语义层拆分**（新建 `lib/analytics-chat/domains/{sales,quotation,procurement,delivery}.ts`）：
   每个域各自的 metric 定义、维度白名单、筛选字段，`sales.ts` 直接迁移 v1 现有内容。
4. **compiler.ts 按域分派**：拆成 4 个 query builder，聚合模式共享现有"输出
   `{key,name,value,qty}`"的形状；detail 模式新开一条路径，输出行级数组
   （商品名/单价/数量/客户名/日期等），复用同一个 `COMPILER_ROW_LIMIT` 机制但 detail 模式
   限制更严（提案：detail 默认必须带日期范围，超限提示"请缩小范围"而不是静默截断）。
   delivery 域用 raw SQL 处理 `unnest(orderIds)` / 解 `Trip.restaurants` JSON。
5. **llm.ts 改造**：Gemini responseSchema 改成两层（先选 domain，再选该 domain 合法的
   metric/dimension/mode），prompt 文案按域给目录；沿用 v1 已验证的"模型拒绝不支持的问法"
   校验兜底（parseDsl/validateDslSemantics 仍是最后一道闸，不信任模型输出）。
6. **confirm-template.ts**：确认文案要能说清"你问的是哪个域、汇总还是明细"，四个域各自的
   默认口径提示语（比如 quotation 域要提示"统计口径=状态迁移记录，历史数据缺口以 OrderAuditLog
   覆盖范围为准"如果验证结果显示有缺口）。
7. **API 路由**（`app/api/analytics-chat/{message,confirm,reports}`）：基本透传 domain/mode，
   路由层改动小；确认 `route-map.ts` 无需新增路由（沿用 v1 的 4 条）。
8. **前端**（`boss/analytics/chat`）：结果展示要能渲染"明细表格"这种新形态（区别于现在的
   单值/分组条形展示），其余交互（确认卡片、多轮追问、存报表）不变。
9. **测试**：
   - DSL 单测：四个域各自的合法/非法组合（含跨域非法字段，如 sales 域塞 delivery 维度）
   - compiler 交叉验证：procurement 域对照 `/api/analytics/procurement` 现有报表数字；
     delivery 域对照 `/api/analytics/logistics` 现有报表数字；沿用 v1 的手工交叉验证方法论
   - Playwright 端到端：四个域各跑一条真实自然语言问题 + 一条应拒绝的问法

## 路由/文件清单

- `prisma/schema.prisma` + 新迁移（`Order.confirmationDate` 索引）
- `lib/analytics-chat/dsl-schema.ts`
- `lib/analytics-chat/domains/sales.ts`（从 semantic-model.ts 迁移）
- `lib/analytics-chat/domains/quotation.ts`（新建）
- `lib/analytics-chat/domains/procurement.ts`（新建）
- `lib/analytics-chat/domains/delivery.ts`（新建）
- `lib/analytics-chat/compiler.ts`
- `lib/analytics-chat/llm.ts`
- `lib/analytics-chat/confirm-template.ts`
- `app/api/analytics-chat/{message,confirm,reports}/route.ts`（改动小）
- `app/[locale]/classic/boss/analytics/chat/` 下的结果展示组件
- `tests/analytics-chat-dsl.test.ts`（扩充）+ 新增 compiler 交叉验证脚本

## 风险点

1. **quotation 转化率的数据可行性未验证**——`OrderAuditLog` 能否追溯状态迁移时间戳是本计划
   唯一的技术不确定项，第一步先探针验证，验证不通过则该域退化为静态指标（不含转化率），
   不阻塞其余三个域。
2. **配送域是四个里复杂度最高的**——`orderIds` 数组 + `Trip.restaurants` JSON 快照不是标准
   关系表，SQL 写法与其余三域完全不同，且历史上 `driverSlotId` 与 `wave.orderIds` 分叉过，
   需要单独多写测试，不能照抄 sales/procurement 的模式。
3. **明细钻取的性能护栏**——`Order.confirmationDate` 现在没索引，133 万行 OrderLine 全表扫
   风险真实存在，本计划已加索引，但 detail 模式若允许"不带日期范围"的问法仍可能命中大范围
   查询，需要在 DSL 校验层强制明细模式必须带日期范围（聚合模式不强制，维持 v1 现状）。
4. **Gemini prompt 膨胀后的选域准确率未知**——v1 验证过"单一目录"下的 8/8 准确率，四域后
   模型可能在 domain 选择或跨域字段误用上出错，靠 parseDsl/validateDslSemantics 兜底拒绝，
   但用户体验上可能出现"问的明明是配送，模型选了 sales 域被拒"的情况，需要在测试阶段专门
   构造几条域边界模糊的问法验证准确率，如果实测不理想，需要回来跟客户同步预期。
5. **权限范围维持 BOSS-only**——本批数据比 v1 更敏感（采购价、司机相关信息），当前设计不做
   dataScope 隔离，如果后续要给非 BOSS 角色开放，需要重新设计（不在本批范围）。
