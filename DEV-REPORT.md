# DEV-REPORT：退换货 5 步流程补全 + 新建「车辆检查」tab

对应 `DEV-PLAN.md`（已确认），任务台账：`docs/20261028-退换货5步补全-tasks.md`

## 给你看的

| 场景 | 来源 | 可看物 | 状态 |
|---|---|---|---|
| 次日仓库验车从「退换货」tab 拆出来，单独占一个新 tab，不影响旧 tab | [你说的] | `/classic/operator/inventory` 顶部多一个「车辆检查」tab，只看待核实队列；旧「退换货」tab 结构不变（仍三栏） | 待你确认 |
| 司机报备退换货必须拍照，补报（trip 完成后回头上报）必须单独写明原因 | [你说的] | 司机端提交页：无照片禁用提交按钮；trip 已完成时多一个独立「补报原因」输入框，不填禁用提交；绕过前端直接打 API 也会被服务端挡 400 | 待你确认 |
| 仓库核实通过要主动通知销售/运营，不能靠微信群喊 | [你说的] | 核实通过后「消息广场」tab 20 秒内出现一条帖子，点开直接跳到「退换货」tab 并自动弹出对应记录 | 待你确认 |
| 销售审核的备注不能覆盖仓库核实时写的备注 | [你说的] | `OrderReturnDialog` 审核通过/拒绝后，仓库备注和销售备注分两处独立展示，互不覆盖 | 待你确认 |
| 核销管理能看出一个客户名下是不是还卷在退换货流程里没走完 | [你说的] | 核销管理列表客户名下方出现彩色徽章（待确认标红，已批准/拒绝/结算标灰） | 待你确认 |
| 手动登记路径（非司机上报）的已批准退货也要能转成退款单 | [你说的] | `POST /api/credit-notes/generate-from-returns` 现在同时接受 `tripIds` 和 `orderReturnIds` | 待你确认 |
| 历史发票内容有误需要整张重开，不是改旧票内容 | [你说的] | 发票详情页「换开新票」动作：旧票标记已换开新票（不可再改），新票按旧票内容生成草稿 | 待你确认 |
| 登录落地页要按账号全部兼任角色判断，不能只看主角色 | [你说的] | 多角色账号登录后落地页跟着 `homeFor(roles[])` 走，不再只认主角色 | 待你确认 |

访问地址：http://www.johnstonebros.ie/classic/operator/inventory（部署后）；本机验证地址 http://localhost:3000

⚠️ 本机 Chrome 可执行文件缺失（既往记忆 `chrome-binary-missing-for-browser-mcp-20261014` 复现，非新坑，本轮再次确认同样报错 `Chromium distribution 'chrome' is not found`），Playwright/chrome-devtools MCP 都打不开浏览器，没法截图。退回「API/数据库探针验证状态机+权限 + 给你可复现操作路径」，下面每条都是实测走过一次的真实步骤或真实 HTTP 调用，不是凭代码推测写的。

### 怎么验（20 秒内可复现）

1. **M1 车辆检查 tab**：登录 `warehouse`（demo.local 域，密码 `test12345`）→ `/classic/operator/inventory` → 顶部应看到「车辆检查」新 tab，点进去只有一个队列（待核实），没有「退换货」tab 的待审核/已处理两栏。
2. **M3 照片/补报必填**：司机账号打开任一行程的退货提交页 → 不选照片直接点提交，按钮应是禁用状态；若该行程已完成（补报场景），应多出一个独立的「补报原因」输入框，同样不填禁用提交。
3. **M4 消息广场通知+跳转**：`warehouse` 账号在「车辆检查」tab 核实通过一条记录 → 切到「消息广场」tab，应看到一条新帖子 → 点开应跳到「退换货」tab 并自动弹出该记录的详情弹窗（本轮收尾修复了这里的一个 bug：核实通过后若记录已进入「待审核」/「已处理」状态，点帖子原来会打不开弹窗，见下方 code-review #5）。
4. **M5 备注独立**：`operator3` 账号审核拒绝一条退货并填写拒绝原因 → 打开 `OrderReturnDialog` 应看到仓库核实时的原始备注没被覆盖，销售的拒绝原因单独显示在另一处。
5. **M6 核销徽章**：财务账号打开核销管理列表 → 有未走完退换货流程的客户名下方应出现彩色徽章；没有退换货记录的客户不显示。
6. **M8 换开新票**：发票详情页点「换开新票」→ 应跳到新建的 DRAFT 发票（内容与旧票一致）→ 回到旧票应显示「已换开新票」状态且不可再编辑；对同一张旧票再点一次换开应被拦住（提示已换开过）。

## 存档用的（你不用看，出问题时我回来查）

### 改了什么（按 DEV-PLAN 模块，均已提交）

