# 新服务器性能基线与优化分析

> 测量时间：2026-08-05 · 目标机 `167.99.86.19`（DO 2 vCPU / 3.8 GB / 无 GPU，lon1）
> 数据：生产全量（`Order` 149,874 · `OrderLine` 1,337,568 · 库 657 MB）
> 测量端：本机（多伦多）→ 伦敦，RTT ≈ 90–175 ms；以及服务器本机（剥离网络）

---

## 0. 结论先行

| 发现 | 量级 | 状态 |
|---|---|---|
| **Nginx 完全没有压缩** | JSON 裸传，`/api/products` 3.5 MB | ✅ **已修**，压缩比 8–10:1，外网延迟降 30–40% |
| **`/api/products` 没有分页** | 全表 5,479 条 + 重 include，单次 740 ms DB + 3.5 MB | ⛔ 需改代码，**最大的剩余问题** |
| **2 vCPU 在 8 并发时饱和** | `/api/health` 从 10 ms 涨到 383 ms | ⚠️ 由上一条主导，先修它 |
| 毛利分析 ~1 s | 聚合 191,484 行 → 1,769 组 | 合理开销，建议缓存而非加索引 |
| `Order.confirmationDate` 无索引 | — | ❌ **实测加了没用**，见 §4 |
| PostgreSQL 调参 | heap 命中率 98.09% | ✅ 无需调整 |

---

## 1. 空闲状态延迟（各跑 5 次取中位）

| 端点 | 服务器本机 | 外网（压缩前） | 外网（压缩后） | 响应体 |
|---|---:|---:|---:|---:|
| `/api/health` | 10 ms | 200 ms | 189 ms | 104 B |
| `/api/orders?limit=20` | 48 ms | 425 ms | **263 ms** | 87 KB → 8.9 KB |
| `/api/products` | 849 ms | 1893 ms | **1285 ms** | 3.5 MB → 433 KB |
| `/api/customers` | 140 ms | 1027 ms | **639 ms** | 1.3 MB → 151 KB |
| `/api/analytics/margin`（1 个月） | 195 ms | 667 ms | **568 ms** | 180 KB → 55 KB |
| `/`（首页 HTML） | 45 ms | 258 ms | 227 ms | 7.3 KB |

**怎么读这张表**：本机列 = 应用真实开销；外网列减去本机列 ≈ 网络 + 传输。
压缩前 `/api/products` 有 **1044 ms 花在把 3.5 MB 推过大西洋**，纯属浪费。

> 网络那部分对客户不适用 —— 客户在爱尔兰，到伦敦机房 RTT 大约 10–20 ms，
> 不是我这里的 90–175 ms。**表里的外网列是悲观值**，客户实际体验会明显更好。
> 但"传 3.5 MB"这件事本身在哪都贵，尤其在移动网络上。

---

## 2. 并发压测（8 并发 × 30 秒，服务器本机发起，排除网络）

| 端点 | 请求数 | 平均 | 最慢 | 非 200 |
|---|---:|---:|---:|---:|
| `/api/health` | 65 | **383 ms** | 2035 ms | 0 |
| `/api/orders?limit=20` | 60 | 1305 ms | 3779 ms | 0 |
| `/api/customers` | 35 | 1387 ms | 2859 ms | 0 |
| `/api/products` | 27 | 1991 ms | 3862 ms | 0 |
| `/`（首页） | 31 | 767 ms | 2248 ms | 0 |

吞吐 **7.3 req/s**，零错误，负载 load average 升到 **2.19**（2 vCPU = 满载），
内存始终有 2.8 GB 可用。

**最有诊断价值的一行是 `/api/health`：空闲 10 ms，8 并发时 383 ms。**
这个端点只做一次 `SELECT 1`，它变慢 38 倍只可能是**在排队**——
Node 是单进程单事件循环，前面那些 3.5 MB 的 JSON 序列化把它堵住了。

**所以瓶颈是 CPU，不是内存。** 设计文档当初担心的是内存（3.8 GB 够不够），
实测下来内存宽裕（峰值占用 1.0 GB），真正的约束是 2 个核。

---

## 3. 已实施的优化

### 3.1 Nginx 压缩（✅ 已上线）

发行版默认配置里 `gzip on` 是开着的，**但 `gzip_types` 整段被注释掉**（默认只压 `text/html`），
且 `gzip_proxied` 默认是 `off` —— 本站所有内容都来自反向代理。
**两个原因叠加，等于一点没压。**

实测压缩比：

```
/api/products      3,572,973 → 433,253 B    8.2:1
/api/customers     1,311,883 → 151,360 B    8.7:1
/api/orders?limit=20  87,185 →   8,943 B    9.7:1
```

配置已纳入版本管理：`deploy/droplet/nginx-veggie.conf`（原先只存在于服务器上）。
`gzip_comp_level` 取 5 不取 9 —— 机器已经是 CPU 瓶颈，再高的压缩级别得不偿失。
压测复跑确认：吞吐 7.0 → 7.3 req/s，**压缩没有让 CPU 情况变差**。

同时给 `/_next/static/` 加了一年期 `immutable` 缓存（文件名自带内容哈希，安全），
省掉 Node 处理这些请求的 CPU。

### 3.2 服务器清理（✅ 已完成）

腾出 **3 GB**：删掉 4 个历史镜像 tag、82 MB 迁移 dump、125 MB apt 缓存、
以及只为验证拉的 `hello-world`/`alpine`/`postgres:17-alpine`。

更要紧的是加了**自动保留策略**（`remote-deploy.sh`）：每次部署新增 app 1.7 GB +
migrator 3.3 GB ≈ 5 GB，不清理的话 77 GB 的盘十来次部署就满，
而**磁盘满的表现是容器起不来、PostgreSQL 也写不了——一次故障干掉两样东西**。
策略是「只留当前 + 上一个 tag」，而不是按时间删——按时间删会在长期不部署时
把回滚目标一起删掉，恰好在最需要它的时候不工作。

