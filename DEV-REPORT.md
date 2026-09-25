## 给你看的

| 场景 | 来源 | 验证方式 | 状态 |
| --- | --- | --- | --- |
| 一个页面搞定钱和单，不再分三个入口 | 你："最好是在一个页面里完成……1.钱……2.单……不要搞得多出几个概念来" | 浏览器实测：`/classic/accounting` 单页含「钱」「单」两板块，`/classic/finance/settlements`、`/classic/finance/driver-reports` 已 404 | 符合 |
| 钱：系统自动算，会计核对后确认，不用司机先报 | 你：同上 | 浏览器实测：钱板块按司机汇总现金/转账，无需任何司机端提交动作 | 符合 |
| 单：扫码两步核销（先选中，再确认） | 你："先选中标记，会计再点一次确认才真正核销" | 浏览器实测：扫码后进入「待确认」态，需再点「确认核销」才变「已核销」 | 符合 |
| Return = 单据有问题退回司机核实 | 你："单据有问题要退回司机核实（东西少了/字迹不清等）" | 浏览器实测：「退回核实」要求填写问题说明，落成「有问题」态并显示说明文字 | 符合 |
| 钱确认这次要真入账 | 你："这次一并改成真入账" | 浏览器实测：点确认后真实生成 Payment、核销发票至 PAID，数据库逐字段核对一致 | 符合 |
| 页面叫「会计核销」不叫「司机结算」 | 你："不应该叫司机结算，还应该叫会计核销" | 页面标题、导航链接文案均为「核销管理/会计核销」 | 符合 |
| 司机端不再需要交账/对账 | [我推断的] | 浏览器/代码实测：`/classic/driver/settlement` 已删除，司机导航不再有交账链接；执行前查证 Trip 完成/提成冻结另有独立触发路径，不受影响 | 符合 |
| 钱确认不可撤销 | [我推断的] | 浏览器实测：确认后无撤销按钮，二次点击返回 409 且未重复入账 | 符合 |

访问地址：`http://localhost:3000/classic/accounting`（本地起服务后访问，生产地址部署后另行验证）

## 存档用的（你不用看，出问题时我回来查）

### 技术验收

- `npx tsc --noEmit`：通过（提交前复跑，含 findings 修复后的改动）
- `npm run build`：通过，新路由 `GET/POST /api/accounting/driver-cash(/confirm)` 出现在路由清单，旧路由（settlement/driver-reports）已消失
- `npx prisma migrate status`：up to date（新增 2 个迁移：`20260924000001_order_return_status_and_driver_cash_confirmation`、`20260924000002_accounting_writeoff_permissions`）
- `npm test`：910/913 通过，1 个失败（`pricing-override.test.ts` 缺 `ABCT` 客户测试夹具）与本次改动无关，为共享开发库既存环境问题；2 个 skip 是同一夹具的连带。`scripts/audit/role-reachability.json` 快照已按 findings #1 的修复重新生成（`POST /api/orders/bulk [FINANCE] n → y`，理由见下方 findings）
- 鉴权探针：`/api/accounting/driver-cash` 与 `/confirm` 无 token → 401（三条 curl 实测）；RBAC 可达性矩阵实测确认 FINANCE 能真正走通 `/api/orders/bulk` 的 `mark_returned`（findings #1 修复前实测是 403，修复后浏览器 + 矩阵双重确认为可达）
- 入账幂等探针：浏览器实测对同一司机+业务日重复调用 confirm，第二次返回 409，Payment 表未产生第二条记录
- 生产库核实：`Payment` 表当前 0 条记录（SSH 实测），findings #5 的历史数据误判风险不成立
- `/code-review high`（8 个视角）与 `/security-review`：见下方 findings，4 条已修复、1 条核实无影响、5 条记入技术债

### 已处理的 findings

`/code-review high`（8 个视角）+ `/security-review`（独立子任务两轮去伪存真）跑完，逐条处理如下：

**已修复：**

