# 性能卡点清除台账

> 依据：`docs/20260805-slow-pages-audit.md`（全站实测）
> 目标：把所有「超过正常网站访问速度」的页面压到 2 秒以内，并消除 OOM 事故风险。
>
> **一周期 = 一条任务：做 → 验证（实测数字，不是"看着快了"）→ 提交 → 回写。**

## 基线（2026-08-05 修复前，服务器本机实测）

| 页面 | 打开等待 | 元凶 |
|---|---:|---|
| `/classic/finance` | 15.8 s | `/api/invoices` 74 MB |
| `/classic/operator/invoices` | 15.2 s | 同上 |
| `/classic/operator/quotations` | 3.8 s | `invoices?slim=1` 3.2 MB + `orders` + `products` |
| `/classic/operator/orders` | 2.7 s | `orders` + `invoices?slim=1` |
| `/classic/warehouse` | 1.0 s | `products` 3.6 MB |

内存：单次 `/api/invoices` 让容器从 408 MB → **1.091 GiB**（上限 1.465 GiB）。

---

## 已查明的事实（影响方案选择）

- ✅ `/api/orders` **已有分页**（`page`/`pageSize`，不传则 flat array）—— 调用方没用而已
- ✅ `/api/goods-receipts` **已有分页**（默认 `limit=100`）—— 6.2 MB 是因为每条含大 payload，非全表
- ✅ `/api/customers` 已有 `slim=1` 与分页 —— **这是本仓库的既有范式，新改动照抄它**
- ⛔ `/api/invoices` 完全没有分页，也没有上限
- ⛔ `/api/products` 完全没有分页，且 `include` 很重

### 四个 invoices 调用方各自真正需要什么

| 页面 | 现在拉 | 其实只需要 |
|---|---|---|
| `/classic/finance` | 全部 148,285 张 | **按客户汇总的未付金额**（DRAFT+POSTED 的 `amountDue`）→ 1,605 行聚合 |
| `/classic/operator/invoices` | 全部 | 当前页 50 条 + 总数；另需「该客户未开票的已完成订单」 |
| `/classic/operator/orders` | `slim=1` 全部 | 当前列表里那些订单**开票了没有** |
| `/classic/operator/quotations` | `slim=1` 全部 | 同上 |

**没有任何一个调用方真的需要 14 万张发票的全字段。**

---

## 任务

- [x] **T1 ✅ 2026-08-06** `/api/invoices` 加分页与硬上限 + 新增聚合/反查接口

  1. `?page&pageSize` 服务端分页（照抄 `/api/customers` 的形状：不传 `pageSize` → flat array 兼容旧调用）
  2. ⛔ **flat array 分支加硬上限**（`take: 500`）——即使前端没改，也不允许任何调用方拉爆内存
  3. `slim=1` 增加 `orderIds=` 过滤，只回传涉及这些订单的发票
  4. 新增 `GET /api/invoices/ar-summary` → 按客户聚合未付金额，服务端 `groupBy`

  **实测**：`/api/invoices`（无参）74 MB → **245 KB / 0.8 s**；
  `ar-summary` **13 KB / 368 ms**；分页 `total=148285` 与库中实际条数一致。
  鉴权走 middleware 兜底，实测未授权 401。

- [x] **T2 ✅ 2026-08-06** 改造 4 个调用方页面

  **数字核对**（不是"页面能打开"）：
  `ar-summary` 返回 **658 个客户 / 合计 €9,867,109.23**，与直接查库
  `sum(amountDue) where status in (DRAFT,POSTED)` **完全一致**。

  ⛔ **途中发现一个地雷**：发票号是 `INV-${invoiceCount+1}`，而 `invoiceCount` 一直取自
  **前端数组长度**。加上 FLAT_LIMIT 后它会变成 500，新发票号必然与已有的撞车
  （`Invoice.name` 有唯一约束）。已改成用服务端返回的 `total`，实测 `total=148285`
  → 下一张 `INV-148286` 正确。**这就是"以为只是加个 take"会踩的坑。**

  **页面实测**（服务器本机，与基线同口径）：

  | 页面 | 修复前 | 修复后 | 降幅 |
  |---|---:|---:|---:|
  | `/classic/finance` | 15.8 s | **1.05 s** | ↓93% |
  | `/classic/operator/invoices` | 15.2 s | **0.59 s** | ↓96% |
  | `/classic/operator/orders` | 2.7 s | **0.64 s** | ↓76% |
  | `/classic/operator/quotations` | 3.8 s | **1.86 s** | ↓51% |

  **OOM 风险已消除**：5 个并发打开发票页，内存 124 MiB → 峰值 **205 MiB**
  （修复前单次请求就 1.09 GiB，上限 1.465 GiB）。`OOMKilled=false`、`RestartCount=0`。

