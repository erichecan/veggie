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

- [x] **T1 反推脚本：现有权限 → 12 个预置角色** ✅ 2026-08-07 · `d5d155a`
      ~~从三处求交集~~ → **修正为两处推导 + 一处校验**：可达性只由
      `ROLE_API_SCOPE` AND `allowedRoles` 决定（见 `lib/role-reachability.ts`），
      `MATRIX` 根本不参与可达性，它只管 UI 按钮显隐。
      **验收**：脚本输出 12 个角色的权限点清单 + 冲突报告；冲突逐条有结论（见 §9）。
      **产出**：`lib/rbac/route-map.ts`、`scripts/rbac/derive-system-roles.ts`、
      `prisma/seed-rbac.json`、`docs/20260807-rbac-derivation-report.md`
      **依赖**：T0

      **实测**：权限点 117 → **181**（细分是冲突驱动的，见 §9）；位图 23 字节。
      各角色权限点数：BOSS/OPERATOR 178 · FINANCE 66 · SALES 49 · DISPATCH 47 ·
      WAREHOUSE 45 · EXTERNAL_SALES 39 · SORTER 26 · DRIVER 24 · RESTAURANT 21 ·
      PICKER/OTHER 19。dataScope：RESTAURANT / EXTERNAL_SALES = OWN，其余 ALL。

      **顺序调整**：`route-map.ts` 原计划在 T4 才写，实际 T1 就必须有 —— 没有
      「接口→权限点」的映射就无从反推。T4 相应只剩「接到 middleware」这一步。

- [x] **T2 平迁验证：可达性零 diff（第一次）** ✅ 2026-08-07 · `d5d155a`
      用 T1 推出的角色权限，重算 235×12 可达性矩阵与旧体系逐格比对。
      **验收**：**diff 为空** ✅ —— 235 handler × 12 角色 = **2820 格全部一致**。
      并额外校验了 `scripts/audit/role-reachability.json` 快照与旧体系实时计算一致
      （快照若已过期，「与快照一致」就成了自欺欺人）。
      **产出**：`scripts/rbac/verify-parity.ts`、`tests/rbac-route-map.test.ts`
      **依赖**：T1

      零 diff 已锁进测试，之后改 route-map / catalog / seed 而动了任何一格可达性都会红。

### 批 1：判定层切换（风险最高的一批）

- [x] **T3 权限解析与位图编解码** ✅ 2026-08-07 · `2f67df4`
      `lib/rbac/resolve.ts`：`getEffectivePermissions(userId)` → 角色权限并集 ∪ 个人 grant
      − 个人 revoke，dataScope 取最宽。`lib/rbac/bitmap.ts`：编解码 base64url 位图。
      登录时写进 JWT 的 `pm`/`ds`/`pv`。
      **验收**：单测覆盖「多角色并集」「个人加权」「个人扣权」「dataScope 取最宽」四种组合；
      位图编解码往返一致；实测 token 长度增量 < 100 字符。
      **产出**：`lib/rbac/resolve.ts`、`lib/rbac/bitmap.ts`、`lib/auth.ts`、`tests/rbac-resolve.test.ts`、
      `prisma/migrations/20260807000001_rbac_seed_system_roles/`、`scripts/rbac/generate-seed-migration.ts`
      **依赖**：T0

      **实测**：位图 31 字符；token 241 → 317（**增量 76**，上限 100）。
      OPERATOR+SALES 合并 178 权限点、范围 ALL；EXTERNAL_SALES / RESTAURANT 范围 OWN。15 个单测。

      **计划外但必须做的一件事**：预置角色得做成**数据迁移**而不是 seed 脚本。
      本项目部署链路是 `push main → Actions → migrate deploy`，**根本不跑 seed** ——
      写成 seed 的话部署完库里一个角色都没有，全员权限为空、集体被锁在门外。
      迁移三件事全部幂等：写 Permission 镜像、建 12 个预置角色（`DO NOTHING`，
      管理员在页面上调过的权限不该被下次部署冲掉）、把现有用户按 legacy role 挂上去。
      第三件在一次性 PG 上用照现网分布造的数据实测过：多角色正确映射成两个 AppRole，
      `roles[]` 为空的账号正确回退单 role，权限点数与 T1 推导一致，重跑幂等。

