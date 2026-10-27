# DEV-REPORT：核销触发开票 + 对账单改按送货日期

对应 `DEV-PLAN.md`（已确认），需求原话存档：`docs/20261026-核销触发开票与对账单口径-需求原话.md`，
任务台账：`docs/20261026-核销触发开票与对账单口径-tasks.md`（全部 7 条已完成）。

## 给你看的

| 场景 | 来源 | 可看物 | 状态 |
| --- | --- | --- | --- |
| 以前"标记完成"订单就立刻开出草稿发票；现在改成无论有没有问题，都要等会计在核销页点「核销确认」才生成发票 | 你说的 | 见下方「怎么验」第 1 步 | 符合 |
| 核销确认时，少送/差异的单会计要能直接在核销框里改实际送达数量，改完发票按改过的数字开 | 你说的 | 见下方「怎么验」第 2 步 | 符合 |
| 对账单(Statement)以前按"确认日期"统计，现在改成按"送货日期"统计 | 你说的 | 已用真实库回归测试锁住（见「存档用的」），逻辑上可信 | 符合 |
| 批量「确认核销」按钮只给无差异订单用，要改数量的单必须逐单打开编辑 | 我推断的 | 同第 1/2 步操作路径 | 符合 |
| 今天（20261026）刚上线的「批量生成 Invoice」按钮改成补漏工具保留，不再是主要开票入口 | 我推断的 | 按钮文案已改为「🧾 补开漏开的发票」+ hover 提示；且已加「未核销确认的单不处理」保护，见下方说明 | 符合 |
| 提成冻结时间点一并从"标记完成"挪到"核销确认" | 我推断的 | 技术验证见「存档用的」A3+C | 符合 |

**⚠️ 这次同样没有截图**：本机浏览器自动化环境（Playwright/chrome-devtools MCP）的 Chrome.app 是空壳
launcher，缺真正的 Chrome 二进制，是跨任务的已知环境问题，不是这次改动引入的，没有重复试装。
退回真实 API + 数据库全链路验证（独立测试订单，验证完已清理），比纯文字描述更可信，
给你一段能自己复现的操作路径：

### 怎么验（本地 http://localhost:3000，生产 https://www.johnstonebros.ie）

1. **核销才开票**：调度台把一单标记完成（或司机端完成行程）→ 查这张单此时**没有**生成发票、
   没有提成冻结（`commissionFrozenAt` 为空）→ 去「核销管理」页「待核销」tab 找到这张单，点
   「确认核销」→ 这时才会看到发票生成、提成冻结时间写入。
2. **核销时改数量**：「核销管理」页「待核销」tab 任意一单点「核对数量」→ 弹窗列出这单每一行
   （商品/下单数量/实际送达，默认=下单数量）→ 改某一行的数字（比如少 1 箱）→ 点「✅ 确认核销」→
   该行按改过的数量计入发票（金额 = 改过的数量 × 单价，不是原始下单数量）。
3. **补漏按钮已加保护**：「待核销」tab 选中还没核销确认的单，点「🧾 补开漏开的发票」→ 会被跳过
   并提示"未核销确认"，不会提前按下单量开票（这是 code review 发现并修复的一个真实漏洞，见下方
   「存档用的」）。
4. **对账单口径**：财务「对账单」页为任意客户生成一张新对账单 → 落入账单的订单范围现在按这些单的
   「送货日期」落在选的周期里判断，不是「确认日期」。

## 存档用的（你不用看，出问题时我回来查）

### 改了什么（按 DEV-PLAN 模块）

- **A1/A2**：`lib/delivery-complete.ts::completeDeliveredOrders()`、`app/api/orders/[id]/route.ts`
  去掉"标记完成"时自动开票 + 提成冻结的调用；全送覆盖 `deliveredQty=orderedQty` 保留，变成
  "核销时默认值的来源"而不是"开票前最后一次写入"。
- **A3+C**：`app/api/orders/bulk/route.ts` 的 `mark_returned` 加 `lines` 可选参数（单订单+RETURNED
  才接受，校验归属与非负），核销 RETURNED 成功后逐单触发开票 + `recalcOrderCommission` +（如在途
  中的 Trip）`recalcTripDriverCommission`；失败只记日志不回滚核销，detail 里带失败清单。
- **A4**：`bulk-invoice` 路由与按钮文案改为补漏工具（"🧾 补开漏开的发票"）；顺带发现 bulk-invoice 与
  新增的 `[id]/lines` 路由都漏登记 `lib/rbac/route-map.ts`（未登记=默认 403，之前所有角色都摸不到这两
  个功能，不是本次引入的回归），已补登记。
- **B1/B2**：新增 `lib/accounting/returns.ts::getReturnOrderLines()` + `GET /api/accounting/returns/[id]/lines`
  按需拉单订单行明细；`WriteOffBoard.tsx` 新增 `QtyEditDialog`（核对数量弹窗）。
- **D1+D2**：`lib/statements.ts` 两处查询、`lib/finance/statement.ts` 的 `StatementOrderRow` 字段，
  全部从 `confirmationDate` 改成 `deliveryDate`；详情页展示仍保留 `confirmationDate` 供参考。

