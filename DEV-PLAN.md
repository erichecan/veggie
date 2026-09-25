# DEV-PLAN：会计核销页面重构（合并交账/对账/核销）

日期：2026-09-24
来源：本次对话讨论 + 已确认的可点原型（https://claude.ai/artifact/Qb5CtaHvKeaBjkH7P85LCm）+ 现状调查（docs/20260924-财务模块交账对账核销梳理.md）
无产品文档参与本次改动（不是从 PRD 出发，是从"现有页面混乱"的问题出发）。

## 一、这次要解决什么

现状：司机交账（`/classic/finance/settlements`）、司机对账（`/classic/finance/driver-reports`）、会计核销（`/classic/accounting`）三个入口，数据模型分裂、状态机各自独立，生产库实测显示前两条流水线从未真正走完过一次完整流程（Trip 从未 confirm、DriverDailyReport 表 0 条）。

改法：砍掉前两个入口和背后的 Trip/DriverDailyReport 机制，把「钱」和「单」两件事合并进**一个页面**——沿用现有路径和名字 `/classic/accounting`（会计核销）：
- **钱**：不再要求司机先申报，直接显示系统按司机汇总的今日应收（现金/转账），会计核对无误后点「确认」——这次改动会让「确认」**真正入账**：生成 `Payment` 记录，核销到对应发票上。
- **单**：现有扫码核销改成两步（扫中→待确认→会计再点「确认核销」才真正核销），新增「退回核实」第三态，用于单据有问题（少货/字迹不清等）要求司机核实的场景。

## 二、模块拆解

| 模块 | 改动 |
|---|---|
| Schema | `Order.orderReturn`(Boolean) → `Order.returnStatus`(枚举) + `returnIssueNote`；新增 `DriverCashConfirmation` 表 |
| `/classic/accounting` 页面 | 按原型重写：钱板块 + 单板块（两步核销+退回核实） |
| API | `/api/orders/bulk` 的 `mark_returned` 改造成三态；新增 `/api/accounting/driver-cash` 读取 + 确认 |
| 入账逻辑 | 改造 `lib/trip-settlement-payment.ts`，让 `postTripCollections` 不再只吃 Trip，能吃「司机+送货日」这组订单 |
| 下线 | `/classic/finance/settlements`、`/classic/finance/driver-reports` 页面 + 对应 API（`/api/trips/*/settlement`、`/api/driver-reports/**`）+ 财务导航两个链接 |
| RBAC | `finance.settlement` 模块瘦身（去掉 `create`，改名义为"司机收款确认"）；新增 `finance.write_off` 模块（读/确认/退回）取代现在挂错的 `sales.order.bulk_import` |
| 司机端 | 待执行前核实 `/classic/driver/settlement` 页面里 Trip 状态推进到 COMPLETED 是否还有其他用途，再决定整页下线还是留精简版（见风险点） |

## 三、Schema 设计

```prisma
enum OrderReturnStatus {
  PENDING   // 未回（默认）
  RETURNED  // 已核销
  ISSUE     // 有问题，待司机核实
}

model Order {
  // ... 现有字段不变，替换：
  // orderReturn Boolean @default(false)   // 删除
  returnStatus    OrderReturnStatus @default(PENDING)
  returnIssueNote String?                  // 「退回核实」时会计填的问题说明
}

model DriverCashConfirmation {
  id              String   @id @default(cuid())
  driverName      String
  businessDate    String   // YYYY-MM-DD，都柏林业务日，与 businessDayStart 系列口径一致
  cashTotal       Decimal  @db.Decimal(12, 2)
  transferTotal   Decimal  @db.Decimal(12, 2)
  orderIds        String[] // 确认那一刻纳入计算的订单快照，供事后追溯
  paymentIds      String[] // 入账产生的 Payment id，供人工冲正时定位
  confirmedAt     DateTime @default(now())
  confirmedById   String
  confirmedByName String   // 显示名快照，同 Payment.createdBy 的既有约定

  @@unique([driverName, businessDate])
  @@index([businessDate])
}
```

迁移写法：新增列 → 用 `UPDATE "Order" SET "returnStatus" = CASE WHEN "orderReturn" THEN 'RETURNED' ELSE 'PENDING' END` 回填 → 同一个迁移文件里删掉 `orderReturn` 列。三步在同一个迁移文件内完成，不拆成两次迁移（20260825 的教训：跨迁移的回填背靠背执行会把数据丢光）。

## 四、入账逻辑改造

`lib/trip-settlement-payment.ts` 的 `postTripCollections(prisma, trip, actorName)` 只依赖 `trip.id`（幂等 marker）和 `trip.restaurants`（`{restaurantId, restaurantName, payment, orderIds}[]`），核销分配算法本身是纯函数、跟 Trip 无耦合，可以直接复用，只需要两处小改：

1. 幂等 marker 目前写死 `TRIP:${trip.id}`，改成可传入的前缀参数（如 `sourceType: 'TRIP' | 'DRIVER_CASH_CONFIRM'`），新调用方传 `DRIVER_CASH_CONFIRM:${DriverCashConfirmation.id}`，历史 Trip 那条路径不变（兼容旧数据的幂等判断）。
2. 新增一个构造函数 `buildCollectionInput(driverName, businessDate, orders)`：按 `restaurantId` 分组，`payment` = 该客户这组订单的含税金额合计，`orderIds` = 对应订单 id 列表，拼成 `postTripCollections` 需要的 shape。

