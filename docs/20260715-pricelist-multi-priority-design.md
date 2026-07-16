# 价格表多挂载 + 优先级 + default 模式改造 — 设计文档

日期：2026-07-15
状态：已批准，待实现

## 背景

客户对定价体系提出四点需求，经代码调研+真实数据测试后核对结果：

| # | 需求 | 现状 |
|---|---|---|
| 1 | `priceType='default'` 应该是"先查价格表，查不到再用 public price" | ❌ 实测代码是"完全跳过价格表，只用 public price"，影响 397 个客户 |
| 2 | 创建价格表页面同时显示 public price 和 cost price 供参考 | ⚠️ 只显示了 cost price（Variant/Template Cost），没有 public price 列 |
| 3 | 下单时价格提示按 pricelist → last price → public price 优先级带出 | ✅ 已实现（`lib/pricing-engine.ts` `resolveCustomerPrice`），服务端二次校验 |
| 4 | 客户可以挂多张价格表，按优先级取第一个命中的 | ❌ `Customer.pricelistId` 是单一字段，数据模型不支持 |

本次改造范围：**1 + 2 + 4**（附带清理 3 个 `priceType='pricelist'` 的脏数据客户）。第 3 项已实现，不用动。

## 数据模型变更

### 新增 `CustomerPricelist` 关联表

```prisma
model CustomerPricelist {
  id          String   @id @default(cuid())
  customerId  String
  pricelistId String
  sequence    Int      // 数字越小优先级越高，1 = 最高优先级
  createdAt   DateTime @default(now())

  customer    Customer      @relation(fields: [customerId], references: [id])
  pricelist   OdooPricelist @relation(fields: [pricelistId], references: [id])

  @@unique([customerId, pricelistId])
  @@index([customerId, sequence])
}
```

### `Customer.pricelistId` 字段

**删除**，不做新旧字段并存（避免同一事实两处存储，这个项目历史上已经因为字段分裂存储出过多次 bug，见 `docs/20260624-data-ownership-audit.md`）。所有读写点改为读 `CustomerPricelist` 关系。

### `Order.pricelistId` 字段

**不变**。它是下单那一刻实际命中的价格表快照，是历史订单的单一事实，跟"客户当前配置了哪些价格表"是两个不同的概念，不冲突、不合并。

### `Customer.priceType` 字段

值域不变（`multi` / `default` / `last`），但会清理 3 个当前值为 `pricelist`（非法值）的历史脏数据：有挂价格表的改成 `multi`，没有的改成 `default`。

## 定价引擎逻辑变更（`lib/pricing-engine.ts`）

`resolveCustomerPrice` 的价格表入参从单个 `pricelist` 改为客户按 `sequence` 排好序的价格表数组。新增链式解析：

```
resolveViaPricelistChain(product, orderedPricelists, allPricelists, qty):
    for pl in orderedPricelists:   // 已按 sequence 升序
        r = resolvePrice(product, pl, allPricelists, qty)
        if !r.isFallback: return r   // 命中第一张表就停
    return null   // 全部未命中
```

三种 priceType 的新算法：

- **default**：`resolveViaPricelistChain()` → 命中就返回；否则回退 public price（不查 last price）
- **multi**：`resolveViaPricelistChain()` → 命中就返回；否则查 last price；再否则回退 public price
- **last**：不变，跟价格表无关

客户专属特殊价格（`CustomerSpecialPrice`）依然是最高优先级，在两种模式前置判断，不受本次改动影响。

## 涉及文件清单

grep 全仓库定位到 12 个非生成代码文件读写 `pricelistId`：