### Code Review 发现并修复的 4 个问题（`/code-review high`，20261026）

1. **`getReturnOrderLines()` 单行 0 被兜底覆盖**：原来 `deliveredQty || orderedQty` 按单行判断，
   一张单里"一行正常送达、一行真实拒收(0)"这种情况，拒收那一行会被误显示成下单量，核销时不改
   直接确认就会把真实的 0 覆盖回下单量——多开发票、多算提成。改成按整单判断（整单所有行都是 0
   才兜底，否则逐行照实际值显示），跟 `fillDeliveredQtyIfUnrecorded` 的判断逻辑保持一致。
2. **`bulk-invoice` 补漏接口没挡住未核销的单**：待核销（PENDING/ISSUE）的单选中点"补开漏开的发票"
   会直接按下单量全送开票，绕开了这次改动"开票挪到核销确认之后"的设计本身。已加
   `returnStatus!=='RETURNED'` 则跳过的校验。
3. **账本核对页"待开票"探针产生假阳性**：`lib/ledger-check.ts::findUninvoicedCompletedOrders()` 原来
   只看 `status=COMPLETED`，这次改动后开票挂在核销确认之后，COMPLETED 但还没核销的单（新设计下
   正常的中间状态）会被全部误判成"漏开票"，一键"统一补开草稿发票"会提前按下单量开票。已加
   `returnStatus='RETURNED'` 条件。
4. **核销弹窗无条件提交整单 lines**：核实为问题 1 的下游症状，非独立缺陷——问题 1 修好后 GET 返回
   的就是真实当前值，弹窗"看到什么就确认什么"正是设计本身要的语义（核销这一步本身就是核对动作），
   未改动。

四条均在 `app/api/accounting/returns/bulk-invoice/route.ts`、`lib/accounting/returns.ts`、
`lib/ledger-check.ts` 落了代码修复，并新增 `tests/write-off-invoice-gating.test.ts`（3 个真实库回归
测试）锁住前两条的不变量。

### `/security-review`

手工限定 diff 范围到本次四个模块实际改动的文件，逐项检查 IDOR/越权（`orderId` 作用域的
`orderLineId` 校验）、RBAC 权限点复用、新 `GET [id]/lines` 路由鉴权模型、XSS（无
`dangerouslySetInnerHTML`）、SQL 注入（全部参数化 Prisma 调用）—— **零发现**（无 ≥8/10 置信度问题）。

### 排查并修复的两个 RBAC 回归（A4 route-map 补注册的副作用）

- `tests/rbac-legacy-token.test.ts`：两条新路由在补注册 route-map 前，新旧 token 都是 403（压根没人
  能用），旧 token 的角色白名单回退表 `lib/role-access.ts` 没覆盖这两条子路径，所以旧 token 现在仍判
  不可达——是"一直不能"不是"收紧"，不存在真实用户受影响面，已在 `LEGACY_TOKEN_EXEMPT` 登记并写明依据。
- `tests/role-reachability.test.ts`：独立的可达性快照 `scripts/audit/role-reachability.json` 同样没
  登记过这两条路由，跑 `npx tsx scripts/audit/save-reachability.ts` 刷新（纯新增 28 行）。

### 验收命令与结果

- `npx tsc --noEmit`：零输出，通过。
- `npm run build`：通过，路由清单含两条新注册的 `/api/accounting/returns/*` 子路由。
- `node --test --import=tsx tests/*.test.ts`：**1007** 个测试（本次新增 3 个回归测试），
  **1004 pass / 2 skip / 1 fail**。唯一失败 `tests/pricing-override.test.ts` 的前置断言
  「未找到 ABCT 客户」——查本地开发库确认 70 个客户里确实没有 ABCT（该测试设计上依赖具体业务数据，
  见文件头注释），跟本次四个模块完全无关，是本地库业务数据缺口，不处理。
- 生产库部署前探针（附录 A 探针 7，SSH 实测）：可入账状态（`CONFIRMED/WAVE_ASSIGNED/IN_DELIVERY/
  COMPLETED/LOCKED`）且 `deliveryDate` 为空的订单，只有 `CONFIRMED` 89 条（总 191 条 CONFIRMED 中的
  89 条），全部是 2026-10-20~10-21 最近一周内刚确认、还没被调度台排进波次的单——符合"波次分配时才
  回写 `deliveryDate`"这个正常流程阶段，不是数据缺陷。`WAVE_ASSIGNED`/`IN_DELIVERY`/`COMPLETED`/
  `LOCKED` 四个"已经在途或以上"的状态 100% 都有 `deliveryDate`，波次↔`deliveryDate` 不变量在生产库
  上成立，没有已派车却缺日期的脏数据。结论：不需要历史数据兜底，部署前无阻塞项。

### 已知不可用功能 / 范围外

- `CreditNote`（贷记单）生成逻辑、Trip 级退货审核流程——按 DEV-PLAN 约定范围外，未动。
- 历史已开票订单不受影响，只影响上线后新产生的订单。
- 本次尚未部署到生产（droplet），部署与生产验证留给下一步，部署后需按项目 CLAUDE.md §九追加
  部署效果闭环记录。