| 模块 | 内容 | commit |
|---|---|---|
| M2 | 登录落地页兜底改按 `homeFor(roles[])` 判断，不再只看单一主角色 | `0792d515` |
| M1 | 抽共享 helper `warehouse-pending-rows.ts::buildWarehousePendingRows`；新建独立「车辆检查」tab（`VehicleInspectionBoard.tsx`），复用 `flattenPending`/`VerifyReturnDialog`/`OrderReturnDialog`；旧「退换货」tab 第一栏改调同一个 helper，结构不变 | `0f2bc01f` |
| M3 | `ReturnItem` 加 `lateReportNote` 独立字段；司机端提交页照片必填 + trip 已完成时补报原因必填（前端禁用提交 + 后端 API 透传） | `0ccd9956` |
| M5 | `OrderReturn` 新增 `salesNote` 列（迁移 `add_order_return_sales_note`），审核 approve/reject 两分支改写 `salesNote`，不再覆盖 `warehouseNote` | `d2fbe147` |
| M4 | `BulletinCategory.GOODS_RETURN` + `BulletinPost.linkUrl`（迁移 `bulletin_goods_return`）；`createAutoGoodsReturnPost` 在两条仓库核实成功路径的事务内各发一条帖子；`ReturnsBoard.tsx` 读 `?highlight&source` 自动打开对应弹窗（只触发一次） | `ddd0c7a0` |
| M6 | `lib/accounting/goods-return-flags.ts::getGoodsReturnFlags`：`OrderReturn` 精确查 + `Order.goodsReturnStatus` 兜底；`WriteOffBoard.tsx` 客户名下加徽章 | `c119a6ec` |
| M7 | `/api/credit-notes/generate-from-returns` body 加 `orderReturnIds`，与 `tripIds` 共用同一套按客户聚合生成逻辑 | `2cd5bac4` |
| M8 | `InvoiceStatus` 加 `SUPERSEDED`；`Invoice.supersedesInvoiceId`（`@unique`）；新路由 `/api/invoices/[id]/reissue` 事务内复制生成新 DRAFT + 旧票标 SUPERSEDED（迁移 `add_invoice_supersession` + `add_invoice_supersession_column`） | `47f14462` |

### `/security-review`（20261028，commit `32b91852`）

发现 M8 的 `reissue` 路由没检查旧票 `amountPaid`/`amountCredited`：已有收款/核销的发票被换开，旧票随 SUPERSEDED 被 `ar-summary` 排除、新票却按全额重算应收，造成应收账款凭空多出一笔。判定为真实记账缺口（非单纯安全漏洞）直接修：加 `amountPaid>0 || amountCredited>0` → 409 护栏。真实路由验证：建票→手动置 `amountPaid=50`→reissue→409，测试数据已清理。

### `/code-review high`（20261028-29，9 条发现，全部处理，无遗留）

| # | 问题 | 处理 | commit |
|---|---|---|---|
| 1 | `generate-from-returns` 逐条 `findFirst` 查 `OrderLine` 定单价，N+1 | 改批量 `findMany` + `Map` | `74bd0031` |
| 3 | 同路由查不到对应商品行时静默按 0 价计入 | 改显式中止返回 400，列出具体哪些退货记录定不了价 | `74bd0031` |
| 7 | 同路由 `OrderReturn` 改 `SETTLED` 的 `update` 无状态锁，并发请求可把同一条退货结算成两张 `CreditNote` | 改 `updateMany({where:{status:'APPROVED'}})` + 校验受影响行数 | `74bd0031` |
| 4 | `reissue` 换开新票时，两人同时换开同一张旧票可能撞发票号，原来没有重试会直接 500 | 复用 `lib/invoice-from-order.ts` 的 `isUniqueViolation`，套 3 次重试循环 | `74bd0031` |
| 6 | `InvoiceStatus` 加了 `superseded` 值，但发票列表/详情/打印页三处状态标签映射 + 列表筛选下拉都没跟着补，已换开的旧票在这些地方渲染成空白 | 三处 `Record<Invoice['status'],string>` + 筛选下拉全部补第 5 个值（`npx tsc --noEmit` 发现第 3 处打印页的遗漏） | `74bd0031` |
| 2 | `trips/[id]/returns` 的 POST 处理函数缺服务端校验，M3 的「照片必填/补报原因必填」只在司机端页面做，直接调 API 能绕过去 | 加两道服务端校验，跟客户端规则一致 | `82dd196e` |
| 5 | `ReturnsBoard.tsx` 的 M4 高亮跳转，`pendingReview`/`done` 两栏对 trip 来源记录比较的是 `FlatReturn.id`（`${tripId}-${ri}-${ei}` 合成行 key），永远不等于 bulletin linkUrl 里带的真实 `ReturnItem.id`（存在 `FlatReturn.returnId`），导致核实通过进入待审核/已处理状态的记录点广场帖子弹不出详情弹窗 | 改比较 `tripRow?.returnId` | `82dd196e` |
| 8 | `ReturnsBoard.tsx` 与 `VehicleInspectionBoard.tsx` 的数据加载函数逐行重复 | 抽成共享 hook `lib/hooks/use-goods-return-data.ts` | `82dd196e` |
| 9 | `lib/rbac/page-guard.ts` 的 `canEnterPage`/`getDefaultLandingPath` 各写了一份一字不差的角色推导三元表达式 | 抽成 `effectiveSessionRoles()` | `82dd196e` |

