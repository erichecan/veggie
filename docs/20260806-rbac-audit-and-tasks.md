# 权限角色审计与整改台账

> 审计时间：2026-08-06 · 目标：生产环境 `167.99.86.19`（真实数据）
> 方法：静态扫描 235 个 API handler + **以真实低权限账号签发 token 实测越权**
> 依据：CLAUDE.md 第七节「API 安全铁律」、skill `api-auth-templates`
>
> **能不能实现：能。** 机制早就齐备，缺的是把它用全。可行性评估见 §3。

---

## 0. 一句话结论

**「有没有鉴权」这一层是好的**：middleware 统一拦截全部 `/api/*`，白名单只有 4 条且
被 `tests/public-api-routes.test.ts` 锁住。未带 token 一律 401，实测通过。

**「谁能干什么」这一层基本是空的**：235 个 handler 里 **99 个有 `withAuth` 但没有
`allowedRoles`**，另有 3 个写操作连 `withAuth` 都没有。结果是**任何登录用户都能调**。

> ⚠️ **2026-08-06 数字更正**：99 这个数偏高。当时的检测正则只认 `}, ['OPERATOR'])`
> 这一种写法，凡是把角色抽成具名常量（backups / stock-takes / pdf-extract /
> signature-correction 等 5 处）一律被误报成"没闸"；同一条正则还被注释里的 `1)`
> 骗过括号计数，把 `/api/orders` 与 `/api/waves` 的 POST 也误判了。
> 按修好的检测器（`lib/route-gate-scan.ts`）重扫，整改前真实缺口是
> **写操作 120 个里 57 个没有角色闸**。结论方向不变，但**假阴性会让清单虚高，
> 也会让真正的漏网之鱼淹没在噪音里** —— 检测器本身也要被验证。

⛔ **已实测确认的越权（不是推断）**：一个**餐厅客户**账号能读到全公司的客户名册、
别家的订单、采购成本，并且**能写入数据**。详见 §1。

---

## 1. 实测证据

用生产库里真实的 `restaurant2@veggie.com`（`role=RESTAURANT`，绑定 `customerId=cust_002`）
签发 token —— 这是权限最低的一类真实用户，代表**外部客户**。

### 1.1 读越权

| 端点 | 结果 | 它看到了什么 |
|---|---|---|
| `/api/customers` | **200** | **1,596 家客户**全量名册，含 `name`/`address`/`phone`/`email`/`vatNumber`/`creditLimit`/`commissionRate`/`priceType` —— **这里面全是他的竞争对手** |
| `/api/orders` | **200** | **500 张订单，涉及 339 个不同客户；自己的只有 1 张，别家的 499 张** |
| `/api/invoices` | 200 | 全量发票 |
| `/api/purchase-orders` | 200 | 30 条采购单，含 `supplierId`/`supplierName`/`freightAmount` —— **供应链与成本** |
| `/api/suppliers` | 200 | 供应商名录 |
| `/api/stock-moves` | 200 | 库存流水 |
| `/api/action-logs` | 200 | 全系统操作日志 |
| `/api/driver-slots` | 200 | 司机配置 |

**已挡住的**（说明机制本身是有效的，只是没用全）：
`/api/analytics/*` 403、`/api/users` 403、`/api/backups` 403。

> ⚠️ 客户是爱尔兰实体，客户名册含姓名/地址/电话/邮箱/税号 —— 这在 GDPR 下是个人数据。

### 1.2 写越权

用「PUT 一个不存在的 id」探测（403 = 有角色闸；404/400 = 已经进了业务逻辑）：

```
PUT    /api/driver-slots/nonexistent-id   400   ⚠️ 无角色检查
DELETE /api/driver-slots/nonexistent-id   404   ⚠️
PUT    /api/customers/nonexistent-id      404   ⚠️
PUT    /api/products/nonexistent-id       404   ⚠️
DELETE /api/orders/nonexistent-id         404   ⚠️
PUT    /api/suppliers/nonexistent-id      404   ⚠️
POST   /api/pricelists                    201   ⛔ 真的创建成功了
```

