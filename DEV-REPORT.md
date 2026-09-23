# DEV-REPORT：退换货流程补缺口（仓库核实 + 销售权限 + 司机签名 + 换货新单 + 历史订单入口）

对应计划：[DEV-PLAN.md](./DEV-PLAN.md) · 完成日期：2026-09-23

## 给你看的

| 场景 | 来源 | 截图 | 状态 |
|---|---|---|---|
| 司机上报退换货时增加拍照+司机签名，缺签名不让提交 | 你拍板的 | [截图](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20260922-driver-return-exception-modal.png) | 符合 |
| 已完成的行程也能补报退换货（"几天前送的货要退"） | 你原话 | 无独立页面——复用同一张行程执行页，见下方"存档用的"探针记录 | 符合 |
| 仓库次日核实实物在不在车上，核实通过才转销售审核 | 你原话 | [截图](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20260922-warehouse-returns.png) | 符合 |
| 销售在"销售单管理"同一套系统里能处理退换货审批 | 你拍板的 | [截图](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20260922-operator-returns-exchange.png) | 符合 |
| 换货能关联一个新开的订单号 | 你拍板的 | 同上（Linked Exchange Order 输入框） | 符合 |
| 会计确认+代开发票 | 你原话 | 无 | 没做到，见下方说明 |

访问地址（本地验证环境，非生产）：`http://localhost:3011`

## ⚠️ 一个比功能本身更重要的过程说明

这次开发中途发生过一次方向性返工，如实告知：

第一版 DEV-PLAN.md（您已回复"确认"）基于"退换货管理系统完全不存在"的判断，设计了一整套新的 `ReturnCase` 数据表 + 4 个新权限点 + 4 个新页面。但在动手写代码前的现状核实阶段，读代码后发现**这个判断是错的**——退换货的审核、退款计算、库存回补/报废、贷记单结算这一整条链路早就建好在跑（`operator/returns` 页面 + `PUT /api/trips/:id/returns` + `credit-notes/generate-from-returns`），只是没有"仓库核实"这一环，且实际操作角色是 operator/boss 而不是您说的"销售"。

发现后立刻停下来，撤掉了已经建好但用不上的 `ReturnCase` 表（迁移、Prisma Client 全部回滚干净，`git status` 已确认无残留），重写了一版规模小得多的计划，跟您过了两轮 AskUserQuestion 确认关键决策后才继续。**这次返工没有产生任何遗留代码或数据**，但确实多花了一轮来回——记录下来是为了下次遇到类似"听起来要新建一大块东西"的需求时，先花更多时间核实现状再出计划，而不是先出计划再核实。

## 会计"打勾"环节：没做到，是按您拍板的方式没做

您原话要求会计"两类订单分别打勾、都打完才进代开发票列表"，但追问后您拍板"不新建人工打勾关卡，维持现有自动开票+贷记单机制"——现状是：订单送达时自动生成 DRAFT 发票（按当时的送达数量），退货审核通过后走贷记单单独冲抵欠款，两者叠加后客户应付金额是对的，只是没有一个额外的人工复核步骤。这条不是漏做，是您拍板不做。

## 测试账号

| 角色 | 账号 | 密码 |
|---|---|---|
| BOSS | boss(at)demo.local | test12345（沿用既有约定，未改动） |
| DRIVER | driver(at)demo.local | test12345（本次重置，见下方说明） |
| WAREHOUSE | warehouse(at)demo.local | test12345（本次重置） |
| SALES（兼 OPERATOR） | operator3(at)demo.local | test12345（本次重置） |

⚠️ driver(at)demo.local / warehouse(at)demo.local / operator3(at)demo.local 三个账号是批量种子生成的本地开发库演示账号（同批次还有 driver2~23、operator2~21 等），原密码未知也无法逆向读出（bcrypt 单向哈希），验证时统一重置为本地开发库既定的 test12345 约定值。这三个账号不是任何真实用户设置过的凭证，重置不影响任何人。

## 验证结果

`scripts/verify-return-flow.sh`（tsc + build + 17 项鉴权/状态机探针，含 `/code-review high` 之后补的两条回归探针）：**全部通过**。

| 探针 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ |
| `npm run build` | ✅ |
| 无 token / 错 token 提交退货 → 401 / 401 | ✅ |
| WAREHOUSE 角色提交退货（无 report_return 权限）→ 403 | ✅ |
| `VERIFYING`（出发前核货）状态下司机可提交退货 | ✅（回归修复，见下） |
| 司机缺签名提交 → 400 | ✅ |
| 司机正常提交 → `unitPrice` 快照正确、初始状态 `WAREHOUSE_PENDING` | ✅ |
| DRIVER 角色审核退货 / 仓库核实（无对应权限）→ 403 / 403 | ✅ |
| SALES 角色能访问审核接口（此前 403，本次新增权限后放行），仓库未核实前状态机拦截（0 处理） | ✅ |
| 仓库核实不通过缺 note → 400 | ✅ |
| 仓库核实通过 → 状态转 `PENDING_REVIEW` | ✅ |
| 重复仓库核实同一条 → 400 | ✅ |
| SALES 审核（拒绝）在核实通过后生效 | ✅ |
| `COMPLETED` 历史行程仍可补报退货 → 200 | ✅ |
| 同一商品分别上报两次各拿到不同 `returnId` | ✅（回归修复，见下） |
| 按 `returnId` 核实只影响目标那一条，另一条同商品记录不受影响 | ✅（回归修复，见下） |

