# DEV-REPORT：数据分析聊天中台（AI 问数）

对应 `DEV-PLAN.md`，任务台账见 `docs/20260906-analytics-chat-tasks.md`（U1-U10 全部完成）。

## 做了什么

给 BOSS 角色加了一个"用中文聊天问数据"的功能：输入"本月按业务员分组的销售额"这类问题，系统用 Gemini 把问题翻译成结构化查询（不是让 AI 自己写 SQL），先给出一句人话确认（比如"我理解为：2026-09-01 至 2026-09-06，税前的销售额，按业务员分组"），BOSS 点确认后才真正在生产库上查，查完再用 AI 生成一段自然语言解读。

核心设计原则（贯穿本次讨论确认）：
- **AI 只负责"理解"，不负责"查询"**——AI 产出的是一份结构化参数（JSON），真正拼 SQL、连数据库的是普通代码，不是每次都可能写法不同的 AI 生成 SQL
- **指标公式锁死，只暴露真正的业务选择**——比如"销售额"可以选税前/税后，但"统计哪些订单状态算销售额""按哪个日期字段统计"这些是写死在 `lib/analytics/metrics.ts` 里的既有口径，不给 AI/BOSS 选，避免每次问出来的数字口径不一致
- **复用现有引擎，不是另起一套**——销售额/毛利用的是毛利分析页（`/api/analytics/margin`）同一段 SQL 逻辑，两边数字实测完全一致

## 页面/接口清单

| 类型 | 路径 | 说明 |
|---|---|---|
| 页面 | `/classic/boss/analytics/chat` | 聊天式 UI，只有 BOSS 角色能看到导航入口 |
| API | `POST /api/analytics-chat/message` | 自然语言 → 确认文案（不执行查询） |
| API | `POST /api/analytics-chat/confirm` | 确认后执行查询 + AI 解读 |
| API | `GET/POST /api/analytics-chat/reports` | 常用报表的列表/保存 |

## 功能完成度

| 功能 | 状态 |
|---|---|
| 销售额指标（税前/税后可选） | ✅ |
| 毛利指标（固定税前，与毛利页同口径） | ✅ |
| 按 7 个维度分组（商品/分类/客户/业务员/日/周/月） | ✅ |
| 确认卡片（列出全部可确认参数，不只是提到过的） | ✅ |
| 理解失败/不支持的问法自我纠正重试（最多 2 次） | ✅ |
| 多轮追问（带着上一轮 DSL 做增量修改） | ✅（实测一个正例，未做大规模鲁棒性测试，见"已知限制"） |
| 提问审计日志（`AnalysisQueryLog`） | ✅ |
| 常用报表保存（`SavedAnalysisReport`） | ✅（保存/列表；一键重跑接口未做，见下） |
| 按客户/商品/业务员 id 精确筛选 | ⚠️ 编译器支持，但 AI 不会产出（未做名称→id 解析，见"已知限制"） |
| 老板个人参数偏好学习、日志驱动自动建议存报表 | ⚠️ 未做（`AnalysisQueryLog` 表已建好，是后续迭代的数据基础） |

## 权限

新增权限点 `analytics.chat.read`（提问/查看）、`analytics.chat.manage`（存报表），**只发给 BOSS**——跟其它 `analytics.*` 权限普发给 OPERATOR 不同，这是按客户要求"只给老板级别看"单独收紧的。导航链接也按这个权限位图条件渲染，OPERATOR 登录后看不到入口。

## 测试账号（仅本地开发库，非生产）

本地开发库既有的 demo 种子账号（域名固定是 `demo.local`，不是真实邮箱），本次只是临时改了密码方便验证：

| 角色 | 邮箱用户名 | 密码 |
|------|------|------|
| BOSS | boss（[at]demo.local） | TempLocalTest123! |
| OPERATOR（用于验证 403） | operator（[at]demo.local） | TempLocalTest123! |

⚠️ 这两个密码是我为本次开发验证临时改的，只影响本地 Neon 开发库（`.env.local` 指向的库），不是生产凭证。

