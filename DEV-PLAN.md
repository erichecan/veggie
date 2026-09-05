# DEV-PLAN：订单撤回/重新确认闭环 + 面包屑状态修正

## 读取的文档

无独立 PRD 文档，需求来自用户 2026-09-05 提供的订单详情页截图批注（`XW-260904-001`，图中面包屑显示 "Sales Order" 高亮但右上角徽章为黄色 "Pending"，用户对此提出改进诉求）。已通过代码调研核实现状，无需额外产品文档。

## 背景（现状核实结论）

- 订单状态机（`prisma/schema.prisma` `OrderStatus`）：`PENDING → CONFIRMED → WAVE_ASSIGNED → IN_DELIVERY → COMPLETED → LOCKED`，另有 `CANCELLED`。没有独立的 "Quotation/Quotation Sent/Sales Order" 三态，是 UI 层派生：`PENDING`+无 `sentAt` = Quotation，`PENDING`+有 `sentAt` = Quotation Sent，其余非取消状态 = Sales Order。
- 项目里同一张订单有两个详情页：
  - `app/[locale]/classic/operator/quotations/[id]/page.tsx`：2 段式动态面包屑（Quotation/Sales Order），`status===PENDING` 时有 **Confirm** 按钮，但没有"删除整单"按钮。
  - `app/[locale]/classic/operator/orders/[id]/page.tsx`（用户截图所在页）：3 段式面包屑，但**是写死的静态 HTML**（684-690 行），不读 `order.status`；`status===PENDING` 时有 **Delete** 按钮，但**没有 Confirm 按钮**。
- 今天早上的提交 `4ff01ed` 已经在 `orders/[id]` 页加了 "Revert to Quotation" 按钮（`CONFIRMED`/`WAVE_ASSIGNED` → `PENDING`），后端 `ALLOWED_TRANSITIONS` 已放开。
- 结果：用户点"撤回到报价单"后留在 `orders/[id]` 原页面，状态已经变成 `PENDING`（真撤回成功了），但① 面包屑没跟着变、还显示 "Sales Order"，② 页面上没有 Confirm 按钮编辑完没法原地重新确认——只能自己导航去 `/quotations` 找这张单。这就是截图里"卡在 Pending"的真实原因。
- 撤回若命中"波次已拣货锁定"（`PickingWave.pickLockedAt`），后端会 409，提示先去 Daily Sale 手动 unlock，是两步两个页面。
- `IN_DELIVERY`（已出发）订单目前**没有任何撤回入口**（UI 和 API 都没有）。已出发的波次会生成 `Trip`，`Trip.restaurants` 是 JSON 数组，一个 Trip 可能覆盖同一司机同一趟里的多个客户/多张订单——要把"某一张已出发订单"单独摘出来退回，需要精确编辑这个 JSON 结构而不能整单/整 Trip 处理，属于项目里已知的 SSOT 高风险区（[[data-ownership-audit-20260624]] 记忆里点名的 Trip/wave 数据分裂问题同一片区域）。

## 模块拆解与范围（用户已选：A + B + C 全做，但建议分批验收）

### A. 修 UI bug（低风险，建议先做，本次一并完成）
1. `orders/[id]/page.tsx` 684-690 行：面包屑从写死 HTML 改成按 `order.status` + `sentAt` 动态渲染（PENDING 无 sentAt → Quotation 高亮；PENDING 有 sentAt → Quotation Sent 高亮；其余 → Sales Order 高亮；`CANCELLED` 单独灰态处理，不硬套三段）。
2. 同页新增 "Confirm"/"重新确认" 按钮：`statusUp === 'PENDING' && !editing` 时展示，调用 `apiPut(/api/orders/${id}, { status: 'CONFIRMED' })`，成功后 `load()` 刷新本页（不跳转），与已有的 Edit/Delete 按钮并列，形成"撤回→编辑→重新确认"闭环，全程不用离开这张页面。