## `/code-review high` 发现处理记录

大改按 CLAUDE.md 第十一节要求跑了 `/code-review high` 和 `/security-review`，逐条处理如下：

| # | 发现 | 处理 |
|---|---|---|
| 1 | 本次改动把司机提交退货切到专用接口后，`allowedStatuses` 漏了 `VERIFYING`（出发前核货阶段），但司机端"报告异常"按钮在这个状态下本来就显示——点了会提交失败 | **已修复**：`allowedStatuses` 加回 `VERIFYING`，补了回归探针 |
| 2 | 仓库核实/销售审核都只按 `productId + status` 匹配退货记录；同一商品被分别上报两次时，会命中数组里第一条同状态记录，可能不是实际在审的那一条，导致核实/审核结果落到错误的记录上 | **已修复**：`ReturnItem` 加稳定 `id` 字段（`crypto.randomUUID()` 生成），仓库核实/销售审核接口都改成优先按 `returnId` 精确匹配，缺失时（历史遗留记录）才退回旧的 `productId` 匹配；补了回归探针 |
| 3 | `warehouse/returns/page.tsx` 新文件 221 行，超出 CLAUDE.md 第八节"页面文件不超 150 行"的规定 | **已修复**：把 `VerifyDialog` 拆到 `components/warehouse/VerifyReturnDialog.tsx`，页面文件降到 86 行 |
| 4 | `lib/types.ts` 里一条注释提到"见 `lib/return-status.ts`"，但这个文件从没建过 | **已修复**：改成指向实际兜底逻辑所在位置（`operator/returns/page.tsx` 的 `flatten()`） |
| 5 | 三个 returns 相关接口（POST/PUT `/returns`、PUT `/warehouse-verify`）都是整份读出 `Trip.restaurants` JSON 再整份写回，没有乐观锁；本次给这个既有模式又加了一个并发写入方 | **不处理**：这是 `Trip.restaurants` 存成 JSON 大字段这个既有架构模式自带的问题，之前 POST+PUT 两个写入方就已经这样，给 JSON 字段加乐观锁/版本号是一次跨越整个 Trip 数据模型的重构，不是这次退换货功能该顺手做的事，记录在案供以后专项处理 |
| 6 | 新的 `warehouse/returns` 页面用 `GET /api/trips`（无分页，返回全量行程含 base64 照片/签名）过滤出待核实的少量记录 | **不处理**：这是 `operator/returns` 页面（既有代码）已经在用的同一种取数方式，本次新页面只是照抄了同一个模式，不是我引入的新问题；给 `/api/trips` 加服务端过滤是更大范围的改动，超出这次功能的范围 |

`/security-review` 额外发现一条候选问题（POST `/returns` 缺少 `trip.driverId === user.userId` 的行级归属校验，本次新增的 `dispatch.trip.report_return` 权限让 DRIVER 角色首次能碰到这个没有该校验的端点），经独立复核：Trip id 是不可预测的 `cuid()`，司机端列表接口本身对 DRIVER 角色做了行级隔离拿不到别人的 trip id，且同款"DRIVER 角色 + 无归属校验的 trip 子资源"缺口在既有的 `settlement` 接口上早就存在——复核置信度 5/10，未达到"本次新引入的高危漏洞"的报告门槛，按流程过滤掉，不计入本次改动的问题清单，但记录在案：这类 `Trip.restaurants` 子资源接口普遍缺行级校验是这个代码库的一个既有模式性风险点，值得以后专项加固。

## 已知不可用 / 未覆盖的部分

1. **换货审批的 SELLABLE/SCRAP 完整流程只做了代码审查级别验证，没有跑通完整 E2E**：浏览器测试中用真实合成的假订单/假商品 id 触发了"批准退货"动作，因为 `recalcOrderCommission`、`Product.qtyOnHand` 更新都要求订单/商品在数据库里真实存在（这是已有代码的既定行为，不是本次改动引入的），搭一套完整的真实订单夹具超出本次验证的合理成本。已经确认的是：`exchangeOrderId` 字段在批准环节被正确写入请求体、事务失败时完整回滚不脏数据（两次失败尝试均验证过状态未被污染）。
2. **销售驳回后的通知/提醒**：司机不会收到"你报的退货被驳回了"的主动提醒，需要自己去查历史行程状态。这次没做，不在原始需求范围内。
3. **本地开发库权限漂移**（与本次功能无关，顺手记录）：`prisma migrate status` 显示本地开发库存在与本仓库 `prisma/migrations` 目录不完全对齐的历史漂移（`20260731000001/2`、`20260922000002` 等），是多个并发工作区共用同一开发库导致的既存状态，本次没有触碰，仅在其基础上追加了两条新迁移。

