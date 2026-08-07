# 可配置权限体系 —— 设计与任务台账

> 生成：2026-08-07 · 需求来源：用户 2026-08-06 提出的两条重新规划需求之二
> 前置：`docs/20260806-rbac-audit-and-tasks.md`（T1–T8 已完成的三层防护整改）
> 关联：另一条「灵活数据分析 + 提成考核」需求见 `docs/20260807-flexible-analysis-requirements.md`，本次不做

---

## 0. 需求原文（用户 2026-08-06）

> 权限管理：销售这块，客户在网站下单、APP 下单；外聘销售员输入订单；办公室销售员输入订单，
> 他们也输入购进单；级别高一点的销售不仅管销售，还直接负责采购；销售经理负责销售、采购、司机。
> 仓库经理负责卸货、质量检查、配货和出库、库存管理。办公室销售只有特定人员可操作配送中心和打印中心。
>
> 权限管理要有权限管理的配置页面，能配置角色，能配置用户，能配置权限，配置功能模块。

---

## 1. 现状与差距

8/6 刚完成一轮 RBAC 整改，机制齐备但**角色是硬编码的**：`enum Role` 12 个写死在
`prisma/schema.prisma`，权限矩阵写死在 `lib/permissions.ts`，路由边界写死在
`lib/role-access.ts`。加一个岗位 = 改代码 + 迁移 + 部署。

| 需求里的岗位 | 现有角色 | 差距 |
|---|---|---|
| 客户网站/APP 下单 | `RESTAURANT` | ✅ 已有客户门户 + 行级隔离 |
| 外聘销售员（录订单） | `EXTERNAL_SALES` | ✅ 8/6 拆出，已有行级隔离 |
| 办公室销售（录订单 + 录购进单） | `SALES`（19 人全兼 `OPERATOR`） | ⚠️ 无「采购录入」权限点 |
| 高级销售（销售 + 直接负责采购） | 无 | ❌ 缺 |
| 销售经理（销售 + 采购 + 司机） | 无 | ❌ 缺 |
| 仓库经理（卸货/质检/配货出库/库存） | `WAREHOUSE`/`PICKER`/`SORTER` 三个割裂 | ⚠️ 无聚合层 |
| 办公室销售中**特定人员**可用配送中心+打印中心 | 无 | ❌ 缺 —— 个人级例外，纯角色模型表达不了 |

---

## 2. 已定决策（2026-08-07，用户拍板）

| # | 决策 | 理由 |
|---|---|---|
| 1 | **角色可建，权限点代码枚举**（Odoo 模型） | 页面上建一个代码不认的权限点毫无作用，反而制造「配了但不生效」的假象 |
| 2 | **12 个硬编码角色当种子数据导进去，权限点成唯一真相** | 双轨并存正是本项目反复踩的坑（`driverSlotId`↔wave、`Order.items` 双存） |
| 3 | **数据范围三级：全部 / 团队 / 本人** | 「销售经理只看自己团队业绩」只能靠它；需给 `User` 加 `managerId` |
| 4 | **先平迁，账号重分配上线后在配置页自己调** | 19 个 SALES 兼 OPERATOR 怎么拆是业务决策，不阻塞技术改造 |
| 5 | **权限变更后强制受影响用户重新登录**，不做 `token_stale` 静默重签 | 实现简单；代价是用户被踢出，可接受 |

---

## 3. 数据模型

```prisma
enum DataScope { ALL  TEAM  OWN }

model AppRole {
  id          String     @id @default(cuid())
  code        String     @unique          // "sales_office" / "sales_manager"
  name        String                      // 显示名，可改
  description String?
  isSystem    Boolean    @default(false)  // 预置 12 个：不可删，权限可改
  dataScope   DataScope  @default(ALL)
  permissions String[]   @default([])     // 权限点 id，如 "sales.order.create"
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt
}

model UserRoleLink {
  userId String
  roleId String
  @@id([userId, roleId])
}

/// 个人级例外：granted=true 加权限，false 扣权限。解决「只有张三能进配送中心」
model UserPermissionGrant {
  userId       String
  permissionId String
  granted      Boolean
  @@id([userId, permissionId])
}

/// 代码目录的镜像，供配置页展示与外键校验。由部署时的同步脚本写入，页面不可增删
model Permission {
  id      String @id      // "sales.order.confirm"
  module  String          // "sales.order"
  action  String          // "confirm"
  labelZh String
  labelEn String
  sortKey Int             // 位图序号，一经分配不得重排
}

// User 新增字段
// managerId   String?   —— TEAM 范围靠它算下属
// permVersion Int @default(0) —— 权限变更后 bump，用于强制重登
```