- [x] **T4 middleware 改查位图** ✅ 2026-08-07 · `b61f2d9`
      `lib/rbac/route-map.ts`：URL 前缀 + 方法 → 所需权限点。middleware 从 token 的 `pm`
      解位图判定，取代 `role-access.ts` 的角色白名单。
      ⚠️ **route-map 必须覆盖全部 48 个 API 域 + 89 个页面**，漏了就是敞开 —— 用测试锁住
      「每个已知路由都能在 route-map 里命中一条规则」。
      **验收**：`tests/role-access.test.ts` 的 40 条既有用例全部改写后通过；无路由未命中。
      **产出**：`lib/rbac/gate.ts`、`middleware.ts`、`tests/rbac-gate.test.ts`
      （`route-map.ts` 已在 T1 产出）
      **依赖**：T3

      **⛔ 计划外但必须做的一件事**：保留**旧 token 回退路径**。部署那一刻所有在线用户
      手里都是没有 `pm` 字段的旧 token（有效期 7 天），直接按位图判会把全员挡在门外 ——
      包括没法登录进去改配置的管理员。回退路径可在部署日 + 7 天后连同 `lib/role-access.ts` 一起删。

      **兜底语义反转**：旧的是「不在收窄名单里就放行」，新的是「没有规则命中就拒绝」。
      新增接口忘了登记的表现从「敞开」变成「403」—— 坏掉比漏掉好。

- [x] **T5 `withAuth` 新签名 + 154 处迁移** ✅ 2026-08-07 · `401ed49`
      `withAuth(req, handler, { require: 'x.y.z' })`，旧的 `allowedRoles` 数组形式保留一个
      过渡期重载。分批迁移，**不要正则批量替换**（8/6 踩过：批量脚本把数组插进了注释里）。
      批次同 8/6 台账 T6：`waves` → `orders` → `trips` → 商品域 → `pricelists` → 其余。
      **验收**：每批改完跑一次 `verify-parity.ts`，diff 必须为空 ✅
      **产出**：`lib/auth.ts`、`lib/analytics/cache.ts`、`scripts/rbac/migrate-route-gates.ts`、各 API 路由
      **依赖**：T3

      **实测**：实际 154 处（台账原写 117，是 8/6 的旧数）。迁完后 `allowedRoles` 写法归零：
      235 个 handler 里 154 个权限点闸、2 个 CRON 密钥、31 个只验登录、48 个靠 middleware 兜底。
      分 7 批（waves→orders→trips→商品域→pricelists→其余），每批回扫 + parity。

      **改写脚本的做法**（针对 8/6 那次事故）：定位复用 `route-gate-scan` 的括号配平
      （会跳过注释、字符串、模板串），只替换第三个实参那一段，改完**回扫验证** ——
      重新 scan 确认 gate 确实变成了预期权限点。光看编译通过什么都证明不了。

      **⛔ 途中修了三处度量工具失真，每一处都会让安全绳失效**：

      1. **parity 基线不能实时算旧体系**。`allowedRoles` 一拆，实时算出来的「旧体系」
         跟着变松，那条测试就成了拿改动后的自己和改动后的自己比，永远绿。
         基线已冻结成 `lib/rbac/parity-baseline.json`（与 8/6 的 CI 快照逐格一致）。
      2. **`lib/role-reachability.ts` 同样的病**，它报了 67 格「变得更开放」。不是真放宽，
         是它还在按 `allowedRoles` 算而那东西已经没了。升级到按权限点算之后，
         与 8/6 的 CI 快照**完全一致** —— 这是第二个独立的零 diff 证据。
      3. **`tests/api-write-gates.test.ts`** 断言 `gate.kind === 'roles'`，现在一个都没有。
         升级到权限点口径后反而更强：以前看「闸门里写没写一线角色的名字」，
         现在直接查该角色**实际拥有的权限集**，就算哪天悄悄给司机加了权限点也会红。

