# DEV-PLAN：退换货流程补缺口（仓库核实 + 销售权限 + 司机签名 + 换货新单 + 历史订单入口）

## 读取的文档

无独立产品文档。需求来自 2026-09-22 用户口述完整业务流程 + 两轮 AskUserQuestion 拍板（共 5 条决策）。已存档：`docs/20260922-司机端退换货结算流程-需求原话.md`。

## ⚠️ 本计划是对同一天早些时候一版 DEV-PLAN 的推翻重写

早些时候基于"退换货系统完全不存在"的误判，设计了一整套新的 `ReturnCase` 数据模型 + 4 个新权限点 + 4 个新页面。用户已对那版计划回复"确认"，但在动手前的现状核实阶段（读代码，不是臆测）发现：**这套系统的审批/退款/库存/结算大半早就建好在跑了**。已经把误建的 `ReturnCase` 表、迁移、Prisma Client 全部撤回（`git status` 已确认 `prisma/schema.prisma` 干净），没有留下任何垃圾代码。这是本次唯一的一次方向性返工，后面不会再有。

## 现状核实（这次是真的查到底了）

已经建好、在生产可用的部分：
- **司机上报**：`POST /api/trips/:id/returns`（专用接口，含照片、`status='PENDING_REVIEW'`、`unitPrice` 自动从订单行取快照）
- **审核 + 退款 + 库存**：`app/[locale]/classic/operator/returns/page.tsx` + `PUT /api/trips/:id/returns`。批准/拒绝、退款按比例或固定金额、货物去向（`SELLABLE` 回补库存走 FIFO / `SCRAP` 计入损耗仪表盘）、`OrderLine.deliveredQty` 联动扣减、司机提成 `recalcOrderCommission` 重算——全部在一个事务里做完
- **会计结算**：`POST /api/credit-notes/generate-from-returns`。把 `APPROVED` 状态的退货按客户合并，生成 `CreditNote`（贷记单）冲抵欠款，退货记录标记 `SETTLED`。这就是"退货造成的金额调整"现有的落地方式——不是改原发票，是另开一张贷记单冲抵，财务上等价且改动面更小

权限现状：`dispatch.trip.returns`（审核动作）只挂给 `boss`/`operator`，**`sales` 角色没有**——尽管 `operator/returns` 页面自己画的流程图上写的是"Salesperson"。这是本次要调整的第一条。

真正缺失、需要新建的（用户已就前两条拍板）：

1. **仓库核实这一环完全不存在**。现状是"司机报了 → 直接进 operator/boss 审核"，没有你说的"次日仓库核对实物在不在车上"这道门。
2. **销售角色没有审核权限**（已拍板：加给 `SALES`，与 `boss`/`operator` 并存，不收回后者）。
3. **司机没有单独签名**，只有客户签（已拍板：司机也手写签一次）。
4. **换货没有"新开单"关联动作**，现在换货和退货走同一套审批（已拍板：换货这次要能关联一个新开的订单号）。
5. **没有"历史订单退换货"入口**——但后端接口本身已支持对着一张早就 `COMPLETED` 的历史行程提交退货（`allowedStatuses` 里就含 `COMPLETED`），缺的只是司机端一个"查我以前送过的行程"入口，**不需要改后端**。
6. **顺手修一个隐藏 bug**：司机端 `driver/trip/[id]/page.tsx` 的异常上报（`submitException`）现在是直接改本地 `Trip.restaurants[].returns` 再整份 `PUT /api/trips/:id`，没有走专用的 `POST .../returns`——导致提交的退货记录**没有 `unitPrice` 快照**，审核时如果按"比例"退款会算成 0（除非审核人手动切到"固定金额"模式手输）。这次改成调用专用接口，顺带补上拍照采集（现有 UI 会显示 `ret.photo` 但从来没人写过这个字段）。

已拍板不做的：
- 不新建 `ReturnCase` 或任何新表——`ReturnItem` 已经是 `Trip.restaurants[].returns` 里的 JSON 数组，加字段不需要迁移。
- 不新建会计"打勾"人工关卡——现有自动开票 + 贷记单冲抵机制已经财务等价，维持现状。

---

## 模块拆解