| 文件 | 改动内容 |
|---|---|
| `prisma/schema.prisma` | 新增 `CustomerPricelist`；删除 `Customer.pricelistId` |
| `lib/types.ts` | `Customer.pricelistId` → `Customer.pricelists: {pricelistId, sequence}[]` |
| `lib/pricing-engine.ts` | 加 `resolveViaPricelistChain`；改 default/multi 分支 |
| `lib/server-pricing.ts` | 查客户时带出 `pricelists` 关系（按 sequence 排序）传入定价函数 |
| `app/api/customers/route.ts` | 创建客户时支持写入有序价格表数组 |
| `app/api/customers/[id]/route.ts` | 更新客户时整体替换 links（数量通常 1-3 条，不做增量 diff） |
| `app/api/orders/route.ts` | 下单时用新客户价格表关系算价 |
| `app/api/orders/[id]/route.ts` | 改单同上 |
| `app/api/customer-portal/orders/route.ts` | 客户自助下单同上 |
| `app/[locale]/classic/operator/customers/[id]/page.tsx` | 单选下拉 → 已选列表 + 上/下箭头调序 + 下拉添加新价格表 |
| `app/[locale]/classic/operator/place-order/page.tsx` | 建议价预览改用价格表链 |
| `app/[locale]/classic/operator/quotations/[id]/page.tsx` | 同上 |
| `app/[locale]/classic/operator/orders/[id]/page.tsx` | 同上 |
| `app/[locale]/classic/operator/pricelists/[id]/page.tsx` | 加 Public Price 参考列（需求 2） |
| `scripts/backfill-customer-pricelist.ts` | 复用/改造为本次迁移脚本 |

## UI：客户编辑页价格表配置

原来是单选 `<select>`。改为：

- 已挂价格表按优先级列表展示（第一条 = 最高优先级）
- 每行右侧：上移 / 下移 / 删除 按钮
- 列表下方：下拉框选择要新增的价格表（排除已在列表中的），选中即追加到末尾

选上/下箭头而不是拖拽：客户通常只挂 1-3 张价格表，拖拽对这么短的列表收益不大，箭头实现更简单、手机端也好用。

## 迁移方案

项目历史上 `prisma migrate dev` 在这个库因为 shadow DB 重放旧迁移会失败（见 `docs/` 历史记录），本次沿用已验证的方式：**`prisma db push` 加字段/新表 + 手写迁移 SQL + `prisma migrate resolve` 标记**，不用 `migrate dev`。

迁移步骤：

1. `db push` 建好 `CustomerPricelist` 表（先不删 `Customer.pricelistId`，保证旧代码在迁移窗口内还能跑）
2. 跑迁移脚本（dry-run 模式先打印将要生成的记录数和 3 个脏数据客户的修正结果，确认后再实际写入）：
   - 对 1526 个已有 `pricelistId` 的客户各生成一条 `sequence=1` 的 `CustomerPricelist` 记录
   - 3 个 `priceType='pricelist'` 的客户改成合法值
3. 应用层代码全部切到读 `CustomerPricelist` 关系
4. 确认应用层不再有代码读 `Customer.pricelistId` 后，再单独出一个迁移删除该字段

这个多步骤是为了避免"schema 改了但代码没跟上"导致的空档期报错——先双写窗口（新表已建、旧字段还在但不再新增使用），代码全部切完再删旧字段。

## 测试计划

- 单元级：复刻本次调研阶段用的纯函数测试方式（直接 import `lib/pricing-engine.ts` 跑多组场景），覆盖：
  - 客户挂 2 张价格表，第一张命中 → 用第一张的价格（不该继续查第二张）
  - 客户挂 2 张价格表，第一张未命中、第二张命中 → 用第二张
  - 客户挂 2 张价格表都未命中，priceType=multi → 查 last price
  - 客户挂 2 张价格表都未命中，priceType=default → 直接回退 public price，不查 last price
  - 客户 0 张价格表，priceType=default/multi → 都回退 public price
- 集成级：迁移脚本跑完后，抽查若干真实客户（用真实 customerId + 真实商品）调用服务端定价函数，确认结果跟迁移前该客户原来的单一 pricelistId 算出来的价格一致（迁移不应该改变任何客户当前已生效的价格，只是换了存储结构）
- UI 级：用 chrome-devtools（如果本次会话能连上）或至少读代码+截图方式确认客户编辑页新增/删除/调序价格表交互正常、价格表编辑页新增的 Public Price 列显示正确数值

## 不在本次范围内

- 需求 3（下单价格提示优先级）已实现，不动
- 价格表内部条目的 formula 嵌套引用（`basedOnPricelistId`）机制不变，跟本次"客户挂多张表"是两个不同层面的嵌套，互不影响