- [x] **T6 `can()` 内部改写 + 页面层** ✅ 2026-08-07 · `758f63e`
      `lib/permissions.ts` 的 `can(ability, action, subject)` 对外签名不变，内部从查 `MATRIX`
      改为查位图。6 个 layout 的角色白名单改查权限点。
      **验收**：各岗位页面实跑一遍不报错；`tests/role-definitions-sync.test.ts` 相应调整。
      **产出**：`lib/permissions.ts`、`lib/rbac/page-guard.ts`、**9 个** layout、
      `tests/rbac-page-guard.test.ts`
      **依赖**：T5

      **实测**：`can()` 全项目只有一处调用（`PermissionGate` 组件），而那个组件
      **没有任何使用者** —— `MATRIX` 早已是死代码。所以 can() 保持签名、内部改查位图、
      翻不出权限点时回落 MATRIX 就够了，另加 `hasPermission()` 供新代码直接用。

      **layout 那边查出三类问题**：
      - 6 个写的是 `[...].includes(user.role)`，**只看主角色单值** —— 现网 19 个 SALES
        全兼 OPERATOR，兼任角色一直白兼，与 middleware 的 `roles[]` 口径对不上
      - `operator` / `restaurant` 更严，写的是 `user.role !== 'X'` 严格相等
      - ⛔ **`print` 完全没有判定** —— 正是 8/6 台账 §7 记的未解决问题，现已补上

      统一到 `canEnterPage`，与 middleware 共用同一张 route-map。测试逐格比对
      9 页面 × 12 角色，**layout 与 middleware 判定完全一致** ——
      8/6 台账「页面级白名单与 API 的一致性尚未逐条核对」这条可以销了。

- [x] **T7 平迁验证：可达性零 diff（第二次，换引擎后）** ✅ 2026-08-07 · `758f63e`
      判定层全部切换完成后，再跑一次全量比对。
      **验收**：**diff 仍为空** ✅ 2820 格。判定层四处（middleware / 路由闸 / `can()` / layout）
      全部改完，可达性一格未动。全量 312 测试 0 失败，build 通过。
      **依赖**：T6

### 批 2：数据范围三级

- [x] **T8 数据范围三级（升级 `lib/row-scope.ts`）** ✅ 2026-08-07 · `3be92ac`
      `lib/rbac/scope.ts`：`scopeWhere(ctx, 'order'|'quotation'|'customer'|'purchase_order')`
      → Prisma where 片段。ALL 返回 `{}`，OWN 返回 `{ salesUserId: userId }`，
      TEAM 返回 `{ salesUserId: { in: [自己 + 下属] } }`（下属 = `User.managerId = 自己`，一层）。
      替换现有散落在 `/api/customers`、`/api/orders` 等处的硬编码隔离。
      **验收**：`EXTERNAL_SALES` 现有隔离行为**不变**（回归）；新增 TEAM 用例；
      单测锁住「where 条件在任何分支下都不会被丢掉」（0802 踩过 push 在 where 构造之后的坑）；
      堵掉 `?salesUserId=别人` 的绕过（0806 T7 已堵，不能回退）。
      **产出**：`lib/row-scope.ts`（升级现有文件，不另起 `lib/rbac/scope.ts`）、
      `app/api/customers/[id]`、`app/api/orders/[id]`、`tests/row-scope.test.ts`
      **依赖**：T7

      **实测**：19 个单测。TEAM 用 Prisma **关系过滤**（`salesUser.managerId = 我`）而不是
      先查下属 id 再 `in` —— 后者多打一次库，且下属列表变化时有时间窗。
      旧 token（无 `ds`）回退原硬编码判断，行为一字不变。

      **类型改完 tsc 立刻指出两处 `select` 没取 `managerId`**（customers/[id]、orders/[id]）——
      这正是想要的：忘了 select 就编译不过，而不是运行时静默放行。字段缺失时保守拒绝。