1. **[致命] `/api/orders/bulk` 权限闸门修复不完整，FINANCE 进不了核销功能** — `lib/rbac/route-map.ts` 那层外层闸门已加 `finance.write_off.confirm`，但 `app/api/orders/bulk/route.ts:388` `withAuth(..., { require: 'sales.order.bulk_import' })` 是**第二道独立闸门**，之前漏改，FINANCE 请求会在进 handler 前就被这里拦成 403——本次改动要解决的核心功能（会计核销）对 FINANCE 角色实际是坏的。已改成 `require: ['sales.order.bulk_import', 'finance.write_off.confirm', 'finance.write_off.return']`，内层按 action 精确判定（70-83 行）不变。`scripts/audit/role-reachability.json` 快照已更新（`POST /api/orders/bulk [FINANCE] n → y`），浏览器实测 + 独立 security-review 子任务复核（置信度 9/10）确认修复正确。
2. **WriteOffBoard 在钱板块首次请求失败时会永久卡在"加载中"** — `businessDate` 只能靠 `DriverCashBoard` 请求成功后回调拿到，若那次请求抛错，`WriteOffBoard` 初始 `loading=true` 且早退路径（`if (!businessDate) return`）不会置 false，永久转圈无提示。已改：`DriverCashBoard` 加错误提示 + 重试按钮；`WriteOffBoard` 初始 `loading` 改 `false`，并为"还没等到日期"加独立提示文案，不再跟真正的空数据混在一起。浏览器实测正常路径无回归。
3. **legacy seed 脚本仍写已删除的 `orderReturn` 列** — `prisma/legacy-seeds/{seed-orders-stock,seed-transactions}.ts` 因在 tsconfig 里被排除，`tsc` 测不出来，单独跑会因 Prisma "Unknown argument" 崩溃。已改成写 `returnStatus`。
4. **`mark_returned` 审计日志丢了 `returnStatus` 的 before 值** — 原来 `before` 查询没选 `returnStatus`，日志只有 after，查不出订单之前是什么状态。已补上。

**已核实无实际影响，不需要改：**

5. **`Payment.note` marker 从 `TRIP:` 改成 `DRIVER_CASH_CONFIRM:`，理论上会让历史司机交账记录被误判成"手动"** — 3 个 code-review 视角独立指出。已连生产库核实（`sudo -u postgres psql -d veggie`）：`Payment` 表当前 **0 条记录**，交账机制这几周虽然代码上线但从未真正被调用过一次，没有历史数据需要回填，这条发现不构成实际风险。

**记录为已知限制，本次不处理（原因见下）：**

6. **入账非原子，`DriverCashConfirmation` 在 `postCollections` 之前创建**，若中途失败会永久卡在"已确认但没完全入账"，且唯一约束会挡住重试——4 个 code-review 视角独立指出，同一处代码位置。DEV-PLAN 风险点 1 已明确接受"确认即不可撤销、写错走人工冲正"这个大前提；非原子这个具体问题是复用自旧 Trip 结算机制的既有风险（旧代码同样的顺序），不是本次新引入，修复需要重构 `postCollections` 的事务边界，超出本次改动范围，记入技术债，建议下次单独立项处理。
7. **DriverCashBoard 只能看"今天"，没有补录漏掉历史日期的入口**（API 已支持 `?date=`，UI 没做）。这是本次刻意收窄范围的设计取舍（DEV-PLAN："会计一天跟一个司机对一次账"），记入下一步观察项。
8. **`/api/analytics/logistics` 仍读已冻结的 `Trip.cashCollected/onlineCollected`**，数字永远停在改动前的值；这几个字段和 `DriverDailyReport` 表留在 schema 里成为死字段。记入技术债。
9. **`mark_returned` 批量更新没有并发状态守卫**（两个会计同时操作可能互相覆盖），概率低，且是全站批量操作的既有模式，不在本次范围内单独修。
10. **代码质量类清理建议**（`incTaxAmount` 三处重复定义、€ 金额格式化 5 处没走 `lib/format-money.ts`、`ACCENT` 颜色硬编码四处、driver-cash 两个路由查询/分组逻辑重复、confirm 路由未按司机过滤导致每次点确认都全量重算当天订单、两个组件各自独立请求同一天数据、`onUndo`/`onReopen` 同义双名props、`applyCardFilter` if/else 链可以换成查表）——均为质量/效率层面，不影响正确性，记入技术债，建议后续小改一次性清理。

**security-review：** 0 条高置信度发现（新路由全参数化查询、金额服务端重算、鉴权三层内部一致、无 `dangerouslySetInnerHTML`）。

### Schema 变更

- `Order.orderReturn`(Boolean) → `Order.returnStatus`(枚举 PENDING/RETURNED/ISSUE) + `Order.returnIssueNote`(String?)，同一迁移文件内完成加列/回填/删旧列
- 新表 `DriverCashConfirmation`（司机 × 业务日唯一），记录钱板块确认状态与生成的 Payment id

### RBAC 变更

