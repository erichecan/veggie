# 单系统部署下的内存重算与性能优化分析

> 前提变更（2026-08-02）：**Odoo 12 不再部署到这台 DO 服务器，只放新系统**；
> 且**数据库也迁离 Neon**，改为服务器上自建 PostgreSQL。
> 这两条合起来推翻了 `docs/20260802-private-deployment-server-enablement-plan.md` §2 B2 的内存结论，
> 并且把性能模型从「跨机房调用」变成「本机调用」，量级不同，故单列本文。
> 所有数字为实测，测量方法见文末。

---

## 1. 内存重算：3.8 GB 够用，不必升配

原计划因为要同机跑 Odoo 12 + 两套 PostgreSQL，结论是「必须升到 8 GB，否则 OOM killer 会杀掉 Odoo 或某个 PG」。去掉 Odoo 之后重算：

| 进程 | 内存 | 说明 |
|---|---|---|
| 操作系统 + fail2ban + unattended-upgrades | ~450 MB | 实测当前占用 |
| Next.js（standalone，常驻） | 350–500 MB | |
| **PostgreSQL 17** | ~1.2 GB | `shared_buffers=1GB` + 连接与工作内存 ~200MB |
| Nginx | ~50 MB | |
| **稳态合计** | **≈ 2.05–2.2 GB** | |
| Chromium 渲染 PDF 时瞬时叠加 | +300–500 MB | 打印汇总单/发票时 |
| **峰值** | **≈ 2.4–2.7 GB** | 余量 1.1–1.4 GB |

**结论：3.8 GB 舒适，无需升配。** 但仍建议加 2–4 GB swap 作为兜底（零成本，防止极端并发下 OOM）。

### 更重要的推论：整个数据库可以常驻内存

生产库实测 **880 MB**（`OrderLine` 644MB/1,337,567 行 · `Order` 131MB/149,874 行 · `Invoice` 69MB/148,285 行，索引占 375MB）。

`shared_buffers` 给到 1 GB 就**大于整个库**。这意味着预热之后：

- 稳态几乎零磁盘读
- 之前加的 pg_trgm GIN 索引（375MB 索引里的一部分）也整个在内存里
- 这是 Neon 上做不到的——那边是共享的多租户存储层

---

## 2. 性能：迁移本身带来的收益（一行代码都不用改）

### 2.1 实测基线

| 指标 | 实测值 | 测法 |
|---|---|---|
| Cloud Run → Neon 单次查询往返 | **14 ms** | 差值法：`/api/health`(含 1 次 SELECT 1) 最快 158ms − `/api/tile`(不查库) 最快 144ms，各取 15 次最小值，本地网络延迟在相减时抵消 |
| Cloud Run 冷启动 | **6.1 s** | 闲置后首次 `/api/health` |
| 订单列表一页 40 条 | **7 次查询** | Prisma query 事件计数 |
| 商品列表一页 50 条 | **4 次查询** | 同上 |

### 2.2 迁移后的变化

| 项 | 现在（Cloud Run + Neon） | 迁移后（同机 PostgreSQL） | 收益 |
|---|---|---|---|
| 单次查询网络往返 | 14 ms | ~0.05 ms（Unix socket） | **×280** |
| 订单列表纯网络等待 | 7 × 14 = **98 ms** | ~0.4 ms | 每次请求省 ~98 ms |
| 商品列表纯网络等待 | 4 × 14 = **56 ms** | ~0.2 ms | 每次请求省 ~56 ms |
| 冷启动 | **6.1 s**（`min-instances=0`） | **0**（常驻进程） | 用户感知最大的一项 |
| 磁盘 I/O | Neon 共享存储层 | 库全量在 shared_buffers | 稳态零读 |
| 协议开销 | Neon pooler + WebSocket | 原生 libpq | 去掉一整层 |
| 事务限制 | 单事务 5 s 上限（超时 P2028 回滚） | 无 | 批量脚本可用大事务，快一个数量级 |

**冷启动是用户感知最强的一项。** 现在按零费用策略配的是 `min-instances=0`，闲置 15 分钟后缩到 0，下一个用户要等 6 秒。迁到常驻服务器后这个问题直接消失——而这恰恰是「早上第一个开单的人」每天都会撞上的场景。

---

## 3. 需要改代码的优化（按收益排序）

迁移能解决网络与冷启动，但下面这几处是**算法层面的浪费，迁到哪都存在**。

### 3.1 商品列表每次请求都全表聚合 5,479 行 ⚠️ 收益最大

`app/api/product-templates/route.ts`：

```ts
// 无条件执行，用于算 alertCounts（负库存/低库存的角标数字）
const stockGroups = await prisma.product.groupBy({ by: ['templateId'], _sum: { qtyOnHand: true } })
```