- [x] **T9 上级关系落地（API 层）** ✅ 2026-08-07 · `3be92ac`
      用户管理页支持设 `managerId`；防成环（A 的上级是 B，B 的上级不能是 A）。
      **验收**：设置上级后 TEAM 范围角色能看到下属数据、看不到非下属；成环时保存被拒。
      **产出**：`app/api/users/[id]/route.ts`、`app/api/users/route.ts`、`tests/rbac-user-sync.test.ts`
      **依赖**：T8

      **范围调整**：UI 部分（在用户管理页上选上级）并入 T11 的权限中心一起做，
      避免同一个页面改两遍。本条只做 API 与校验。

      **⛔ 途中撞见三个「写错了不报错、只静默失效」的洞**，都在本次范围内，一并修了：

      | # | 洞 | 表现 |
      |---|---|---|
      | 1 | `VALID_ROLES` 漏角色（POST 少 `EXTERNAL_SALES`/`DISPATCH`/`OTHER`，PUT 少 `EXTERNAL_SALES`） | 8/6 加了角色没回来更新，管理员**两个月来建不出外部销售账号**，且不报错、只是选项不生效 |
      | 2 | 改角色不同步 `UserRoleLink` | 权限真相已是 `UserRoleLink`，页面改的还是 legacy `role[]` → **在页面上改了角色，权限纹丝不动**（正是要杜绝的「配了但不生效」） |
      | 3 | 建用户不建 `UserRoleLink` | 新账号登录后权限集为空 —— **人建出来了却什么都点不动** |

      三条现在都有静态测试守着（`tests/rbac-user-sync.test.ts`）。

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

**首轮 95 处冲突，五轮收敛到 0。** 完整报告见
`docs/20260807-rbac-derivation-report.md`（由脚本生成，可复跑）。

冲突不是零散的，是两条系统性根因加一类粒度问题：

**根因 1：页面权限点与 API 权限点混用（消除 32 处）**
`ROLE_PAGE_SCOPE` 与 `ROLE_API_SCOPE` 本就是两套独立定义，现实中存在大量
「能调接口但进不去页面」的组合 —— 例如财务能读订单接口，却进不去运营后台页面。
共用一个权限点表达不了这种差异。
**裁决**：拆出独立的 `page.*` 权限点组（11 个），页面层不再复用 API 权限点。

**根因 2：OR 规则会把两个权限点一起拉进禁止集**
逻辑本身没错（`¬(a∨b)` 就是两个都禁），但暴露了 OR 用错了地方：
`mark-printed` 写成「改订单 或 打印中心」，结果财务有打印权，却因为不能改订单
而连打印中心一起丢了。
**裁决**：OR 只保留语义上确实「多岗位共用同一接口」的少数几处
（如订单列表同时是分拣与拣货的取数入口），其余一律拆成独立权限点。

**粒度问题：子路由与父路由共用权限点，而角色的旧白名单只给了其中之一**
**裁决**：细分。细分出来的粒度本身就有业务意义，不是为迁就算法 ——

| 细分 | 业务含义 |
|---|---|
| `master.customer.read` / `read_detail` / `read_credit` / `read_last_prices` | 能看客户名册 ≠ 能看信用额度与账期 |
| `sales.order.create` / `bulk_import` | 能下单 ≠ 能批量导入 |
| `sales.order.update` / `assign_batch` / `mark_printed` / `delete_line` | 改订单内容 ≠ 改派波次 ≠ 标记打印 |
| `sales.order.read` / `read_audit` / `export` | 看订单 ≠ 看修改审计 ≠ 导出全量 |
| `dispatch.trip.read` / `print` / `verify` / `returns` / `discrepancy` | 看行程 ≠ 打印面单 ≠ 核货 ≠ 处理退货 |
| `purchase.order.*` / `purchase.legacy.*` | `/api/purchase-orders` 与 `/api/purchases` 是两套并存的采购模块 |
| `master.product.read` / `read_detail` / `read_price_history` | 商品列表 ≠ 商品档案 ≠ 价格历史 |

**顺带查出两处「以为人人可用、其实不是」**（现状原样保留，未放开）：

| 接口 | 实情 |
|---|---|
| `/api/mfa/enroll` | 收窄角色的 `COMMON` 白名单里**没有** `/api/mfa` —— 财务、仓库、司机等根本用不了二次验证自助绑定。给了 `system.mfa.enroll`，要放开在配置页里勾 |
| `POST /api/notifications` | 有角色闸，9 个角色够不着。给了 `system.notification.create` |

---

## 9.5 部署事故记录（2026-08-07）

**批 0+1 部署到生产后实测抓到一个真问题，已修复并重新部署。**