`/api/accounting/driver-cash/confirm` 收到请求后**服务端重新计算**当前这个司机今天的订单集合与金额（不信任客户端传来的数字），创建 `DriverCashConfirmation` 记录，调用上面改造后的函数入账，把返回的 Payment id 写回 `paymentIds`。

## 五、路由清单

新增：
- `GET /api/accounting/driver-cash?date=YYYY-MM-DD` — 按司机汇总今日应收 + 是否已确认，权限点 `finance.write_off.read`
- `POST /api/accounting/driver-cash/confirm` — 确认并入账，权限点 `finance.write_off.confirm`

修改：
- `POST /api/orders/bulk`（`mark_returned` action）— `value: boolean` 改成 `status: 'PENDING'|'RETURNED'|'ISSUE'` + 可选 `note`；内部权限判断从硬编码角色名单改成读位图判断 `finance.write_off.confirm`（确认核销）/ `finance.write_off.return`（退回核实）

删除：
- `app/api/trips/[id]/settlement/route.ts`、`app/api/driver-reports/**`
- `app/[locale]/classic/finance/settlements/`、`app/[locale]/classic/finance/driver-reports/`
- `components/finance/DriverReconTable.tsx`、`lib/driver-daily-report.ts`、`lib/driver-reconciliation.ts`
- `finance/layout.tsx` 里"司机交账""司机对账"两条导航链接
- route-map.ts 里对应的 `/api/trips/*/settlement`、`/api/driver-reports/**` 三条规则

## 六、RBAC 改动

- `finance.settlement` 模块：动作从 `read/create/confirm` 瘦身为 `read/confirm`，`labelZh` 改为「司机收款确认」；迁移收回所有角色的 `finance.settlement.create` 授予（DRIVER 原本靠这个权限点提交交账，现在司机端不用交了）
- 新增 `finance.write_off` 模块：动作 `read/confirm/return`；`prisma/seed-rbac.json` 授予 BOSS/OPERATOR/FINANCE 三个动作，DRIVER 不给
- `lib/rbac/route-map.ts` 登记新路径，`scripts/rbac/sync-sortkeys.ts` 补排序键，bump `permVersion`（否则老 token 拿不到新权限点）
- 迁移必须真正回写 `prisma/seed-rbac.json`（20260919 的教训：只在生产库 UPDATE "AppRole" 会让 CI 静态守卫失明）

## 七、风险点

1. **入账不可撤销**：`postTripCollections` 没有冲正机制，一旦「确认」就真的核销了发票，写错了没法一键撤销（这跟改造前的旧机制风险一致，不是新引入的问题，但这次会第一次被真的用起来）。UI 上「确认」按钮会加一次真实的二次确认交互（不是浏览器 `confirm()`——正式页面可以用，但为了跟现有页面风格一致会做成 inline 二次确认条），并且不提供「撤销确认」按钮。
2. **司机端 `/classic/driver/settlement` 页面的归属未定**：这个页面里 Trip 状态推进到 `COMPLETED` 除了触发交账流程，还有没有给司机提成冻结（`lib/commission.ts` 提到的 `trips PUT COMPLETED批量`）当触发器，执行时第一步会先查清楚这条链路，再决定整页下线还是留一个不带现金字段的精简版。如果查出来确实有依赖，我会保留必要的最小交互，不会因为要下线交账功能就顺带砍掉提成冻结的触发点。
3. **`driverName` 字符串分组的既有缺陷会被继续沿用**：现有代码按司机姓名字符串分组（不是 driverSlotId），生产数据显示同一司机同天跑多个批次（早班+午班）是设计内的常见场景，这次沿用同样的分组粒度——对「钱」这个场景是合理的（会计一天跟一个司机对一次账，不分批次），不算新问题。
4. **改动范围**：schema 改动 + 新模块 + 删除 3 个页面/多个 API + RBAC 迁移，属于「大改」，按流程需要在完成前跑 `/code-review high` 与 `/security-review`，findings 逐条处理或写明不处理的理由。

## 附录 A：技术验收标准（verify.sh 覆盖，我自己保证，不用你看）

- `npx tsc --noEmit`、`npm run build`、`npx prisma migrate status`
- 新增两个 API 路由的鉴权探针：无 token/错 token/低权限（DRIVER）→ 401/401/403；FINANCE → 200
- `/api/orders/bulk` mark_returned 三态转换探针：PENDING→ISSUE（必须带 note）→PENDING→RETURNED，每一步落库后 `GET /api/orders` 读到的状态与操作一致
- 入账幂等探针：对同一 `driverName`+`businessDate` 连续调用两次 confirm，第二次必须 `skippedAsDuplicate`，且 `Payment` 表该 marker 下只有一批记录、`Invoice.amountDue` 不被二次扣减
- 现有 54 条 RBAC 测试全绿 + 新增覆盖 `finance.write_off.*` 权限点的用例
- 路由清单第五节里"删除"的路径，探针要断言它们现在返回 404（确认真的下线了，不是改了个寂寞）