### 1. `ReturnItem` 类型扩展（`lib/types.ts`，纯 TS 类型，JSON 字段不需要 migration）

新增字段：
- `warehouseVerifiedById?`, `warehouseVerifiedByName?`, `warehouseVerifiedAt?`, `warehouseNote?`
- `driverSignature?`, `driverSignedAt?`
- `exchangeOrderId?`（换货关联的新订单 id）
- `status` 联合类型增加 `'WAREHOUSE_PENDING'`，作为司机上报后的**新初始状态**（原来直接是 `PENDING_REVIEW`）

### 2. 仓库核实：新增专用接口 + 页面

- 新增 `PUT /api/trips/:id/returns/warehouse-verify`，body `{ restaurantId, productId, action: 'verify'|'reject', note? }`。`verify` → 状态转 `PENDING_REVIEW`（自然流入现有 operator/returns 审核队列，不用改审核那部分代码）；`reject` → 状态转 `REJECTED`，同时记录 `warehouseNote`。只允许对 `WAREHOUSE_PENDING` 状态的记录操作，非法状态 400。
- `POST /api/trips/:id/returns`：新提交的退货状态改成 `WAREHOUSE_PENDING`（原来是 `PENDING_REVIEW`）。
- `operator/returns` 页面：过滤/排除 `WAREHOUSE_PENDING` 状态的记录（未经仓库核实的不该出现在销售审核队列里），状态筛选 tab 增加"待仓库核实"计数展示（只读，不可操作，避免用户以为漏了数据）。
- 新增页面 `app/[locale]/classic/warehouse/returns/page.tsx`：列出 `WAREHOUSE_PENDING` 的记录，展示司机照片/原因/签名/所属客户，操作"核实通过"/"核实不通过"（要求填写原因）。挂进 `warehouse/layout.tsx` 现有的 `LINKS` 导航。
- 新增权限点 `logistics.return.warehouse_verify`，挂给 `WAREHOUSE` 角色（`page.warehouse.access` 该角色已有，是活跃角色）。

### 3. 销售角色获得审核权限

- `prisma/seed-rbac.json`：给 `sales` 角色的 `permissions` 数组追加 `dispatch.trip.read_returns`、`dispatch.trip.returns`（复用现有权限点，不新建）。
- `operator/returns` 页面目前挂在 `operator` 路由下，`SALES` 角色进不去这个 URL——检查 `sales` 相关 layout 的角色白名单，把这个页面的路由也加进 `sales` 布局可达范围（或在销售模块导航里加一条链接指向同一个页面，不复制代码）。

### 4. 司机端改动（`driver/trip/[id]/page.tsx`）

- `submitException` 改成调用 `POST /api/trips/:id/returns`（专用接口），不再本地拼 `Trip.restaurants[].returns` 再整份 `PUT`——顺带修好"没有 unitPrice 快照"这个 bug。
- 异常上报 modal 增加拍照环节（`<input type="file" accept="image/*">` 转 base64，同 POD 上传的做法）。
- 增加"司机签名"步骤：复用 `SignaturePad` 组件，紧跟在异常提交表单里（不是客户签，是司机自己签一次，证明"我确认上报了这条"）。

### 5. 换货关联新单（`operator/returns` 审核 Dialog）

- `ReviewDialog`：当 `item.actionType === 'exchange'` 时，批准环节增加一个输入框"关联的换货新单号"（写入 `exchangeOrderId`），只做记录关联，不做强绑定校验（不检查这个单号是否真实存在，销售自己填对）。

### 6. 历史订单退换货入口（司机端新页面）

- 新增 `app/[locale]/classic/driver/returns/page.tsx`：列出该司机名下所有 `COMPLETED` 状态的历史 `Trip`（不限今天），选中后进入一个精简版执行页（复用 `driver/trip/[id]` 的"报告异常"弹窗逻辑，隐藏签收/收款等已经完成的动作），调用同一个 `POST /api/trips/:id/returns`。
- `driver/page.tsx`（司机任务列表首页）加一个入口链接过去。

### 7. RBAC 配套

