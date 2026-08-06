# 哪些页面/列表会慢——全站实测

> 测量时间：2026-08-05 · 生产数据（`Order` 149,874 · `OrderLine` 1,337,568 · `Invoice` 148,285）
> 方法：79 个 GET 接口逐个实测（3 次取最好）+ 按页面真实调用并行模拟「打开页面要等多久」
> 测量点：**服务器本机**（`127.0.0.1`，剥离网络）。真实用户还要加上传输时间，见 §4。

---

## 0. 一句话结论

**页面本身（SSR HTML）全都很快，190–360 ms。慢的 100% 在页面出来之后的数据加载。**

用户的体感是「页面框架秒开，然后一直转圈」。

只有 **2 个页面**属于「明显不正常」，且都是同一个原因：`/api/invoices` 无分页返回全部 148,285 张发票。

---

## 1. 页面打开要等多久（服务器本机，已剥离网络）

| 页面 | 总等待 | 判定 | 元凶 |
|---|---:|---|---|
| **财务台账** `/classic/finance` | **15.8 s** | ⛔ 严重 | `/api/invoices` 15.76 s |
| **发票列表** `/classic/operator/invoices` | **15.2 s** | ⛔ 严重 | `/api/invoices` 15.12 s |
| **报价单列表** `/classic/operator/quotations` | **3.8 s** | ⚠️ 偏慢 | `invoices?slim=1` 3.7 s + `orders` 3.7 s + `products` 2.9 s |
| **销售单列表** `/classic/operator/orders` | **2.7 s** | ⚠️ 偏慢 | `orders` 2.6 s + `invoices?slim=1` 2.6 s |
| 仓库 `/classic/warehouse` | 1.0 s | ✅ 可接受 | `products` 0.93 s |

> 这几个页面的接口是**并行**发出的，所以总等待 ≈ 最慢的那一个，不是相加。

---

## 2. 单个接口排名（79 个 GET 接口实测，只列 >100 ms 的）

| 毫秒 | 响应体 | 接口 | 备注 |
|---:|---:|---|---|
| **17,669** | 1.5 MB | `/api/orders/export-csv` | 用户点「导出」才触发，非页面加载 |
| **10,250** | **74 MB** | `/api/invoices` | ⛔ 见 §3 |
| 1,628 | 279 KB | `/api/print/day-wise-report-pdf` | Chromium 渲染，点击才触发 |
| 1,192 | 6.2 MB | `/api/goods-receipts` | 无分页 |
| 786 | 3.6 MB | `/api/products` | 无分页，被 8+ 页面调用 |
| 548 | 165 KB | `/api/analytics/ar-aging` | 应收账龄，可接受 |
| 501 | 3.7 MB | `/api/orders` | 无分页 |
| 299 | 5.5 KB | `/api/analytics/overview` | 正常 |
| 201 | 180 KB | `/api/analytics/margin` | 聚合 19 万行，属真实计算量 |
| 155 | 1.3 MB | `/api/customers` | 无分页但字段少 |
| 139 | 948 KB | `/api/credit-notes` | — |

其余 68 个接口全部 **< 100 ms**，没有问题。

---

## 3. ⛔ `/api/invoices` —— 不只是慢，是一颗定时炸弹

```ts
// app/api/invoices/route.ts:24  —— 没有 take / skip / select
const invoices = await prisma.invoice.findMany({
  where: customerId ? { customerId } : undefined,
  orderBy: { createdAt: 'desc' },
})
```

一次返回 **148,285 张发票的全部字段 = 74 MB**（gzip 后 11.9 MB）。

### 比慢更严重的是内存

实测单次请求期间，应用容器内存：

```
基线 408 MB  →  峰值 1.091 GiB
容器上限       1.465 GiB（今天刚加的 mem_limit: 1500m）
```

**两个人同时打开发票页面就会撑爆容器**，触发 OOM 重启，所有人的请求同时中断。