| | |
|---|---|
| 现象 | RESTAURANT 的旧 token 打 `/api/customer-portal/products` 返回 **403** —— 客户被挡在自己的门户外面 |
| 影响面 | T5 改成 `{ require }` 的 **154 个接口**，对所有**还没重新登录**的用户全部 403，且旧 token 有效期 7 天 |
| 根因 | T4 在 middleware 层做了旧 token 回退，**路由层的 `withAuth` 没做**。旧 token 无 `pm`，`decodePermissions(undefined)` 得空集 |
| 修复 | `lib/rbac/legacy-roles.ts` 权限点→角色反查表。**不能简单跳过检查** —— 那样旧 token 只剩 middleware 一层，比改造前更宽松 |
| 提交 | `eb50ebf` |

**为什么之前全绿 —— 这是最该记住的一条**：

测试**分层测了** middleware（`tests/rbac-gate.test.ts` 里「旧 token 走回退路径」）
和路由层，唯独**没有一条测两层合起来的最终结果**。每一层单独看都是对的，
合起来才是坏的。已补 `tests/rbac-legacy-token.test.ts`，逐个 handler 比对
旧 token 的**最终**可达性与改造前基线。

**探测样本挑得不够狠也有责任**：DRIVER 那组当时没暴露问题，因为它只够得着
`GET /api/trips`，而那个 handler 恰好是 `authOnly` 没有 `require`。
选探测样本时要专挑「闸门形态刚改过」的路由，不能只挑角色最典型的。

**清理时点**：`lib/rbac/legacy-roles.ts` 与 `lib/role-access.ts` 可在
**2026-08-14**（部署日 + 7 天，全部旧 token 过期）后一并删除。

### 修复后的生产实测（`eb50ebf`）

**192 次实测**：16 个「闸门形态刚改过」的 GET × 6 个角色 × 新旧两种 token。
**结果：新旧 token 行为完全一致，无一处放宽。**

唯一一处「不符」是**探针自身的问题**，不是权限层：给 RESTAURANT 签 token 时用了
司机的 `userId` 且 `customerId=null`，而客户门户做了按 `customerId` 的行级隔离，
于是 403 是业务层回的。换成真实身份（`restaurant2@veggie.com` / `cust_002`）重测：

| | 新 token | 旧 token |
|---|---|---|
| `/api/customer-portal/products` | 200 | 200 |
| `/api/customer-portal/orders` | 200 | 200 |
| `/api/customer-portal/frequently-ordered` | 200 | 200 |
| `/api/customers`（8/6 泄露过的） | **403** | **403** |
| `/api/orders` | **403** | **403** |

⚠️ 这正是记忆里那条「**虚构身份的 403 不是权限层回的**」。用假身份探权限，
会把业务层的拒绝误读成权限层的拒绝，进而误判成 bug —— 探针必须用真实身份。

⛔ 全程只打 GET。8/6 审计探 `POST /api/pricelists` 曾真的建了一条数据，事后得去生产库删。

---

## 9.6 第二起事故：推导算法把「无人引用的权限点」发给了所有角色（2026-08-07）

**做 T10 时发现的，此时错误数据已经在生产库里。**

| | |
|---|---|
| 现象 | 生产库 12 个角色**全部**带着 `system.rbac.manage` —— 司机、拣货员、餐厅客户都有「管理任何人的权限」 |
| 为什么还没出事 | 配置页尚未上线，`/api/rbac/*` 接口还没部署。T10 一部署就会变成真漏洞 |
| 根因 | T1 的推导写成 `Allowed(r) = 全集 − Forbidden(r)`。**没有任何 handler 引用的权限点不会进任何人的禁止集，于是所有角色都拿到它**。`system.rbac.*` 当时正是这种情况 —— 配置页还没开发 |
| 修法 | 改成 `Allowed(r) = Needed(r) − Forbidden(r)`：只发「有证据表明该角色够得着的接口引用过」的权限点 |
| 修复 | `bc81014`，含重置迁移 `20260807000002` |

### ⛔ 同一个元教训，第二次踩：度量工具会跟着改动一起失真

修的过程中揪出**第四处度量工具失真**（前三处在 T5 修过）：