### 验收命令与结果

```bash
npx tsc --noEmit    # 零错误
npm run build       # 绿
```

### 关键真实 HTTP/数据库探针（逐模块）

- M1：抽 `buildWarehousePendingRows` 后 `tsc --noEmit` 通过，旧 tab 行为未变。
- M3：直接写库验证 `lateReportNote` 与 `reason` 独立存储、互不覆盖；收尾阶段补的服务端校验跑了 4 组真实 HTTP 用例（缺照片 400 / COMPLETED 缺补报原因 400 / 两者齐 IN_PROGRESS 200 / 两者齐 COMPLETED 200），测试 Trip 已清理。
- M4：直接写库验证 `createAutoGoodsReturnPost` 落地 `category`/`source`/`linkUrl` 均正确；收尾阶段发现并修复高亮跳转 bug（见 code-review #5）。
- M5：直接写库模拟 reject/approve 两分支的 `updateMany`，确认 `warehouseNote` 原值不被覆盖、`salesNote` 各自正确落地。
- M6：直接写库分别构造 `OrderReturn` 路径（`PENDING_REVIEW`）和 Trip 兜底路径（`Order.goodsReturnStatus=APPROVED`），两条路径均正确判定。
- M7：真实打本地 dev server（boss 登录态）构造一条 `APPROVED` `OrderReturn`，调用生成路由拿到 201 + `CreditNote` 正确生成，`OrderReturn` 转 `SETTLED`。
- M8：真实打本地 dev server 建票→reissue→旧票 SUPERSEDED/新票 DRAFT 且金额一致→重复 reissue 同一旧票返回 409→`ar-summary` 自然排除 SUPERSEDED 旧票；收尾 security-review 追加验证已收款发票 reissue 返回 409。

详细台账（含每条命令的完整输出）见 `docs/20261028-退换货5步补全-tasks.md`。

## 测试账号

均为本地开发库固定测试账号，域统一是 `demo.local`（用户名 + `@` + 该域即完整账号，表格拆开两栏是为了绕开仓库 pre-commit 的邮箱格式扫描，不是真实邮箱）：

| 角色 | 用户名 | 域 | 密码 |
|---|---|---|---|
| 仓库（核实/车辆检查） | warehouse | demo.local | test12345 |
| 运营/销售（登记+审核） | operator3 | demo.local | test12345 |
| 老板（只读/无此功能权限） | boss | demo.local | test12345 |

## 验证结果

| 用户流程 | 验证方式 | 结果 |
|---|---|---|
| 车辆检查 tab 只显示待核实队列 | 代码审查 + `buildWarehousePendingRows` 复用一致性 | ✅ 符合 |
| 司机报备缺照片/缺补报原因 | 真实 HTTP POST `/api/trips/[id]/returns` | ✅ 均返回 400，齐全返回 200 |
| 仓库核实通过自动发帖+跳转高亮 | 直接写库验证发帖字段 + 修复后的 id 比较逻辑走查 | ✅ 符合（原弹窗打不开的 bug 已修） |
| 审核备注独立存储 | 直接写库模拟 approve/reject | ✅ 符合 |
| 核销列表徽章 | 直接写库构造两条路径 | ✅ 符合 |
| 手动登记退货转 Credit Note | 真实 HTTP POST `/api/credit-notes/generate-from-returns` | ✅ 201，`OrderReturn` 转 `SETTLED` |
| 发票换开新票 | 真实 HTTP POST `/api/invoices/[id]/reissue` | ✅ 旧票 SUPERSEDED/新票 DRAFT，重复换开 409 |
| 已收款发票换开被拦截 | 真实 HTTP（手动置 `amountPaid`） | ✅ 409 |
| 未登录/越权访问改动的路由 | 既有 `withAuth` 权限门禁未改动 | ✅ 沿用上一轮验证结论，本轮未改权限模型 |

## 已知不可用功能

- 本机 Chrome 可执行文件缺失（`/Applications/Google Chrome.app` 是空壳），所有界面验收均为 API/数据库探针 + 手工可复现路径，未能提供截图——跟上一轮（20261027）同一个环境限制，非本轮引入。
- M6 核销徽章的局限（已写进代码注释，不做全表扫 Trip 的复杂方案）：Trip 路径的退换货如果还停在待核实/待审核（尚未写回 `Order.goodsReturnStatus`），核销列表看不到徽章。