> 顺带说明：`mem_limit` 是今天加的。在加之前，这个请求会去吃宿主机内存，
> 而 OOM killer 会挑内存占用最大的进程杀 —— 那是 **PostgreSQL**。
> 也就是说这个上限恰好把「数据库被杀」降级成了「应用重启」。但根因还在。

### 调用方

| 页面 | 调用 | 影响 |
|---|---|---|
| `/classic/finance` | `/api/invoices` 全量 | ⛔ 74 MB |
| `/classic/operator/invoices` | `/api/invoices` 全量 | ⛔ 74 MB |
| `/classic/operator/orders` | `/api/invoices?slim=1` | ⚠️ 3.2 MB / 2.5 s |
| `/classic/operator/quotations` | `/api/invoices?slim=1` | ⚠️ 3.2 MB / 3.7 s |

`slim=1` 只 `select` 了 `id` + `saleOrderIds`，体积降到 3.2 MB，**但仍然是全表 148,285 行扫描**。
它存在的目的只是「判断某订单开没开过票」——为这个目的拉 14 万行，方向就不对。

---

## 4. 真实用户体感要在上表基础上再加传输时间

上面的数字是**服务器本机**测的。客户在爱尔兰、机房在伦敦，RTT 约 10–20 ms（很好），
但 11.9 MB 的数据要真的传过去：

| 客户网络 | `/api/invoices` 额外传输时间 | 页面总等待 |
|---|---:|---:|
| 办公室宽带 100 Mbps | ≈ 1 s | **≈ 17 s** |
| 一般宽带 20 Mbps | ≈ 5 s | **≈ 21 s** |
| 4G 移动网络 | ≈ 10 s+ | **≈ 26 s** |

作为对照，一个正常的业务列表页首屏应该在 **1–2 秒**内可用。

---

## 5. 修复建议（按性价比）

### P0：`/api/invoices` —— 必须改，有事故风险

三条路，从改动小到大：

1. **页面改成按需查询**（推荐先做这个）
   `/classic/finance` 与 `/classic/operator/invoices` 都是列表页，本来就该分页 +
   按客户/日期筛选，而不是把 14 万张全拉到浏览器再前端过滤。

2. **`slim=1` 换成反查**
   两个列表页用 `slim=1` 只为判断「订单开票没有」。应该改成
   `GET /api/invoices/by-orders?orderIds=a,b,c`（只查当前页那 20 张单），
   或者干脆在 `/api/orders` 的返回里带一个 `invoiceId` 字段。
   前者不改数据模型，后者更彻底。

3. **API 兜底加上限**
   即使前端还没改，也该在路由里加一个默认上限（比如 `take: 500`）+
   显式分页参数，避免任何调用方能一次拉爆内存。这是防御性的，应该做。

### P1：`/api/products`、`/api/orders`、`/api/goods-receipts` 同样无分页

`/api/products` 被至少 8 个页面在加载时调用（3.6 MB / 786 ms）。
最省事的第一步是**加 `select` 裁字段**——下拉框场景不需要 `template.images`、
税率、采购单位这些。`/api/customers` 的 `slim=1` 就是现成先例，**不改任何调用方**。

### P2：`/api/orders/export-csv` 17.7 秒

用户点击后要干等 17 秒且没有进度反馈，容易被当成卡死而重复点击（每点一次多一个
17 秒的请求压在 2 vCPU 上）。建议：加载中禁用按钮 + 明确提示，或改成异步生成后下载。

### P3：分析类接口加缓存

`/api/analytics/*` 大多在 100–550 ms，属正常。但它们的输入是历史订单，天然可缓存，
加 5–15 分钟 TTL 能直接缓解 2 vCPU 的压力。

---

## 6. 不用管的

- **页面 SSR** 190–360 ms，健康
- **68 个接口 < 100 ms**，健康
- **PostgreSQL** heap 命中率 98%，`/api/invoices` 的 10 秒里数据库只占很小一部分，
  绝大部分是 Node 序列化 74 MB JSON —— **这是应用层问题，不是数据库问题**
- **`/api/analytics/margin`** 约 200 ms，聚合 19 万行属于真实计算量，不是 bug