### B. 打通"两步为一步"（低-中风险，本次一并完成）
3. `handleWithdraw` 遇到后端 409（波次已拣货锁定）时，不再只是报错，改为二次确认弹窗："检测到所在波次已拣货锁定，是否一并解锁并撤回？"，用户确认后前端依次调用 `POST /api/waves/[waveId]/pick-unlock` → 重试 `PUT /api/orders/[id]`（需要后端 409 响应体带上 `waveId`，目前只有文字 message，需要扩展返回结构）。
4. 涉及文件：`app/api/orders/[id]/route.ts`（409 响应体加 `waveId` 字段）、`app/[locale]/classic/operator/orders/[id]/page.tsx`（`handleWithdraw` 改造）。

### C. 支持已出发订单撤回（高风险，建议单独验收，不与 A/B 同批发布）
5. 扩展 `ALLOWED_TRANSITIONS.IN_DELIVERY` 增加 `PENDING`。
6. 新增副作用逆转逻辑（参考现有 `CANCELLED` 分支已有的 IN_DELIVERY 库存回补先例）：
   - 库存回补：复用现有 `restoreLotsFIFO` + `qtyOnHand.increment`（`CANCELLED` 分支已验证过这段代码路径对 `IN_DELIVERY` 有效）。
   - **Trip 修正（新工作，无先例）**：从 `trip.restaurants` JSON 里精确摘除该订单所属的 stop/orderIds 条目，而不是像现有 `CANCELLED` 分支那样把整个 Trip 状态改掉（那样会误伤同车其他还在正常配送的订单）。若该订单是所在 stop 唯一的订单，整个 stop 要删除；若 Trip 因此变空，Trip 本身要处理（取消或标记异常）。
   - 波次归属：从 `PickingWave.orderIds` 中移除（`dispatchedAt` 已经打上，需确认 `removeOrderFromAllWaves` 现有实现是否会被"已出发锁"拦下，大概率需要新分支绕开 `WaveDispatchedError`）。
   - `DeliverySlip`：已生成的送货单如何处理（作废/保留待重新生成）需要产品决策。
   - 司机提成：确认目前冻结点在 `COMPLETED`，`IN_DELIVERY` 阶段未冻结，理论上不需要解冻逻辑，但需要在实现时用真实数据再核实一遍（不能只信代码注释）。
7. 涉及文件预估：`app/api/orders/[id]/route.ts`、`lib/wave-assign.ts`、`lib/trip-from-wave.ts`（或新增 `lib/trip-adjust.ts`）、`app/[locale]/classic/operator/orders/[id]/page.tsx`、可能还有调度台 `dispatch-console` 侧的展示同步。

## Schema 设计

不新增字段、不改现有枚举值（`IN_DELIVERY → PENDING` 只是在白名单 `Set` 里加一项，不动 `schema.prisma`）。

## 路由清单（改动/新增）

| 方法 | 路径 | 改动 |
|---|---|---|
| PUT | `/api/orders/[id]` | ALLOWED_TRANSITIONS 加 `IN_DELIVERY→PENDING`（C）；409 响应体加 `waveId`（B）；新增 IN_DELIVERY 撤回的 Trip/波次逆转逻辑（C） |
| （前端）| `app/[locale]/classic/operator/orders/[id]/page.tsx` | 面包屑动态化、加 Confirm 按钮（A）；`handleWithdraw` 二次确认联动解锁（B） |
| 无新增 API 路由 | — | B/C 都复用现有 `pick-unlock`、`unassign` 等接口，只是编排方式变化 |

## 风险点

1. **A/B 风险低**：只涉及 1 个前端文件 + 1 个后端文件的局部改动，不碰状态机白名单（B 只是编排现有两个已存在的 API 调用），不影响其他页面。
2. **C 风险高，是本次真正的"大改"**：
   - Trip.restaurants JSON 精确摘除单笔订单，此前系统里**没有先例代码**，容易和项目已知的 "Order.driverSlotId ↔ wave.orderIds 两套真相" 分裂问题（`[[data-ownership-audit-20260624]]`）撞在一起，改不好会产生新的孤儿数据。
   - `IN_DELIVERY` 意味着司机可能已经在路上/已经把货卸了一部分，业务上"退回报价单重新编辑"是否还合理，需要和你确认这不是纯技术决策，而是业务流程要不要允许这么做。
   - 一旦允许 `IN_DELIVERY→PENDING`，`CANCELLED` 分支里"直接整 Trip 作废"的旧逻辑很可能也要跟着重新设计（避免两条撤销路径行为不一致）。