- 新权限点 `logistics.return.warehouse_verify`：写入 `prisma/seed-rbac.json`（新建 `logistics.return` 模块，挂给 `warehouse`）、`lib/rbac/route-map.ts`（登记 `PUT /api/trips/*/returns/warehouse-verify`）、`lib/rbac/catalog.ts`（登记模块，否则是"配置页上看不见的假权限点"）、`lib/rbac/sortkeys.json`（跑 `sync-sortkeys.ts`）。
- `sales` 角色追加已有的两个权限点：只改 `seed-rbac.json` 的 `sales.permissions` 数组，不用动 `route-map.ts`（路由已经按权限点匹配，不按角色）。
- 两处改动都要 bump `permVersion`（角色-权限映射变了，已登录用户的 JWT 位图不会自动刷新，需要强制重登生效）。

---

## 风险点

1. **`operator/returns` 页面的 `flatten()`/`buildReturnProfile()` 默认值处理**：现在 `ret.status` 缺失时默认当 `PENDING_REVIEW`；改成新增 `WAREHOUSE_PENDING` 状态后，要确认所有默认值兜底逻辑没有漏改（否则历史遗留的、状态本来就缺失的旧数据会被误判成"待仓库核实"或"待销售审核"，需要用一条迁移脚本把**已存在的旧退货记录**（这次改动前提交的，状态非空的那些）保持原状，只有新提交的才走 `WAREHOUSE_PENDING`——不回填历史数据。
2. **`sales` 角色能不能看到 `operator/returns` 页面**取决于该路由所在 layout 的角色白名单，执行时需要先读一遍 `operator/layout.tsx` 的门禁逻辑确认怎么开口子，不是只加权限点就够。
3. **历史订单退换货页面**要做行级隔离：司机只能看到自己驾驶过的 Trip（`driverId` 过滤），不能翻别的司机的历史行程。

---

## 附录 A：技术验收标准（`scripts/verify-return-flow.sh`）

- `npx tsc --noEmit`、`npm run build`
- 鉴权探针：`logistics.return.warehouse_verify` 用「无 token / 错 token / 无该权限角色（如 SALES）」调用仓库核实接口，断言 401/401/403
- 权限生效探针：`SALES` 角色调用 `PUT /api/trips/:id/returns`（审核）此前应 403，加权限后应 200
- 状态机探针：`WAREHOUSE_PENDING` 状态下直接调用审核接口（跳过仓库核实）应 400；`PENDING_REVIEW`/`REJECTED`/`SETTLED` 状态下调用仓库核实接口应 400
- `unitPrice` 快照探针：走新的司机提交接口创建一条退货，断言 `unitPrice` 非空且等于订单行单价
- 历史行程探针：对一张 3 天前 `COMPLETED` 的 Trip 提交退货，断言成功且状态为 `WAREHOUSE_PENDING`
- 旧数据兼容探针：迁移脚本跑完后，此前已存在的、状态非空的退货记录状态不变（不会被误判成 WAREHOUSE_PENDING）

---

## 需要您判断的场景清单

- [你说的] 司机送货正常完成要有电子签名+拍照上传。（已有，不改）
- [你说的] 到店有异常/退回几天前的货，司机要能记录，仓库次日核实实物，销售决定处理方式并审批，会计确认。
- [你拍板的] 司机也要手写签名。
- [你拍板的] 换货新发的货走新开一张单。
- [你拍板的] 一次性做完整条链路，不分阶段。
- [你拍板的] 销售角色加审核权限，与 operator/boss 并存，不收回。
- [你拍板的] 会计打勾环节不新建，维持现有自动开票+贷记单机制。
- [我推断的] 换货的"关联新单号"只做文本记录，不做强绑定校验——如果您希望能直接从审核弹窗里跳转/创建那张新单，而不是手填单号，请告诉我，这个改动会更大一些。

## 一次性告知

**假设清单**：
- 历史订单退换货页面不允许查看/操作不是自己送过的行程（行级隔离），如果需要跨司机查询（比如司机离职了，客户还要退当时的货），这次不做，需要另外走运营后台的 `operator/returns` 处理。
- 仓库核实"不通过"只做一次性打回（状态转 `REJECTED`），不做多级申诉。

回复"确认"后我不再就实现细节打断你。
