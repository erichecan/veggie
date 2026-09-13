# 台账：订单调整行体系（折扣/差价/配送费 + 赠品标记）

来源：DEV-PLAN.md（订单调整行体系），2026-09-13 确认开发，全部默认方案：
配送费/折扣不计入销售额与毛利统计、提成基数不扣折扣、单一权限点管四种类型、
历史 106 笔假商品订单不迁移。

状态标记：`[ ]` 未开始 `[~]` 进行中 `[x]` 完成 `[!]` 卡住待决策

## 任务单元

- [ ] U1 Schema：`OrderAdjustment` 模型 + `OrderAdjustmentType` 枚举 + `OrderLine.isGift`，迁移
  - 验收：`npx prisma migrate dev` 无报错，`npx tsc --noEmit` 通过
- [ ] U2 `lib/order-adjustments.ts`：CRUD + `getOrderPayableTotal()`
  - 验收：单测覆盖"无调整/多条/正负混合"
- [ ] U3 RBAC：新权限点 `sales.order.manage_adjustment`
  - 验收：role-access + route-map.ts 注册 + sync-sortkeys + permVersion bump，探针可达性 diff 符合预期
- [ ] U4 API：`app/api/orders/[id]/adjustments` (GET/POST) + `[adjustmentId]` (DELETE)；`lines/[lineId]` 加 `isGift` 透传+校验
  - 验收：curl 走通 200/401/403/409(拣货锁)
- [ ] U5 `lib/commission.ts` + `lib/analytics/metrics.ts` 排除 `isGift` 行
  - 验收：回归测试，赠品行不进提成/毛利统计
- [ ] U6 消费端梳理：枚举所有读 `order.totalAmount` 当"客户应付金额"的地方，切到 `getOrderPayableTotal()`
  - 验收：清单 + 逐个改完，不遗漏
- [ ] U7 前端：下单页/订单详情页 —— 商品行"标为赠品"勾选 + 调整面板（增/删/列表）+ 应付合计展示
  - 验收：浏览器实测走通增删查
- [ ] U8 存量四个假商品 `Product.active=false`
  - 验收：确认不影响历史订单展示，仅阻止新单选用
- [ ] U9 验证清单（CLAUDE.md 第五节 + 完成标准）+ DEV-REPORT.md
  - 验收：build/dev/路由/鉴权/日志全过

## 周期记录

（每周期完成后在此追加一行：日期 · 完成单元 · commit hash · 遗留问题）