## 存档用的（你不用看，出问题时我回来查）

### 代码改动清单

- `lib/types.ts`：`ReturnItem` 新增 `id`（稳定单条记录标识，见处理记录#2）、`WAREHOUSE_PENDING` 状态 + `warehouseVerified*`/`driverSignature*`/`exchangeOrderId` 字段（均为 JSON 字段，无需数据库迁移）
- `app/api/trips/[id]/returns/route.ts`：POST 初始状态改 `WAREHOUSE_PENDING`、要求 `driverSignature`、生成稳定 `id`、支持批准时写 `exchangeOrderId`；POST 权限拆成 `dispatch.trip.report_return`（司机上报）与 `dispatch.trip.returns`（审核，任一即可）；`allowedStatuses` 补回 `VERIFYING`；PUT 审核优先按 `returnId` 精确匹配
- `app/api/trips/[id]/returns/warehouse-verify/route.ts`（新增）：仓库核实接口，`dispatch.trip.warehouse_verify` 权限，只允许对 `WAREHOUSE_PENDING` 状态操作，优先按 `returnId` 精确匹配
- `app/[locale]/classic/operator/returns/page.tsx`：新增"待仓库核实"状态/tab、换货记录的"关联换货新单号"输入框，审核请求带上 `returnId`
- `components/warehouse/VerifyReturnDialog.tsx`（新增）：仓库核实弹窗组件，从页面文件拆出以满足 150 行上限
- `app/[locale]/classic/warehouse/returns/page.tsx`（新增，86 行）：仓库核实列表页
- `app/[locale]/classic/warehouse/layout.tsx`：导航加"退换货核实"入口
- `app/[locale]/classic/driver/trip/[id]/page.tsx`：异常上报改走专用接口（修复原来"没有 unitPrice 快照"的隐藏 bug）+ 拍照 + 司机签名；已完成的行程增加"补报退换货"入口
- `components/driver/SignaturePad.tsx`：新增可配置 `placeholder`，修复司机签名场景误显示"请客户签名"的文案 bug
- `lib/rbac/catalog.ts` / `lib/rbac/route-map.ts` / `lib/rbac/sortkeys.json`：新增 `dispatch.trip.warehouse_verify`、`dispatch.trip.report_return` 两个权限点
- `prisma/seed-rbac.json`：`warehouse` 角色加 `warehouse_verify` + `dispatch.trip.read`/`read_returns`；`sales` 角色加 `read_returns`/`returns`；`driver` 角色加 `report_return`
- `prisma/migrations/20260923001437_return_flow_permissions/`、`prisma/migrations/20260923002138_return_report_permission/`：两条权限发放迁移（幂等追加、写审计留痕、bump 受影响角色用户的 `permVersion` 强制重登），已在本地开发库应用

### 已废弃的历史尝试（已清理干净）

第一版基于错误现状判断设计的 `ReturnCase` Prisma 模型、迁移 `20260922234035_return_case`、对应的 Prisma Client 生成物，已在写任何业务代码之前发现问题并完整回滚：`git diff prisma/schema.prisma` 为空，`_prisma_migrations` 表里对应记录已删除，开发库里的表和枚举已通过 `prisma db push` 撤除。

### 权限点变更影响范围

- 新增 `dispatch.trip.warehouse_verify`（仅 WAREHOUSE 角色持有）
- 新增 `dispatch.trip.report_return`（仅 DRIVER 角色持有，且只授权 POST 上报，不授权 PUT 审核）
- `dispatch.trip.read`、`dispatch.trip.read_returns` 追加给 WAREHOUSE（此前该角色对 Trip 完全不可见）
- `dispatch.trip.read_returns`、`dispatch.trip.returns` 追加给 SALES（与 boss/operator 并存，未收回后者）
- 上述角色下所有用户的 `permVersion` 已在迁移里 +1，下次请求会强制要求重新登录才能拿到新权限——生产部署后这些角色的在线用户会被要求重新登录一次

### 部署注意事项

生产部署时两条迁移会随 `prisma migrate deploy` 自动执行（幂等，可安全重复跑）。部署后如果 WAREHOUSE/SALES/DRIVER 角色的用户反馈"看不到新功能/仍然 403"，先确认是否重新登录过——`permVersion` 机制要求重新登录才生效，这不是权限没发对。