**三条关键取舍：**

1. **代码是权限点的真相**，`lib/rbac/catalog.ts` 定义全部权限点，部署时同步进 `Permission` 表。
   代码里删掉的权限点，同步脚本连带从所有角色的 `permissions[]` 上摘掉。
2. **`dataScope` 挂角色不挂权限点**。多角色账号取**最宽**（19 个 SALES 兼 OPERATOR 取 ALL = 维持现状不断）。
   作用对象限定于有归属人的四类：订单、报价、客户、采购单。
3. **个人级例外用 `UserPermissionGrant` 而非再拆角色**，避免 `SALES_WITH_DISPATCH` 这类组合爆炸。

---

## 4. 权限点目录（模块划到业务对象级，不是页面级）

| 模块组 | 模块 | 动作 |
|---|---|---|
| 销售 | `sales.quotation` `sales.order` | read create update delete confirm cancel |
| 采购 | `purchase.order` | read create update **approve** receive |
| | `purchase.suggestion` `purchase.plan` | read manage |
| 库存 | `stock.receipt`(卸货收货) `stock.quality`(质检) `stock.pick`(配货出库) | read create confirm |
| | `stock.take` `stock.adjust` `stock.scrap` `stock.lot` `stock.zone` | read manage |
| 配送 | `dispatch.console` `dispatch.wave` `dispatch.trip` `dispatch.driver_slot` | access / read manage |
| 财务 | `finance.invoice` `finance.payment` `finance.statement` `finance.credit_note` `finance.settlement` | read create confirm |
| 档案 | `master.customer` `master.product` `master.pricelist` `master.supplier` `master.uom` | read create update delete |
| 分析 | `analytics.sales` `analytics.purchase` `analytics.margin` `analytics.logistics` `analytics.commission` | read |
| 打印 | `print.center` | access |
| 系统 | `system.user` `system.rbac` `system.backup` `system.settings` | read manage |

**岗位映射（批 4 建成预置模板，不自动分配给现有账号）：**

- **办公室销售** = `sales.*` 全 + `purchase.order.create`（能录不能批）+ scope `ALL`
- **高级销售** = 上述 + `purchase.order.update/approve/receive` + `purchase.suggestion.*`
- **销售经理** = 上述 + `dispatch.trip.*` `dispatch.driver_slot.*` `analytics.commission.read` + scope **`TEAM`**
- **仓库经理** = `stock.*` 全 + `dispatch.wave.read`
- **外聘销售** = `sales.*`，无 `finance.*`，无 `master.pricelist`，`master.customer` 只读 + scope **`OWN`**
- **配送中心 / 打印中心** = 独立权限点 `dispatch.console.access` / `print.center.access`，
  靠 `UserPermissionGrant` 发给特定人

---

## 5. 判定链路

**硬约束**：`middleware.ts` 跑在 Edge runtime，用不了 Prisma。8/6 审计结论是
**middleware 边界砍掉了一半可达格，逐路由补 `allowedRoles` 不够**，所以这一层不能丢。
=> 权限集必须进 token，且不能撑爆 cookie。

```
catalog 权限点有固定 sortKey → 用户权限集编码成 bitset
~120 个权限点 = 15 字节 → base64url 约 20 字符
JWT 新增三个字段：
  pm  权限位图 (base64url)
  ds  数据范围 (ALL|TEAM|OWN)
  pv  权限版本号 (User.permVersion)
```

四层判定读同一个位图：

| 层 | 位置 | 判什么 |
|---|---|---|
| middleware (Edge) | `lib/rbac/route-map.ts` | URL+方法 → 需要的权限点；位图里没有就 403。取代 `role-access.ts` |
| handler | `withAuth(req, h, { require: 'purchase.order.approve' })` | 纵深防御，取代 `allowedRoles` |
| 行级 | `scopeWhere(ctx, 'order')` 统一工具 | 按 `ds` 生成 where，取代散落的 if |
| 页面 | `can()` 对外 API 不变，内部改查位图 | 按钮显隐 |

