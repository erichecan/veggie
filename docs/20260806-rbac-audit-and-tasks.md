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

## 4. ⛔ 需要你决策的三件事（阻塞 T3 及之后）

这三条是业务规则，我不能替你定：

1. **RESTAURANT 角色到底能访问什么？**
   建议：**只能走 `/api/customer-portal/*`，所有内部接口一律 403**。
   需要你确认现有客户门户功能是否够用（下单、看自己订单、常购清单）。

2. **SALES 的隔离要不要真正生效？**
   现在 19 个 SALES 全兼任 OPERATOR，隔离形同虚设。三个选项：
   - (a) 去掉这些人的 OPERATOR 角色 → 隔离生效，但他们可能会失去某些日常功能
   - (b) 保持现状，承认「SALES 能看全部客户」是有意为之，把那段隔离代码删掉（否则误导后人）
   - (c) 改判定：只要有 SALES 就隔离，不管有没有 OPERATOR

3. **`DISPATCH` / `OTHER` 两个角色还要不要？**
   schema 里有、当前 0 用户、`permissions.ts` 里没定义。
   要么补进权限矩阵，要么从 schema 移除 —— 留着不管是给将来埋雷。

---

## 5. 任务

- [ ] **T1 建立权限探针（先做这个，否则后面每次改动都无法验证）**

  `scripts/audit/rbac-probe.ts`：为每个角色签发 token，遍历全部 API 路由，
  产出「角色 × 端点 → 状态码」矩阵，与快照比对。
  **验收**：能一条命令跑出当前矩阵；把本文 §1 的越权全部复现出来；
  输出可 diff（后续每次整改都跑，一眼看出哪些格子从 200 变 403）。

- [ ] **T2 补齐角色定义一致性（低风险，先清掉）**

  `permissions.ts` 的 `Role` 补上 `DISPATCH`/`OTHER`（或按 §4-3 的决策移除）。
  **验收**：新增一个测试，从 `prisma/schema.prisma` 读 `enum Role` 与
  `lib/types.ts`、`lib/permissions.ts` 三处比对，不一致就失败 —— 让它以后不可能再漂移。

- [ ] **T3 ⛔ 给 RESTAURANT 砌墙（最高优先级，阻塞于 §4-1）**

  在 middleware 或统一 wrapper 层做：`RESTAURANT` 角色只放行
  `/api/customer-portal/*` + `/api/auth/*`，其余 `/api/*` 一律 403。
  **验收**：用 T1 的探针，RESTAURANT 那一列除客户门户外全部 403；
  且客户门户的下单/查单/常购清单**功能不变**（要真跑一遍，不是只看状态码）。

- [ ] **T4 `driver-slots` 补 `withAuth` + 角色**（3 个 handler，独立小改）
  **验收**：非 OPERATOR/BOSS 调用返回 403；运营页面功能不变。

- [ ] **T5 给 60 个写操作补 `allowedRoles`**

  按资源分批，每批一次提交 + 跑探针：
  `waves`(13) → `orders`(9) → `trips`(4) → 商品域(9) → 其余。
  **验收**：每批改完探针无意外 403；对应岗位的页面实际操作一遍不报错。
  ⚠️ 分批做，不要一次性批量替换 —— 参考上一轮「正则改 16 个路由把 allowedRoles 吃掉」的教训。

- [ ] **T6 给 39 个 GET 补 `allowedRoles`**
  风险低于写操作但影响面更广（读接口被更多页面调用），放在写操作之后。

- [ ] **T7 SALES 隔离定案**（阻塞于 §4-2）

- [ ] **T8 把探针纳入 CI**
  **验收**：任何一个路由的角色可达性发生变化，CI 必须失败并显示 diff。

---

## 6. 进度回写区

| 任务 | 完成时间 | 证据 | 备注 |
|---|---|---|---|
| 审计本身 | 2026-08-06 | 本文 §1/§2 | 实测越权已确认；误建的 1 条价格表已清理 |

## 7. 未解决问题

- §4 的三个决策未定，T3/T7 阻塞
- 本次只审了 API 层与角色定义；**页面级白名单（6 个 layout）与 API 的一致性尚未逐条核对**
  （例如某页面允许 FINANCE 进入，但它调的接口不允许 FINANCE，表现是页面能开但数据全 403）