⛔ **最后一条不是探测，是真实写入** —— 餐厅客户创建了一条价格表（价格表直接影响定价）。

> **审计副作用，如实记录**：这条记录（`OdooPricelist` 里 `name='probe'`）**已于当时立即删除**
> （`DELETE 1`，复核残留 0，价格表总数回到 95）。除此之外本次审计未改动任何生产数据。

### 1.3 设计意图与现状的矛盾

`/api/customer-portal/*`（3 个路由 + 前端 `/customer-portal` 页面）**做了完整的
按 `customerId` 行级隔离**。所以设计意图很清楚：**RESTAURANT 角色只该走客户门户**。

问题在于**没有任何东西阻止他们直接调内部接口**。门做了，墙没砌。

---

## 2. 静态扫描结果

### 2.1 鉴权覆盖（235 个 handler）

| | 有 `withAuth` | 无 | 说明 |
|---|---:|---:|---|
| 写操作（POST/PUT/PATCH/DELETE） | 113 | **7** | 7 个里 4 个是合理的（`login` 匿名、`change-password` 用 `requireAuth`、2 个 cron 用 `CRON_SECRET`），**真正缺的是 `driver-slots` 的 3 个** |
| GET | 68 | 47 | 有 middleware 兜底，不是匿名可读；问题是**没有角色检查** |

### 2.2 缺角色限制的规模

**99 个 handler 有 `withAuth` 却没传 `allowedRoles`** = 任何登录用户都能调：

```
POST 31 · PUT 16 · DELETE 10 · PATCH 3   （写操作合计 60）
GET  39
```

写操作按资源归类（前几名）：
`waves` 13 · `orders` 9 · `trips` 4 · `products` 3 · `product-templates` 3 ·
`product-categories` 3 · `pricelists` 3 · `stock-takes` 2 · `customers` 2 …

### 2.3 角色定义三处不同步

| 位置 | 角色数 | 内容 |
|---|---:|---|
| `prisma/schema.prisma` `enum Role` | 11 | OPERATOR RESTAURANT PICKER SORTER DRIVER BOSS FINANCE WAREHOUSE SALES **DISPATCH OTHER** |
| `lib/types.ts` `UserRole` | 11 | 一致 |
| **`lib/permissions.ts` `Role`** | **9** | ⛔ **缺 `DISPATCH`、`OTHER`** |

`MATRIX` 是 `Record<Role, …>`，查 `MATRIX['DISPATCH']` 会得到 `undefined`。
**当前 0 个用户是这两种角色**，所以还没炸；但只要有人在用户管理里选了这两个角色就会出问题。

### 2.4 SALES 行级隔离实际约束 0 人

`/api/customers` 里的隔离逻辑本身是对的（20260802 已修过一次「push 在 where 构造之后失效」）：

```ts
if (roles.includes('SALES') && !roles.includes('BOSS') && !roles.includes('OPERATOR')) {
  andConditions.push({ salesUserId: caller.userId })
}
```

但实测 `roles[]` 分布：

```
DRIVER          21 人
OPERATOR+SALES  19 人      ← 全部 SALES 都兼任 OPERATOR
(空)            11 人
```

**19 个 SALES 全部兼任 OPERATOR，所以这条隔离对谁都不生效。**
这不是代码 bug，是「设计意图」与「实际角色配置」的矛盾 —— 需要业务决策，见 §4。

---

## 3. 可行性评估：能实现，而且不需要新框架

| 需要的能力 | 现状 |
|---|---|
| 接口级角色闸 | ✅ 已有 `withAuth(req, handler, allowedRoles)`，16 个 analytics 路由已在用，实测 403 有效 |
| 细粒度权限矩阵 | ✅ 已有 `lib/permissions.ts` 的 `can(ability, action, subject)` |
| 行级数据隔离范式 | ✅ `customer-portal` 三个路由是现成样板 |
| 页面级白名单 | ✅ 6 个 layout 已在用 |
| 回归保护 | ✅ 已有 204 个测试 + `public-api-routes.test.ts` 的快照比对模式可复用 |