**权限变更生效方式（已定：强制重登）**：改角色权限 → bump 受影响用户的 `User.permVersion`
→ 该用户下次请求时 handler 发现 `token.pv < user.permVersion` → 返回 401
→ 前端跳登录页并提示「权限已变更，请重新登录」。JWT 有效期 7 天不变。

---

## 6. 配置页面

就地扩 `/classic/operator/users`（已存在）成权限中心，三个 tab：

- **用户** — 列表/搜索 → 勾角色（多选）、设上级 `managerId`、加减个人级例外。
  每行显示「实际生效权限数」，点开是只读的合并结果，标出哪些来自角色、哪些来自例外。
- **角色** — 新建/复制/改名/删除；权限点按模块组树形勾选（父节点半选态）；选 dataScope。
  预置 12 个标 🔒 不可删但权限可改；删除前若有用户在用要列出受影响的人。
- **权限总览** — 角色 × 模块 只读全景矩阵，供肉眼核对。

**防锁死**：保存时校验「系统至少一个活跃用户拥有 `system.rbac.manage`」，否则拒绝并说明。
所有权限变更写 `ActionLog`（谁、何时、把谁的什么权限改成了什么）。

---

## 7. 明确不做（YAGNI）

- 不引入 CASL 等权限库（现有 `can()` 够用）
- 不做字段级权限
- 不做权限审批流
- 不做多租户 / 组织架构树（`managerId` 一层足够表达「团队」）
- 不做 `token_stale` 静默重签（已定：强制重登）
- 不动灵活数据分析需求（另一份文档）

---

## 8. 任务台账

> 一周期 = 一条任务：做 → 验证 → 提交 → 回写本表状态 → 下一条。
> **批 0 / 批 1 的「零 diff」是整个方案的安全绳** —— 它证明换了引擎但一格权限都没动。
> 之后再改权限，才是有意为之的变更。

### 批 0：基础设施（不改任何判定逻辑）

- [x] **T0 权限点目录 + Prisma 模型** ✅ 2026-08-07 · `355710e`
      新建 `lib/rbac/catalog.ts`：按 §4 定义全部权限点，每个带固定 `sortKey`（一经分配不得重排，
      位图靠它）。新增 `AppRole` / `UserRoleLink` / `UserPermissionGrant` / `Permission` 四张表，
      `User` 加 `managerId` / `permVersion`。
      **验收**：~~`npx prisma migrate status` 全部已应用~~ → 改为「一次性 PG 上实证可应用且完备」，
      理由见下；`npm run build` 通过；单测锁住「catalog 里 sortKey 无重复、无空洞」。
      **产出**：`lib/rbac/catalog.ts`、`lib/rbac/sortkeys.json`、`scripts/rbac/sync-sortkeys.ts`、
      `prisma/schema.prisma`、`prisma/migrations/20260807000000_rbac_configurable/`、
      `tests/rbac-catalog.test.ts`
      **依赖**：无

      **实测**：117 个权限点 / 11 模块组 / 52 模块；位图 15 字节 → base64url 20 字符
      （与设计预估一致，JWT 塞得下）。13 个单测通过，全量 278 测试 0 失败，`npm run build` 通过。

      **验收标准变更的理由**：本地 `DATABASE_URL` 指向 Neon（已非生产，生产在 droplet），
      对它跑 `migrate status`/`migrate deploy` 既无意义又有风险。改用等价且更强的验证：
      起一次性 PG → `db push` 出改动前结构 → 实跑迁移 SQL（退出码 0）→ 新 schema 反查
      `migrate diff` = **No difference detected**。实际应用交给部署流程的 `migrate deploy`。
      SQL 是纯新增（1 enum + User 2 列 + 4 表 + 6 索引 + 4 外键），无破坏性操作。

      **途中踩到的坑**：`migrate diff --from-migrations` 要在 shadow DB 重放全部历史迁移，
      `20260419_decimal_partner_indexes` 至今仍失败（P3006/P1014）—— 就是记忆里那个老坑。
      绕开办法：拿 git 里的旧 schema 与新 schema **直接 diff**，根本不需要 shadow 库。

      **发现的真实差异**：报价单没有独立 API，走 `/api/orders`。所以 `sales.quotation`
      只能是页面级权限点（只有 `access` 一个动作），已在 catalog 注释里写明，
      免得后人以为 API 层有对应的闸。