---

## 4. 一个「测了才知道没用」的优化 —— 值得记下来

毛利分析全表扫 `Order`（149,874 行），而 `Order` 上有 `createdAt`、`deliveryDate`、`status`
的索引，**唯独没有查询实际用的 `confirmationDate`**。看起来是教科书式的缺索引。

建了 `(status, "confirmationDate")` 复合索引后：

```
计划确实改了：Order 全表扫 6 次 → 0 次，改走 Parallel Index Scan
接口耗时：    1.68/2.02/1.49 s  →  1.54/1.52/1.96 s     ≈ 没变
```

**原因**：查询的状态过滤是 `status IN ('LOCKED', …)`，而 149,874 张单里 **`LOCKED` 占 149,189 条（99.5%）**。
过滤条件命中几乎所有行时，**全表扫本来就是正确的计划**，索引只是让它多绕一圈。

索引已删除。**记这一条是因为：如果只看「有没有索引」而不实测，会加进一个纯负担的索引
（占 4.6 MB、拖慢每一次写入），还以为自己优化了。**

---

## 5. 剩余优化建议（按性价比排序）

### ⛔ P1：`/api/products` 没有分页 —— 最大的一块

```ts
// app/api/products/route.ts:28
const products = await prisma.product.findMany({
  include: { category: {...}, template: { ... uom: {...}, category: {...} } },
})   // ← 没有 take / skip
```

- 一次返回 **5,479 条**，DB 侧 740 ms（Product 499 ms + ProductTemplate 242 ms，
  Prisma 的 `include` 拆成了两条查询，各扫 5,479 行）
- 序列化出 **3.5 MB** JSON，把单线程的事件循环堵住
- 而且它被**至少 8 个页面在加载时调用**：`restaurant`、`warehouse`、`place-order`、
  `purchases/new`、`purchases/[id]`、`products/[id]`、`day-wise-report`、`customers/[id]`

**建议**（按实施难度递增）：

1. **加 `select` 裁剪字段** —— 下拉框场景根本不需要 `template.images`、税率、采购单位这些。
   已有 `slim=1` 这个先例（`/api/customers` 用它跳过 specialPrices JOIN），照抄即可。
   预计能砍掉一半以上体积，**且不改任何调用方**。
2. **加分页**（`page`/`pageSize`，默认给一个上限），调用方逐个改成按需拉取或搜索。
3. **给下拉框做专用轻端点** `/api/products/options` —— 只返回 `id`/`name`/`uom`，
   配合 `Cache-Control` 让浏览器缓存。

第 1 条投入最小、收益最大，建议先做。

### P2：给分析类接口加缓存

毛利分析 ~1 s 是**真实计算量**（聚合 191,484 行 OrderLine → 1,769 个商品分组），
不是 bug，也没有索引能救。但它的输入是**已完成的历史订单**，天然可缓存。

建议用 Next.js 的 `unstable_cache`（或应用内 LRU），按 `from|to|groupBy|colBy` 做 key，
TTL 给 5–15 分钟。命中时从 1 s 降到几毫秒，且直接缓解 CPU 瓶颈。

⚠️ 顺带：本次测量再次印证了 `resolveDateRange` 的时区问题
（`docs` 里已记录，见记忆 `resolvedaterange-tz-bug-20260801`）——
请求 `from=2026-01-01&to=2026-08-01` 实际聚合到了 191,484 行。做缓存前应先确认口径。

### P3：给应用容器加内存上限

`docker inspect` → `Memory=0`，**没有上限**。Node 内存失控时会吃光宿主机，
而 OOM killer 多半去杀内存占用最大的进程 —— **PostgreSQL**。一次故障干掉两样东西。

建议 `mem_limit: 1500m`：当前稳态占用 260 MB，`--max-old-space-size=768` 已限制堆，
1500m 留足余量，同时保证它先于数据库被杀（然后被 `restart: unless-stopped` 拉起）。

### P4：不建议现在做的事

| 想法 | 为什么先别做 |
|---|---|
| 起多个 Node 实例做负载均衡 | 只有 2 个核，多进程抢同样的 CPU，收益远小于「让每个请求少干活」。**先做 P1** |
| 调大 `shared_buffers` | heap 命中率已 98.09%，整库 657 MB < 1 GB，没有可优化空间 |
| 加更多索引 | 见 §4。先用 `pg_stat_statements` 定位，再实测收益 |
| 升级机器配置 | 在 `/api/products` 还在传 3.5 MB 的情况下加钱，是在为浪费付费 |

---

## 6. 附：诊断工具现状

`pg_stat_statements` 已启用（`/etc/postgresql/17/main/conf.d/98-pgss.conf`），
`track = all`，`max = 5000`。开销可忽略，建议长期留着——
没有它，"哪条 SQL 慢"只能靠猜。

常用查询：

```sql
-- 最耗时的语句
SELECT calls, round(total_exec_time::numeric,0) AS 总ms,
       round(mean_exec_time::numeric,1) AS 均值ms,
       round(rows::numeric/greatest(calls,1),0) AS 每次行数,
       left(regexp_replace(query,'\s+',' ','g'), 100) AS 语句
FROM pg_stat_statements WHERE query NOT LIKE '%pg_stat%'
ORDER BY total_exec_time DESC LIMIT 10;

-- 缓存命中率
SELECT round(100.0*sum(heap_blks_hit)/greatest(sum(heap_blks_hit)+sum(heap_blks_read),1),2)
FROM pg_statio_user_tables;

SELECT pg_stat_statements_reset();   -- 测量前清零
```