`derive-system-roles.ts` 靠 `scanApiHandlers` 实时读 `allowedRoles` 来还原
「改造前的可达性」。而 T5 已经把 154 处 `allowedRoles` 全拆成权限点闸了 ——
它于是以为路由层根本没有闸，推出来的权限比真实的改造前**宽得多**。

T5 那次修了三处（parity 基线、`role-reachability.ts`、`api-write-gates.test.ts`），
唯独漏了这个文件，因为 **T1 之后就没再跑过它**，直到 T10 新增路由才重新触发。

> **这类失真的共同特征：它让结果看起来更好，而且不会报错。**
> 改判定机制时，必须把「所有依赖旧机制的度量工具」列一遍，逐个确认。

### 连带处理

- **有意新增的权限要显式登记**。权限配置页是新增功能，反推不出 `system.rbac.*`，
  表现为「配置页做好了却没有一个账号进得去」。已在 `derive-system-roles.ts` 里
  加 `INTENTIONAL_GRANTS`（BOSS / OPERATOR），写明理由 —— 登记在脚本里而不是
  手改 seed，重跑才不会丢。
- **基线更新脚本只做加法**（`scripts/rbac/update-parity-baseline.ts`）：已有的格
  一个都不动。基线能被随便重写的话，零 diff 测试就退化成拿自己和自己比。
  7 个新 rbac 路由纳入后实测只有 BOSS / OPERATOR 可达。
- **重置迁移在一次性 PG 上实证**：重置前 driver 24 个权限点且能管权限，
  重置后 5 个且不能；**页面权限点全部保留**（`page.driver.access` 等），
  各岗位仍进得去自己的页面 —— parity 只验 API 不验页面，这一条得单独确认。

---

## 10. 进度回写区

| 任务 | 完成时间 | 证据(commit) | 备注 |
|---|---|---|---|
| 设计定稿 | 2026-08-07 | 本文 §2 五条决策 | 用户拍板 |
| T0 | 2026-08-07 | `355710e` | 117 权限点 / 4 张表；迁移在一次性 PG 上实证，未碰 Neon 与生产 |
| T0 补 | 2026-08-07 | `d76efd1` | sortKey 改由快照权威分配 —— 原设计挡不住「往中间插动作」，而 T1 第一件事就要插 |
| T1 | 2026-08-07 | `d5d155a` | 181 权限点；95 处冲突五轮收敛到 0；裁决见 §9 |
| T2 | 2026-08-07 | `d5d155a` | **2820 格零 diff**；CI 快照新鲜度一并校验；已锁进测试 |
| T3 | 2026-08-07 | `2f67df4` | token 增量 76 字符；预置角色改做数据迁移（部署链路不跑 seed） |
| T4 | 2026-08-07 | `b61f2d9` | middleware 切位图；**保留旧 token 回退**，否则部署即全员锁死 |
| T5 | 2026-08-07 | `401ed49` | 154 处迁移、`allowedRoles` 归零；修了 3 处度量工具失真 |
| T6 | 2026-08-07 | `758f63e` | `can()` + 9 个 layout；补上 `print` 缺失的守卫 |
| T7 | 2026-08-07 | `758f63e` | **第二次 2820 格零 diff**，批 1 完成 |
| 部署批 0+1 | 2026-08-07 | `df9b1f8` | 生产实测：迁移两条已应用、12 角色/181 权限点/70 条链接、**未挂角色的活跃账号 = 0** |
| 事故修复 | 2026-08-07 | `eb50ebf` | 旧 token 打 154 个接口全 403，见 §9.5 |
| 修复后实测 | 2026-08-07 | 生产 `eb50ebf` | 192 次探测新旧 token 行为一致；真实身份下客户门户 200、越权接口 403 |
| T8 | 2026-08-07 | `3be92ac` | 三级范围；TEAM 走关系过滤；tsc 逼出两处漏 select |
| T9 | 2026-08-07 | `3be92ac` | managerId + 环检测；顺手补 3 个静默失效的洞 |
| T10 | 2026-08-07 | `bc81014` | `/api/rbac/*` 六个接口 + 防锁死校验；做的过程中揪出 §9.6 的事故 |
| 事故修复 2 | 2026-08-07 | `bc81014` | 推导算法把无人引用的权限点发给了所有角色，见 §9.6 |
