# 台账：订单调整行体系（折扣/差价/配送费 + 赠品标记）

来源：DEV-PLAN.md（订单调整行体系），2026-09-13 确认开发，全部默认方案：
配送费/折扣不计入销售额与毛利统计、提成基数不扣折扣、单一权限点管四种类型、
历史 106 笔假商品订单不迁移。

状态标记：`[ ]` 未开始 `[~]` 进行中 `[x]` 完成 `[!]` 卡住待决策

## 任务单元

- [x] U1 Schema：`OrderAdjustment` 模型 + `OrderAdjustmentType` 枚举 + `OrderLine.isGift`，迁移
  - 验收：`npx prisma migrate dev` 无报错，`npx tsc --noEmit` 通过
  - 完成于 d611b15；`migrate dev` 撞 shadow DB 已知坑（见 memory
    `prisma-migration-shadow-db`），改用 `migrate diff --script` 生成 SQL +
    `db execute` 直接应用 + `migrate resolve --applied` 补登记；发现共享开发库上
    有 2 个陌生迁移（`20260731000001_customer_settlement_cycle`/
    `20260731000002_payment_prepayment_support`）本地缺失，核实对应字段
    （settlementCycle/prepayment）已在当前 schema.prisma 里，是历史 git 重写
    遗留的记账缺口，与本次改动无关，未处理
- [x] U2 `lib/order-adjustments.ts`：CRUD + `getOrderPayableTotal()`
  - 验收：单测覆盖"无调整/多条/正负混合"
  - 完成于 d30f773；拆出纯函数 computePayableTotal/validateAdjustmentInput 做单测
    （项目没有 DB 集成测试先例，CRUD 本身走 U4 API 层用 curl 实测覆盖）
- [x] U3 RBAC：新权限点 `sales.order.manage_adjustment`
  - 验收：role-access + route-map.ts 注册 + sync-sortkeys + permVersion bump，探针可达性 diff 符合预期
  - 完成于 b7f04b3；默认发给持有 sales.order.update 的角色；探针可达性 diff 放到 U9 统一跑（U4 API 落地后跑才有意义）
- [x] U4 API：`app/api/orders/[id]/adjustments` (GET/POST) + `[adjustmentId]` (DELETE)；`isGift` 透传+校验
  - 验收：curl 走通 200/401/403/409(拣货锁)
  - 完成于 35990d2；isGift 实际接入 PUT /api/orders/[id]（主编辑路径）+ POST lines（追加单行），
    未接入 lines/[lineId] PATCH（该接口是"缺货改量"窄接口，只认 newQty，不做通用行编辑，
    范围与计划文字有出入，基于代码实查收窄）；curl 实测 401/200/201/400×2/404 全过，
    403/409 走既有共享闸门(role-access测试+assertOrderNotPickLockedForLineEdit)静态验证，
    未伪造凭证强测；顺带发现并按项目机制处理了 role-reachability.json + parity-baseline.json
    两个快照测试（新增 handler 需要显式登记，非本次改动引入的问题）
- [x] U5 `lib/commission.ts` + 各 analytics 消费端排除 `isGift` 行
  - 验收：回归测试，赠品行不进提成/毛利统计
  - 完成于 ca2e394；实际改动比计划里写的"metrics.ts"更广——metrics.ts 本身是纯公式，
    真正聚合 OrderLine 的是 5 处原生 SQL（sales-overview/margin/snapshot/
    driver-commission/analytics-chat sales域），已逐个加 `isGift=false` 过滤；
    procurement 域与 shortage 率查询不涉及金额，未改；analytics-chat 明细钻取
    模式故意不排除（展示真实订单行本身）
- [x] U6 消费端梳理：枚举所有读 `order.totalAmount` 当"客户应付金额"的地方，切到 `getOrderPayableTotal()`
  - 验收：清单 + 逐个改完，不遗漏
  - 完成于 796e157；派 fork 枚举后实改 3 处（invoice-from-order.ts/trip-from-wave.ts/
    print 的 dispatch-loader+trip-loader）+ 新增 loadAdjustmentTotalMap 批量helper；
    curl 端到端验证 dispatch-print-data 折算正确(112.5-12.5=100)；客户门户/内部订单
    列表页"总额"展示留给 U7 前端一并做（需要 UI 改动而不只是数字，不是本步能"顺手改完"的）；
    统计类口径(sales-matrix/sales-analysis/sales-report)明确排除不动
- [x] U7 前端：下单页/订单详情页 —— 商品行"标为赠品"勾选 + 调整面板（增/删/列表）+ 应付合计展示
  - 验收：浏览器实测走通增删查
  - 完成于 a136008；范围收窄到 orders/[id]（销售单详情页），quotations/[id]/place-order
    未接入同款 UI（后端接口本身对 PENDING 单已可用，留作后续）；Playwright 实测增删调整行/
    Amount Due 正确联动(382→388.50)/Gift 勾选即时归零锁定单价/Discard 后核库无脏数据
- [x] U8 存量四个假商品 `Product.active=false`
  - 验收：确认不影响历史订单展示，仅阻止新单选用
  - 完成于本周期；用户已确认"现在就下架"；生产库 SSH+psql 直接执行，4 个商品（
    Deliver Service/Discount/Small Offer Set/price difference）确认改前 active=true 各 1 条，
    改后核实全部为 false；历史订单不受影响（不迁移，只挡新单再选用）
- [x] U9 验证清单（CLAUDE.md 第五节 + 完成标准）+ DEV-REPORT.md
  - 验收：build/dev/路由/鉴权/日志全过
  - 完成于本周期；DEV-REPORT.md 已产出；`npm run build` 无报错；dev log 无 error/warn；
    401/404/400/错误密码等边界场景 curl 复核；eslint 对改动文件跑过(0 error，2 条 warning
    确认是改动前就存在的技术债，非本次引入)

## 台账状态：全部完成（U1-U9）

- [x] U10（用户追加需求）：报价单页（quotations/[id]）、新建下单页（place-order）接入 Gift 勾选/调整面板
  - 完成于 23857cb；quotations/[id] 与 orders/[id] 完全对称（Gift 列 + OrderAdjustmentsPanel）；
    place-order 只加 Gift 勾选（调整面板需要已存在 orderId，新建阶段没有，设计如此，
    保存后跳转 quotations/[id] 即可继续加）；顺带修了 POST /api/orders 的真实 bug——
    赠品行落库价归零但 totalAmount/items 快照/审计日志/邮件确认此前仍读引擎权威价，
    统一收口成 linesForPersist 消除该口径分裂；Playwright + curl 端到端验证，测试数据已清理

## 周期记录

（每周期完成后在此追加一行：日期 · 完成单元 · commit hash · 遗留问题）
