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

- [ ] **T1（P0）`/api/invoices` 加分页与硬上限 + 新增聚合/反查接口**

  1. `?page&pageSize` 服务端分页（照抄 `/api/customers` 的形状：不传 `pageSize` → flat array 兼容旧调用）
  2. ⛔ **flat array 分支加硬上限**（`take: 500`）——即使前端没改，也不允许任何调用方拉爆内存
  3. `slim=1` 增加 `orderIds=` 过滤，只回传涉及这些订单的发票
  4. 新增 `GET /api/invoices/ar-summary` → 按客户聚合未付金额，服务端 `groupBy`

  **验收**：`/api/invoices` 响应 < 1 MB、< 500 ms；`ar-summary` < 100 ms；
  单次请求内存增量 < 100 MB；鉴权与 `/api/invoices` 一致（不能新开一个匿名口子）。

- [ ] **T2（P0）改造 4 个调用方页面**

  **验收**：4 个页面功能不变（应收金额、未开票订单、开票状态标记全部与修复前一致），
  打开时间 < 2 s。⛔ 必须逐页核对数字，不能只看"页面能打开"。

- [ ] **T3（P1）`/api/products` 加 `slim=1` 裁字段**

  8+ 个页面在加载时调它。下拉框场景不需要 `images`/税率/采购单位。
  **验收**：`slim=1` 响应 < 500 KB；不传 `slim` 时字段与现在完全一致（不破坏现有调用方）。

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