- [ ] **T1 反推脚本：现有权限 → 12 个预置角色**
      写 `scripts/rbac/derive-system-roles.ts`：从 `lib/permissions.ts` 的 `MATRIX`、
      `lib/role-access.ts` 的 `ROLE_API_SCOPE`/`ROLE_PAGE_SCOPE`、以及 117 处 `allowedRoles`
      （用 `lib/route-gate-scan.ts` 扫）三处**求交集**，推出每个角色实际拥有的权限点。
      三处不一致的地方要**列出来人工裁决**，不能默默取并集（取并集 = 放权，取交集 = 收权，都可能出事）。
      **验收**：脚本输出 12 个角色的权限点清单 + 一份「三处不一致」的差异报告；
      差异逐条有结论写进本文档 §9。
      **产出**：`scripts/rbac/derive-system-roles.ts`、`prisma/seed-rbac.ts`
      **依赖**：T0

- [ ] **T2 平迁验证：可达性零 diff（第一次）**
      用 T1 推出的角色权限，重算 `lib/role-reachability.ts` 的 235×12 可达性矩阵，
      与 `scripts/audit/role-reachability.json` 现有快照比对。
      **验收**：**diff 必须为空**。不为空则回到 T1 修正推导规则，不得直接改快照。
      **产出**：`scripts/rbac/verify-parity.ts`、比对报告
      **依赖**：T1

### 批 1：判定层切换（风险最高的一批）

- [ ] **T3 权限解析与位图编解码**
      `lib/rbac/resolve.ts`：`getEffectivePermissions(userId)` → 角色权限并集 ∪ 个人 grant
      − 个人 revoke，dataScope 取最宽。`lib/rbac/bitmap.ts`：编解码 base64url 位图。
      登录时写进 JWT 的 `pm`/`ds`/`pv`。
      **验收**：单测覆盖「多角色并集」「个人加权」「个人扣权」「dataScope 取最宽」四种组合；
      位图编解码往返一致；实测 token 长度增量 < 100 字符。
      **产出**：`lib/rbac/resolve.ts`、`lib/rbac/bitmap.ts`、`lib/auth.ts`、`tests/rbac-resolve.test.ts`
      **依赖**：T0

- [ ] **T4 middleware 改查位图**
      `lib/rbac/route-map.ts`：URL 前缀 + 方法 → 所需权限点。middleware 从 token 的 `pm`
      解位图判定，取代 `role-access.ts` 的角色白名单。
      ⚠️ **route-map 必须覆盖全部 48 个 API 域 + 89 个页面**，漏了就是敞开 —— 用测试锁住
      「每个已知路由都能在 route-map 里命中一条规则」。
      **验收**：`tests/role-access.test.ts` 的 40 条既有用例全部改写后通过；无路由未命中。
      **产出**：`lib/rbac/route-map.ts`、`middleware.ts`、`tests/rbac-route-map.test.ts`
      **依赖**：T3

- [ ] **T5 `withAuth` 新签名 + 117 处迁移**
      `withAuth(req, handler, { require: 'x.y.z' })`，旧的 `allowedRoles` 数组形式保留一个
      过渡期重载。分批迁移，**不要正则批量替换**（8/6 踩过：批量脚本把数组插进了注释里）。
      批次同 8/6 台账 T6：`waves` → `orders` → `trips` → 商品域 → `pricelists` → 其余。
      **验收**：每批改完跑一次 `verify-parity.ts`，diff 必须为空。
      **产出**：`lib/auth.ts`、各 API 路由
      **依赖**：T3

- [ ] **T6 `can()` 内部改写 + 页面层**
      `lib/permissions.ts` 的 `can(ability, action, subject)` 对外签名不变，内部从查 `MATRIX`
      改为查位图。6 个 layout 的角色白名单改查权限点。
      **验收**：各岗位页面实跑一遍不报错；`tests/role-definitions-sync.test.ts` 相应调整。
      **产出**：`lib/permissions.ts`、6 个 layout
      **依赖**：T5

- [ ] **T7 平迁验证：可达性零 diff（第二次，换引擎后）**
      判定层全部切换完成后，再跑一次全量比对。
      **验收**：**diff 仍必须为空**。这是「换了引擎但一格权限都没动」的唯一证据。
      **依赖**：T6

### 批 2：数据范围三级