- [x] **T3 ✅ 2026-08-06** `/api/products` 加 `slim=1`，7 个页面已切过来

  服务端已实现且不破坏现有调用方（不传 `slim` 字段逐字相同）。
  但**实测只从 3.57 MB 降到 2.24 MB（-37%），达不到 <500 KB 的验收线**：
  5,480 条 × 每条 445 字节，其中**字段名本身重复 5,480 次就占了大头**
  （`canBePurchased` 这一个 key 就 131 KB）。裁字段的收益天花板到了。

  最终 **3.57 MB / 1.47 s → 2.30 MB / 0.85 s**。达不到最初定的 <500 KB，
  但**页面级目标已经达成**（见 T6），所以没有继续往「搜索式下拉框」那条大改上走。

  已切换的 7 个页面：`restaurant`、`warehouse`、`inventory/adjustments`、
  `purchases/new`、`purchases/[id]`、`print/day-wise-report`、`quotations`。
  切之前逐页核对过 slim 缺的 11 个字段一个都没被引用。

  `images` 特意留在 slim 里：实测全库 5,480 条**全是空数组**、总共才 74 KB，
  而少了它下单页就没法显示商品图，得为一个字段再开一套接口。

- [x] **T3c ✅ `/api/goods-receipts` —— 扫描中新发现的最大一处**
  23 条收货单 6.06 MB，其中 `photos` 占 **6.02 MB（99%）**：取证照片是 base64
  data URI 直接内联在 JSON 里，而列表默认全是折叠的，照片只在展开某条时才显示。

  改为列表只给 `photoCount`、展开时用 `?id=` 单独取。

  ⛔ **中间踩了一次**：第一版只是把 `photos` 从结果里 `map` 掉，体积确实从 6.06 MB
  降到 14 KB，**但耗时几乎没变（1.18 s）** —— Prisma 依然把 6 MB 从数据库读了出来，
  省的只是「Node→浏览器」，「DB→Node」照传不误。改用 `select` 显式列字段后
  **1184 ms → 47 ms**。**体积降了不等于变快了，要看瓶颈在哪一段。**

- [x] **T4 —— 无需改动，我上一轮判断错了**
  我说它「没有加载反馈，容易被当成卡死而重复点击」。实际上前端早有 `exporting`
  状态：`if (exporting) return` 防重复点击，按钮文案也会变成「导出中…」。
  当时只看了接口耗时没看前端代码。

- [x] **T5 ✅ 2026-08-06 分析类接口缓存**（16 个路由全部接入）

  `lib/analytics/cache.ts` —— 进程内 LRU + TTL。缓存的是**序列化之后的字符串**
  而不是对象：命中时连 `JSON.stringify` 都不跑，而序列化正是这台 2 vCPU 机器上的
  实际瓶颈（`/api/orders` 872 ms 里数据库只占 121 ms）。

  **实测（服务器本机）**：

  ```
  /api/analytics/margin?from=2026-01-01&to=2026-08-01   MISS 1.632s → HIT 0.019s   （86×）
  /api/analytics/customers?from=2026-06-01&to=2026-07-31 MISS 0.249s → HIT 0.014s
  ```

  TTL 分两档，实测验证过：区间**覆盖到今天** → 60 秒（老板盯着今日销售额，
  不能几分钟不动）；**纯历史区间** → 15 分钟（这些数字不会再变）。

  内存保护（刚修完 OOM，缓存不能变成新的内存问题）：单条 > 2 MB 不缓存、
  最多 100 条、超出按 LRU 淘汰。13 个测试锁住这些约束。

  ⛔ **缓存 key 带上 roles**：目前 `/api/analytics/*` 都不做行级过滤，理论上不带也
  不会串。但哪天有人加了「SALES 只看自己客户」而忘了改这里，缓存就会把 A 业务员的
  数字发给 B —— 那是数据泄露，不是性能问题。代价只是同一份数据按角色多存几份。

  **接入方式踩过一次**：第一版用正则把路由改写成
  `withAuth(req, (user) => withAnalyticsCache(...))`，结果把 `withAuth` 的第三个参数
  `allowedRoles` 一起吃进了内层调用，**16 个文件全错**，已回滚重做。
  改成 `withCachedAuth` —— 签名与 `withAuth` 完全一致，接入只需把函数名改掉。
  已逐个核对 16 个路由的 `allowedRoles` 全部保留。
  **能靠「只改函数名」完成的事，就不要去改调用结构。**