**所以工作量集中在「把 `allowedRoles` 补齐」和「给 RESTAURANT 砌墙」，不是从零搭 RBAC。**

**主要风险是误伤**：给某个接口加了角色限制，但漏列了某个确实需要它的角色，
表现是「某个岗位的页面突然 403」。所以整改顺序必须是
**先建立可复跑的探针 → 再改 → 每步用探针回归**，而不是一次性批量加。

---

## 4. ✅ 三个决策已定（2026-08-06，用户拍板）

| # | 决策 | 落地 |
|---|---|---|
| 1 | **RESTAURANT 只能走客户门户**，内部接口与后台页面一律拒绝 | `5aba1e5` — `lib/role-access.ts` + middleware 双层 |
| 2 | **sales 拆成两类**：正式 `SALES` 与外部合作 `EXTERNAL_SALES`（后者不给发票、不给价格表、不能改客户资料） | `5aba1e5` — 含 schema 迁移；⚠️ **行级隔离尚未做**，见 T7 |
| 3 | **`DISPATCH` 补进权限矩阵**（波次/行程可增改、订单可改派、客户只读）；`OTHER` 显式声明为空权限 | `5aba1e5` |

---

## 5. 任务

- [x] **T1 建立权限探针** ✅ 2026-08-06 · `5aba1e5`

  `scripts/audit/rbac-probe.ts`：为 10 个角色签发 token，遍历全部 API 路由，
  产出「角色 × 端点 → 状态码」矩阵并与 `scripts/audit/rbac-snapshot.json` diff。
  **已达成**：一条命令跑出矩阵；§1 的越权全部复现（修复前 RESTAURANT 可达 43 个内部 GET）；
  基线快照已存（235 个 handler）。
  ⛔ 探针**刻意不探 POST** —— 审计时探 `POST /api/pricelists` 返回 201 真的建了一条数据，
  事后得去生产库删。POST 改用静态分析看有没有 `allowedRoles`。

- [x] **T2 补齐角色定义一致性** ✅ 2026-08-06 · `5aba1e5`

  `permissions.ts` 补上 `DISPATCH`/`OTHER`（另新增 `EXTERNAL_SALES`）。
  **已达成**：`tests/role-definitions-sync.test.ts` 从 schema / types.ts / permissions.ts
  三处解析角色列表比对，并检查 `MATRIX` 是否给每个角色都写了条目 —— 以后漂不了。

- [x] **T3 给 RESTAURANT 砌墙** ✅ 2026-08-06 · `5aba1e5`

  `lib/role-access.ts` 定义边界收窄型角色的白名单，middleware 一处判定覆盖全部路由
  （**API 层与页面层都挡** —— 光挡 API 的话页面能开但数据全 403，用户看到一堆空壳）。
  **已达成**：白名单只留 `/api/customer-portal`、`/api/auth`、`/api/health`、`/api/notifications`；
  客户门户三个路由本就按 `customerId` 行级隔离且不回 standardPrice/commissionPrice。

---

### 剩余任务（2026-08-06 重排）

原 T5/T6 的写法是「给 99 个 handler 逐个补 `allowedRoles`」。**重排的理由**：
实测口径下无角色闸的是 **152 个 handler**（99 是"有 withAuth 但没传 allowedRoles"，
另有 53 个 GET 靠 middleware 兜底鉴权、连 withAuth 都没有）。逐个补要改 152 处，
**漏一处就还是漏，而且新增路由默认又是敞开的** —— 这正是 T3 选择 middleware 层的原因。
所以改成：**先在 middleware 层给每个内部角色划边界（一次覆盖全部现有与将来路由），
再给高危写操作补 `allowedRoles` 做纵深防御**。