- [ ] **T8 `scopeWhere` 统一工具**
      `lib/rbac/scope.ts`：`scopeWhere(ctx, 'order'|'quotation'|'customer'|'purchase_order')`
      → Prisma where 片段。ALL 返回 `{}`，OWN 返回 `{ salesUserId: userId }`，
      TEAM 返回 `{ salesUserId: { in: [自己 + 下属] } }`（下属 = `User.managerId = 自己`，一层）。
      替换现有散落在 `/api/customers`、`/api/orders` 等处的硬编码隔离。
      **验收**：`EXTERNAL_SALES` 现有隔离行为**不变**（回归）；新增 TEAM 用例；
      单测锁住「where 条件在任何分支下都不会被丢掉」（0802 踩过 push 在 where 构造之后的坑）；
      堵掉 `?salesUserId=别人` 的绕过（0806 T7 已堵，不能回退）。
      **产出**：`lib/rbac/scope.ts`、相关 API 路由、`tests/rbac-scope.test.ts`
      **依赖**：T7

- [ ] **T9 上级关系落地**
      用户管理页支持设 `managerId`；防成环（A 的上级是 B，B 的上级不能是 A）。
      **验收**：设置上级后 TEAM 范围角色能看到下属数据、看不到非下属；成环时保存被拒。
      **产出**：`app/api/users/[id]/route.ts`、用户管理页
      **依赖**：T8

### 批 3：配置页面

- [ ] **T10 角色与权限 API**
      `/api/rbac/roles` CRUD、`/api/rbac/permissions`（读 catalog）、
      `/api/rbac/users/[id]/roles`、`/api/rbac/users/[id]/grants`。
      全部要求 `system.rbac.manage`。
      **验收**：无该权限的账号一律 403；建角色→分配→实测目标接口从 403 变 200。
      **产出**：`app/api/rbac/**`
      **依赖**：T7

- [ ] **T11 权限中心 UI（三 tab）**
      扩 `/classic/operator/users` 为用户 / 角色 / 权限总览三 tab，按 §6。
      **验收**：每个可点元素有响应；空状态有提示；建角色全流程走通并在另一浏览器会话生效。
      **产出**：`app/[locale]/classic/operator/users/**`
      **依赖**：T10

- [ ] **T12 防锁死 + 审计 + 强制重登**
      保存时校验「至少一个活跃用户有 `system.rbac.manage`」；权限变更写 `ActionLog`；
      bump `User.permVersion`，handler 发现 `token.pv < permVersion` 返回 401，
      前端跳登录页提示「权限已变更，请重新登录」。
      **验收**：尝试删掉自己最后的管理权限被拒并给出说明；改了 A 的权限后 A 下次请求被踢到登录页，
      B 不受影响；`ActionLog` 里能查到这次变更的前后值。
      **产出**：`app/api/rbac/**`、`lib/auth.ts`、前端 401 处理
      **依赖**：T11

### 批 4：业务角色模板

- [ ] **T13 建 7 个业务角色（不自动分配）**
      按 §4 的岗位映射建成预置角色模板：办公室销售 / 高级销售 / 销售经理 / 仓库经理 /
      外聘销售 / 配送中心 / 打印中心。**只建角色，不动现有 51 个账号的分配** —— 上线后由
      管理员在配置页自行调整（决策 4）。
      **验收**：7 个角色在配置页可见、权限点勾选状态与 §4 一致；
      拿一个测试账号挂上「办公室销售」后实测：能建订单、能录采购单、**不能批采购单**。
      **产出**：`prisma/seed-rbac.ts`
      **依赖**：T12

### 上线后待办（需用户参与，不阻塞开发）

- [ ] 19 个 SALES 兼 OPERATOR 是否拆分
- [ ] 那个收窄后够不着任何页面的 PICKER 账号还用不用（8/6 遗留问题）
- [ ] `/classic/print` 的 layout 本身仍无角色判定（只靠 middleware），建议补一道

---

## 9. 推导差异裁决区（T1 产出后填写）

（待 T1 产出后填写。三源不一致的每一条都要在这里有明确结论，不得默默取并集或交集。）

---

## 10. 进度回写区

| 任务 | 完成时间 | 证据(commit) | 备注 |
|---|---|---|---|
| 设计定稿 | 2026-08-07 | 本文 §2 五条决策 | 用户拍板 |
| T0 | 2026-08-07 | `355710e` | 117 权限点 / 4 张表；迁移在一次性 PG 上实证，未碰 Neon 与生产 |