## 验证结果

| 验证项 | 验证方式 | 结果 |
|---|---|---|
| OPERATOR 访问 AI 问数接口 | curl POST /api/analytics-chat/message | ✅ 403 |
| BOSS 问"本月按业务员分组的销售额" | curl + Playwright | ✅ 正确理解，给出确认文案 |
| 确认后执行查询 | Playwright 点 Confirm | ✅ 返回结果+AI解读，写入 AnalysisQueryLog |
| **数字口径与毛利页交叉验证** | 直接对比 `compileAndRun` 与 `/api/analytics/margin?groupBy=salesUser` | ✅ revenueExTax=22.5、grossProfit=4，两边完全一致 |
| 含税换算公式 | 对一条 taxRate=23% 的真实行验证 | ✅ 38 → 46.74，与 `lib/order-items.ts` 的 `orderIncTaxTotal` 同一条公式 |
| 问不支持的维度（"按邮编统计"） | curl + Playwright | ✅ 正确拒绝，不瞎编 |
| 问不存在的指标（"库存周转率"） | curl | ✅ 正确拒绝 |
| 给 grossMargin 塞 taxBasis（非法组合） | curl POST /confirm | ✅ 400，明确错误信息 |
| 多轮追问增量修改 | Playwright："毛利，含税的"（延续上一轮 salesUser 分组） | ✅ 正确丢弃不支持的税率请求，同时保留分组维度 |
| 存为常用报表 | Playwright 点击 + 数据库核实 | ✅ UI 操作后 `SavedAnalysisReport` 表真的多了一条 |
| RBAC 平迁安全绳 | `node --test` rbac 相关 40 个测试 + `role-reachability.test.ts` | ✅ 全绿，2 份独立的可达性快照都已更新（纯新增，4 个 handler 全部"可达：BOSS"） |
| 全量测试 | `npm test` | ✅ 860 个测试 857 过；1 败是 `pricing-override.test.ts` 缺 ABCT 客户测试夹具，与本次改动无关的既有问题 |
| 构建 | `npm run build` | ✅ 无报错，4 条新路由+1 个新页面均编译进产物 |

## 已知限制（尚未实现，不隐瞒）

1. **不支持按具体客户/商品/业务员筛选**（如"看看 ABC 餐厅的销售额"）：编译器已经支持 id 级别筛选，但 AI 侧没做"客户名字 → 客户 id"这层解析，给了这个字段只会诱使模型自己编一个不存在的 id。目前只能按维度分组看全量，不能过滤到某一个具体客户/商品。
2. **常用报表没有"一键重跑"接口**：`GET/POST /api/analytics-chat/reports` 只做了保存和列表，没做"点一下直接跳过 AI 执行存好的 DSL"这个接口，是本次刻意收窄的范围。
3. **没有做个性化学习**：`AnalysisQueryLog` 表已经在记录每次提问，但"记住老板常用选税后不选税前"这类个性化默认值、"同一个问题问多了自动建议存成报表"都还没做，这张表是留给这两个后续功能用的数据基础。
4. **多轮追问只验证了一个正例**：没有做大量不同追问句式的鲁棒性测试，实际使用中如果发现追问经常理解错，可能需要针对性调整 prompt。
5. **v1 只有销售额、毛利两个指标**：库存需求、司机提成、客户欠款等 DEV-PLAN 里提到的其它指标按计划留到后续，根据老板实际问题分布再决定要不要扩展。
6. **查询没有单独的语句超时**：跟现有 `/api/analytics/margin` 等路由一致（同样没配 `statement_timeout`），是平台既有的风险敞口，不是本次新引入的问题，但也没有额外加固。

## 下一步建议

按实际使用一段时间后，看老板最常问哪些现在不支持的问题（`AnalysisQueryLog` 里 status=unsupported/failed_validation 的记录），据此决定优先扩展哪个指标或维度；如果客户名/商品名筛选是高频需求，再补名称解析这一层。