- [x] **T4 `driver-slots` 补 `withAuth` + 角色** ✅ 2026-08-06 · `4a62846`
      现状：`POST /api/driver-slots`、`PUT/DELETE /api/driver-slots/[id]` **连 `withAuth` 都没有**，
      只靠 middleware 验了「有没有 token」，任何登录用户都能改司机配置。
      **验收**：非 OPERATOR/BOSS 调用返回 403；运营端司机配置页增删改一遍功能不变。
      **产出**：`app/api/driver-slots/route.ts`、`app/api/driver-slots/[id]/route.ts`

- [x] **T5 内部角色边界 ✅ 2026-08-06 · `bae0ac9`（把 `role-access.ts` 扩成全部收窄型角色）**
      给 DRIVER / SORTER / PICKER / WAREHOUSE / FINANCE / SALES / EXTERNAL_SALES /
      DISPATCH / OTHER 各定义「前缀 + 允许的 HTTP 方法」白名单，白名单外一律 403。
      OPERATOR / BOSS 不在此层收窄（他们是后台本身）。
      边界**从各角色实际能进的页面反推**（页面层白名单在 6 个 layout 里），不是拍脑袋定。
      **验收**：探针跑出的矩阵里，每个角色可达的内部接口数显著下降且**没有一个是该角色页面在用的**；
      DRIVER（生产 21 人，唯一有真实用户的收窄角色）行程页取数/签收/交账全流程实跑不报错。
      **产出**：`lib/role-access.ts`、`middleware.ts`、`tests/role-access.test.ts`

- [x] **T6 写操作补 `allowedRoles`（纵深防御）** ✅ 2026-08-06 · `006fa8b`
      即使有了 T5 的边界，写操作仍要在路由层再挡一道 —— middleware 是按前缀判的，
      粒度到不了「同一个前缀下 GET 可以、DELETE 不行」的细处。
      批次：`waves`(13) → `orders`(9) → `trips`(4) → 商品域(products/templates/categories 9) →
      `pricelists`(3) → `purchases`/`stock-takes`/`lots`/`backups` 其余。
      **验收**：每批改完跑探针，diff 里只出现预期的 `→403`；对应岗位页面实际操作一遍不报错。
      ⚠️ 分批做，不要正则批量替换 —— 参考「正则改 16 个路由把 `allowedRoles` 吃掉」的教训。

- [x] **T7 `EXTERNAL_SALES` 行级隔离** ✅ 2026-08-06 · `934aec9`
      现状：拆出了角色，但它仍能看到**全部**客户与订单 —— 只挡了"能不能做这个动作"，
      没挡"能看到谁的数据"。
      **验收**：`EXTERNAL_SALES` 调 `/api/customers`、`/api/orders` 只返回
      `salesUserId = 自己` 的记录；越权访问他人客户详情返回 404/403；
      **不受"是否同时兼任其他角色"影响**（这正是 SALES 隔离形同虚设的原因）；
      单测锁住「where 条件在任何分支下都不会被丢掉」（0802 踩过 push 在 where 构造之后的坑）。
      正式 `SALES` 维持现状（19 人全兼 OPERATOR，业务上就是要看全量），
      在代码里写明这是有意为之，避免后人误以为是 bug。

- [x] **T8 把探针纳入 CI** ✅ 2026-08-06 · `2f70fe2`
      **验收**：任何一个路由的角色可达性发生变化，CI 必须失败并显示 diff；
      快照更新必须是显式动作（改代码顺手把快照也改了 → review 时看得见）。

---

## 6. 进度回写区