- [x] **T7 ✅ 2026-08-06 `resolveDateRange` / `toDayKey` 时区口径**

  **两个问题，第二个才是业务上真正要紧的：**

  1. 原实现 `new Date('2026-01-01')` 再 `.setHours(0,0,0,0)` —— 前者按 **UTC** 解析
     date-only 字符串，后者按**进程本地时区**生效。生产容器是 UTC 所以碰巧不显现；
     本机（UTC-4）实测差 **19 小时**，这正是之前记录的「2025-12 串进 2026-01~07」。

  2. **日切分口径**：客户是爱尔兰实体，日报/波次/交账都按都柏林的业务日切，
     而原来按 UTC 切。`confirmationDate` 是 `timestamp without time zone`、
     存的是 **UTC 墙上时间**，所以都柏林 00:00–01:00 下的单（夏令时）在 UTC 眼里
     还是前一天。实测 **1,909 张订单（1.27%）** 被算到了相邻的错误日期上。

  **修复后与 SQL 口径逐日核对，边界完全一致**：

  ```
  业务日 2026-07-10   旧(按UTC) 113 单  →  新(按都柏林) 112 单
  业务日 2026-07-09   旧 165 单        →  新 179 单
  业务日 2026-07-08   旧 151 单        →  新 139 单
  resolveDateRange('2026-07-09') → 2026-07-08 23:00 ~ 2026-07-09 23:00（UTC 墙上时间）
                                    与 SQL 的都柏林业务日边界一字不差
  ```

  ⚠️ **这意味着日报数字会变** —— 是修正，不是引入偏差，但需要知会业务方。

  实现用 `Intl` 做无依赖时区换算（不引入 date-fns-tz / luxon，符合部署铁律）。
  `toDayKey` 一并改成同口径 —— 一个按都柏林切范围、另一个按 UTC 打 key 的话，
  边界那天的数据会落到范围外的 key 上，表现是「总数对得上但按天加起来少一截」。

  12 个测试锁住，其中最关键的一条是**在 UTC / New_York / Tokyo 三个时区下跑出相同结果**。

- [x] **T6 ✅ 回归验证**

  **全站 56 个页面（服务器本机，只统计页面加载时真正会发的 `apiGet`）：**

  ```
  >2s: 0        1-2s: 1（place-order 1178ms）        <1s: 55
  ```

  | 页面 | 修复前 | 修复后 |
  |---|---:|---:|
  | `/classic/finance` | 15.8 s | **0.66 s** |
  | `/classic/operator/invoices` | 15.2 s | **0.51 s** |
  | `/classic/operator/inventory/receive` | 3.03 s | **0.05 s**（接口 1184→47 ms） |
  | `/classic/operator/quotations` | 3.8 s | **0.69 s** |
  | `/classic/operator/orders` | 2.7 s | **0.64 s** |

  **OOM 风险已消除**：5 个并发打开发票页，内存 124 MiB → 峰值 205 MiB
  （修复前单次请求就 1.09 GiB / 上限 1.465 GiB）。`OOMKilled=false`、`RestartCount=0`。

  ⛔ **修正一个测量方法的错误**：早先的扫描把页面里出现的**所有** `'/api/xxx'`
  字面量都当 GET 测了，其中混进了 `apiPost` 的端点。`restaurant` 与 `place-order`
  只有 `POST /api/orders`（下单用），根本不在加载时调用，却被算成 1.7–2.1 秒的
  「慢页面」，害我差点去优化一个不存在的问题。改成只提取 `apiGet(...)` 后重扫才是真相。
  **拿假数据汇报比不汇报更糟。**

---

## 进度回写区

| 任务 | 完成时间 | 证据 | 备注 |
|---|---|---|---|
| （待填） | | | |

## 未解决问题

- 无