- `finance.settlement` 模块瘦身：去掉 `create`（司机不再需要提交），改名义为「司机收款确认」
- 新增 `finance.write_off` 模块：`read`/`confirm`/`return`，取代 `/api/orders/bulk` 内部原先硬编码的角色判断
- 顺带修复：`/api/orders/bulk` 外层闸门此前只挂 `sales.order.bulk_import`，FINANCE 角色一直够不到这个接口（核销核心动作实际上从未对纯 FINANCE 角色生效过）；本任务当时只改了 `lib/rbac/route-map.ts` 这一层，`app/api/orders/bulk/route.ts` 里 `withAuth` 自己的第二道 `require` 闸门当时漏改，是 `/code-review high` 才挖出来的（见下方 findings #1），提交前已补完两层
- 迁移已回写 `prisma/seed-rbac.json`、`lib/rbac/sortkeys.json`、`lib/rbac/parity-baseline.json`、`scripts/audit/role-reachability.json`，并对受影响角色（boss/operator/finance/driver）下全部用户 bump `permVersion` 强制重新登录

### 下线清单

页面：`/classic/finance/settlements`、`/classic/finance/driver-reports`、`/classic/driver/settlement`
API：`/api/trips/[id]/settlement`、`/api/driver-reports/**`
组件/lib：`components/finance/DriverReconTable.tsx`、`components/driver/DailyReportCard.tsx`、`lib/driver-daily-report.ts`、`lib/driver-reconciliation.ts`
测试/探针：`tests/driver-reconciliation.test.ts`、`scripts/audit/{finance-confirm,driver-reconciliation,driver-daily-report,statement-settlement}-test.ts` 及对应 `package.json` 的 4 条 `test:*` 脚本

均已核实生产库这两条流水线从未真正跑完过一次（Trip 从未 `settlementStatus=confirmed`、`DriverDailyReport` 表 0 条），删除不造成功能回退。

### 技术债 / 已知限制

1. **钱板块入账不可撤销**：`postCollections` 没有冲正机制，会计点错了没法一键撤销，需要走人工冲正（这是复用原有入账逻辑本身的限制，非本次新增）。
2. **单板块的「批次/司机」列在极少数场景可能显示「未分配」**：当订单的司机分配信息只落在 `driverSlotId` 关系而未经过 wave 派生（`deliveryBatchDisplay`）时，`/api/orders?include_lines=false` 的精简查询不带 `driverSlot` 关联；生产里司机分配的真实来源是 wave 派生值，不受此影响，仅在个别边缘数据下会看不全，属已知的小限制，不影响核销主流程。
3. **顺带修复但未过度扩展**：`app/[locale]/classic/operator/orders/page.tsx` 里一处 `orderReturn` 只读展示同步改成 `returnStatus === 'RETURNED'`，未改动其显示文案（原文案「有退货」语义上更像是产品退货而非送货单核销，是否要改措辞留给你判断，这次不在范围内不动它）。
4. `scripts/audit/` 下与旧交账/对账相关的一次性人工审计脚本已删除 4 个，其余提及 settlement 关键字的脚本（如 `scripts/rbac/derive-system-roles.ts`）是历史存档性质（记录改造前的系统状态用于一次性推导），故意不动。
5. **入账非原子**：`DriverCashConfirmation` 在 `postCollections` 之前创建，中途失败会卡在"已确认但没完全入账"且无法重试（4 个 code-review 视角独立指出，详见 findings）。不可撤销是 DEV-PLAN 已接受的设计，非原子是复用旧机制的既有风险，本次不重构，留给下次单独立项。
6. **钱板块只能看"今天"**，没有补录漏掉历史日期的 UI 入口（API 已支持 `?date=`）。这是本次刻意收窄的设计取舍，视真实使用中是否成为问题再决定要不要加日期选择器。
7. `/api/analytics/logistics` 仍读已冻结的 `Trip.cashCollected/onlineCollected`（这两个字段和 `DriverDailyReport` 表本身已是死字段，只是没删），该分析页那个"交账差异"数字会永远停在改动前的值。
8. 若干代码复用/效率类清理项（`incTaxAmount` 三处重复、€ 金额格式化未走 `lib/format-money.ts`、driver-cash 两个路由查询逻辑重复、confirm 路由未按司机过滤导致每次全量重算当天订单等），详见 findings，不影响正确性，留作后续小改。

### 下一步

- 找一个真实业务日观察「钱」板块入账结果是否符合会计预期（尤其是历史欠款冲抵逻辑，这条路径本次未在生产数据上跑过）
- 视情况决定是否需要把 `/classic/operator/orders` 页面那处「有退货」标签的措辞也理清楚（本次未动）
- 技术债 5-8 项视使用中是否真的成为问题，决定要不要单独立项处理