| 任务 | 完成时间 | 证据 | 备注 |
|---|---|---|---|
| 审计本身 | 2026-08-06 | 本文 §1/§2 | 实测越权已确认；误建的 1 条价格表已清理 |
| T1/T2/T3 | 2026-08-06 | `5aba1e5`，Deploy to droplet 04:23 成功 | 台账当时漏了回写，2026-08-06 补上 |
| T4 | 2026-08-06 | `4a62846` | 司机配置三个写操作补上角色闸，实测 5 个非运营角色全 403 |
| T5 | 2026-08-06 | `bae0ac9` | 边界扩到全部收窄型角色，40 条实测用例全符合预期 |
| T6 | 2026-08-06 | `006fa8b` | 48 处补 `allowedRoles`；**第一版批量脚本把数组插进了注释里，已回滚重做** |
| T7 | 2026-08-06 | `934aec9` | 行级隔离落地，并堵掉 `?salesUserId=别人` 的绕过 |
| T8 | 2026-08-06 | `2f70fe2` | 可达性快照进 CI；此前仓库根本没有跑测试的工作流 |

### 整改前后（静态可达性，235 handler × 12 角色 = 2820 格）

| | 可达格 |
|---|---:|
| 只有路由级 `allowedRoles`（无 middleware 边界） | 1410 |
| 加上 middleware 角色边界（现状） | **757** |

两层各砍掉一半 —— 这也说明为什么只做逐路由 `allowedRoles` 不够。

### 生产账号影响核对（2026-08-06 直连生产库）

51 个活跃账号，逐类核过收窄后还能不能干活：

| 角色 | 人数 | 收窄后 |
|---|---:|---|
| DRIVER | 23 | 行程列表/详情/签收(PUT)/交账/地图打点 全部放行，实测通过 |
| OPERATOR（含兼 SALES 19 人） | 21 | 不收窄 |
| BOSS | 1 | 不收窄 |
| RESTAURANT | 2 | 只走客户门户（`5aba1e5` 起已生效），实测门户功能完好 |
| FINANCE / SORTER / WAREHOUSE | 各 1 | 各自页面调用的接口已在白名单内 |
| PICKER | 1 | ⚠️ 见下方未解决问题 |

## 7. 未解决问题

- ~~`OTHER` 角色的 11 个空角色用户~~ → **已核**：那 11 个是 `roles[]` 为空、
  回退单 `role` 的账号（OPERATOR 2 / RESTAURANT 2 / DRIVER 2 / FINANCE 1 / BOSS 1 /
  PICKER 1 / SORTER 1 / WAREHOUSE 1），`rolesOf` 的回退口径覆盖得到，不会因为
  `roles[]` 空而被误判。
- ⚠️ **1 个 PICKER 账号收窄后什么都够不着**（除登录与通知）。这不是本次造成的：
  `/classic/sorter` 的 layout 只放 SORTER/OPERATOR，PICKER 本来就进不去任何页面，
  `permissions.ts` 里也是空矩阵 —— 它此前"能调所有接口"才是不该有的状态。
  **需要业务确认**：这个账号还在用吗？要用的话该给它哪个页面？
- 本次只审了 API 层与角色定义；**页面级白名单（6 个 layout）与 API 的一致性尚未逐条核对**
  （例如某页面允许 FINANCE 进入，但它调的接口不允许 FINANCE，表现是页面能开但数据全 403）。
  T5 会顺带把这件事做掉一半：边界就是从页面白名单反推的。
- ~~`/classic/print` 的 layout 没有任何角色判定~~ → T5 已在 middleware 页面层堵上
  （只有 OPERATOR/BOSS/FINANCE/DISPATCH 进得去）。layout 本身仍然没有判定，
  哪天有人绕过 middleware（例如改了 matcher）就又敞开了 —— 建议补一道。
- **本轮改动尚未部署**。全部验证都在本地 dev + 生产库只读核对上完成，
  生产跑的还是 `5aba1e5`。部署后要做的两件事：
  ① 用 `scripts/audit/rbac-probe.ts` 打生产刷新 `rbac-snapshot.json`；
  ② 找一个真实司机账号走一遍「打开行程 → 签收 → 交账」。
