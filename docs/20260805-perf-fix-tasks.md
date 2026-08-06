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

- [~] **T3 进行中** `/api/products` 加 `slim=1` 裁字段

  服务端已实现且不破坏现有调用方（不传 `slim` 字段逐字相同）。
  但**实测只从 3.57 MB 降到 2.24 MB（-37%），达不到 <500 KB 的验收线**：
  5,480 条 × 每条 445 字节，其中**字段名本身重复 5,480 次就占了大头**
  （`canBePurchased` 这一个 key 就 131 KB）。裁字段的收益天花板到了。

  → 结论：光裁字段不够，得**减少条数**。见 T3b。
  → 且目前还没有任何调用方用上 `slim=1`，所以线上尚未生效。

- [ ] **T3b（P1）`/api/products` 真正的解法**
  下拉框场景应该是「搜索式」而不是「一次拉 5,480 条到浏览器再前端过滤」。
  待定方案：服务端搜索端点（输入关键词返回前 50 条）+ 调用方逐个改。
  ⚠️ 涉及 8+ 个页面的 UI 行为，属大改，需先确认哪些页面真的需要全量（如批量编辑页）。

- [ ] **T4（P2）`/api/orders/export-csv` 17.7 s**
  加载中禁用按钮 + 明确提示，避免被当成卡死而重复点击（每点一次多压 17 s 在 2 vCPU 上）。

- [ ] **T5（P2）分析类接口加缓存**
  `/api/analytics/*` 输入是历史订单，天然可缓存。TTL 5–15 分钟。
  ⚠️ 做之前先确认 `resolveDateRange` 的时区口径（已知 bug）。

- [ ] **T6 回归验证**
  重跑 `docs/20260805-slow-pages-audit.md` 的全套测量，与基线对比；
  并发压测确认 OOM 风险消除。

---

## 进度回写区

| 任务 | 完成时间 | 证据 | 备注 |
|---|---|---|---|
| （待填） | | | |

## 未解决问题

- 无