3. 建议：**A+B 本次一起做完、验证、单独提交部署**；**C 单独立项**，先确认业务上"已出发订单允许退回"这件事本身要不要做、允许到什么程度（比如只允许司机还没开始这一站配送时），再进入技术方案设计，避免为一个可能被业务规则否掉的场景先背上高风险代码。

## 验证清单

- A：切到英文/中文界面，分别在 PENDING（未发送）/PENDING（已发送）/CONFIRMED/WAVE_ASSIGNED/CANCELLED 状态下打开 `orders/[id]`，确认面包屑高亮与右上角徽章一致；PENDING 状态下点 Confirm 能重新变回 CONFIRMED 且停留原页。
- B：找一个所在波次已打印锁定的 CONFIRMED/WAVE_ASSIGNED 订单，点撤回触发 409 走二次确认解锁+撤回联动，确认成功后波次侧 `pickLockedAt` 确实被清空且订单确实变 PENDING。
- C（待启动时另行制定）：需要构造"已出发波次含多张订单"的测试场景，验证撤回一张不影响同车其他订单的 Trip 记录。

---

## 确认结果（2026-09-05）

用户确认范围：**A + B**，C 另立项暂不做。

## 完成情况（2026-09-05）

A + B 已实现并在本地（本地 Neon 开发库，测试账号 operator13）用 Playwright 实测验证，均通过：

- 改动文件：`app/[locale]/classic/operator/orders/[id]/page.tsx`（面包屑动态化、加 Confirm 按钮、`handleWithdraw` 联动解锁）、`app/api/orders/[id]/route.ts`（409 响应体加 `waveId`）、`lib/api.ts`（`ApiError` 新增 `details` 字段，让前端能读到 409 响应体里除 `error` 外的其余字段）。
- **额外发现并顺带修的一个正确性缺口**：新加的 Confirm 按钮如果不做信用冻结校验，会绕开 `quotations/[id]` 页原有的"信用冻结不可确认"闸门（后端本来就没有校验，纯前端 UI 层把关）。已照抄同一套 `creditInfo`/`canOverrideCredit` 逻辑加到这个按钮上，并用一张有逾期欠款的客户订单实测确认按钮正确变灰、`title` 提示欠款原因。
- 验证记录：
  - PENDING（未发送）单据：面包屑正确高亮"报价单"，与右上角"待处理"徽章一致（此前是硬编码永远显示"销售单"）。
  - 点 Confirm → 徽章变"已确认"，面包屑同步跳到"销售单"，原地刷新不跳转。
  - 点"撤回到报价单" → 徽章变回"待处理"，面包屑回到"报价单"，Confirm 按钮重新出现——闭环验证通过。
  - 信用冻结客户：Confirm 按钮正确禁用，`title` 显示"有逾期欠款 €1542.87，账期已超"。
  - 波次已拣货锁定的 `WAVE_ASSIGNED` 单据：点"撤回到报价单" → 后端 409 → 前端自动二次确认 → `POST /api/waves/[id]/pick-unlock` 200 → 重试 `PUT /api/orders/[id]` 200；数据库复核波次 `pickLockedAt` 已清空、`orderIds` 已移除该订单、订单状态变 `PENDING`。
  - 英文界面（`/en`）下面包屑（Quotation/Quotation Sent/Sales Order）、Confirm/Delete 按钮文案与高亮逻辑均正确。
- `npx tsc --noEmit` 全量通过，无类型错误。
- C（已出发订单撤回）未动，维持 DEV-PLAN 里的建议：需要先确认业务上是否允许，再单独立项设计 Trip/波次数据结构的逆转方案。