这条在**每一次**商品列表请求里都跑一遍全表聚合，实测是该页最慢的一条查询。而它只为了给两个角标数字提供计数。

改法：拆成独立的轻量端点按需取，或用 `unstable_cache` 缓存 30–60 秒（库存角标不需要秒级实时）。

### 3.2 司机维度筛选无条件拉全表波次

`lib/orders-query.ts` 的 `driverNameClause`：

```ts
const [matchingWaves, allWaves] = await Promise.all([
  prisma.pickingWave.findMany({ where: { driverName: like(term) }, select: { orderIds: true } }),
  prisma.pickingWave.findMany({ select: { orderIds: true } }),   // ← 没有 where，全表
])
```

`allWaves` 拉出**所有**波次的 `orderIds` 数组，用来算「不在任何波次里的订单」。当前 `PickingWave` 只有 51 行，代价 0.06 ms，不痛。但这张表按天线性增长（每司机每时段一条），一年后是数千行，每行还带一个订单 ID 数组。

改法：把「不在任何波次」改写成 `NOT EXISTS` 子查询交给数据库，不要把全表拉进 Node 内存做集合运算。

### 3.3 `PickingWave.orderIds` 缺 GIN 索引

实测：`orderIds && ARRAY[...]` 走 **Seq Scan**。该表现有 6 个索引，没有一个覆盖 `orderIds` 数组。

而 `attachWaveDisplay`（订单列表、CSV 导出、发票 PDF、行程打印都在用）每次都做这个数组匹配。

改法：`CREATE INDEX ... USING gin ("orderIds")`。现在 51 行无所谓，但这是随时间必然劣化的形状，且加索引成本极低。

### 3.4 订单列表拉全量订单明细

订单列表 `include: { lines: true }`，一页 40 单会带出约 360 行明细，但列表页只显示汇总。

改法：列表页只取聚合（行数、金额），明细留给详情页；或用 `select` 精简字段。

### 3.5 已完成 ✅

ILIKE 子串搜索的 pg_trgm GIN 索引（2026-08-02，`OrderLine.productName` 2588ms → 266ms）。

---

## 4. 服务器侧调优建议

### PostgreSQL（3.8 GB 机器，库 880 MB）

```conf
shared_buffers = 1GB              # 大于整个库，预热后零磁盘读
effective_cache_size = 2GB        # 告诉规划器可用的总缓存
work_mem = 16MB                   # 排序/哈希；连接数不高，可给足
maintenance_work_mem = 256MB      # VACUUM / CREATE INDEX
random_page_cost = 1.1            # SSD，默认 4.0 是机械盘假设
effective_io_concurrency = 200    # SSD
max_connections = 50              # 单应用，不需要几百
```

`random_page_cost` 这条常被忽略：默认值 4.0 是按机械盘定的，会让规划器**过度偏向 Seq Scan 而不用索引**。SSD 上调到 1.1 往往直接改变执行计划。

### 应用侧

- Next.js standalone 常驻，`min-instances` 概念消失，无冷启动
- Nginx 开 gzip/brotli，静态资源 `Cache-Control: immutable`
- Prisma 连接池：本机 PG 无需 pooler，直连即可
- 加 2–4 GB swap（`vm.swappiness=10`）作为兜底

---

## 5. 预期效果

以订单列表一次请求为例（当前生产实测约 650 ms）：

| 构成 | 现在 | 迁移后 | 迁移+代码优化 |
|---|---|---|---|
| 冷启动（首次） | 6100 ms | 0 | 0 |
| DB 网络往返 ×7 | 98 ms | ~0.4 ms | ~0.4 ms |
| DB 执行 | 视查询而定 | 全内存，更快 | 更少查询 |
| 应用与传输 | 不变 | 不变 | 不变 |

**最显著的两项：冷启动消失、每次请求省掉约 100 ms 的纯等待。** 代码层的三处浪费（3.1–3.3）不改也能迁，但改了是叠加收益，且 3.2/3.3 属于「不改会随时间劣化」的形状。

---

## 附：测量方法

- **网络往返**：差值法，同一网络路径上「含 1 次 DB 查询的接口」减「不含 DB 的接口」，各取 15 次最小值，本机延迟相减抵消。
- **查询次数与耗时**：Prisma `log: [{emit:'event', level:'query'}]` 逐条记录。注意本机测得的单条耗时含约 100 ms 本地→法兰克福网络，比较时需扣除。
- **执行计划**：生产库 `EXPLAIN (ANALYZE, BUFFERS)`。
- **库与表大小**：`pg_database_size` / `pg_total_relation_size`。
- **内存基线**：服务器 `free -h` 实测。
