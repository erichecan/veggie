# 性能优化任务台账

> **本文件是进度的唯一真相，对话不是。**
> 依据：全局 CLAUDE.md 第十四节「长任务连续执行协议」。
> 分析来源：`docs/20260802-single-system-memory-and-perf.md` §3。
>
> 这三条是**算法层面的浪费，迁到哪台服务器都存在**，与私有化迁移解耦，现在改现在生效。

## 执行约定

- 一周期一条，做完即提交，提交后回写本文件状态
- 下一周期从**读本文件**开始，不从记忆开始
- 硬停止：无剩余条目 / 达周期上限 / **同一问题连续 2 次没修好** / 撞上「必须停下来」清单
- 本轮周期上限：**3**（三条各一轮）

## 基线（2026-08-02 实测，改动前）

| 项 | 实测值 | 测法 |
|---|---|---|
| `Product.groupBy` 全表聚合 | 该页最慢查询，5,479 行 | Prisma query 事件 |
| `PickingWave.orderIds` 数组匹配 | **Seq Scan**，0.062 ms / 51 行 | `EXPLAIN ANALYZE` |
| `PickingWave` 现有索引 | 6 个，无一覆盖 `orderIds` | `pg_indexes` |
| 司机维度筛选 | `allWaves` 无 where 全表拉 `orderIds` | 读 `lib/orders-query.ts` |

---

## 任务

### - [x] T1 `PickingWave.orderIds` 加 GIN 索引 — 完成

**为什么**：`attachWaveDisplay` 被订单列表、CSV 导出、发票 PDF、行程打印共用，每次都做
`orderIds && ARRAY[...]` 数组匹配，实测走 Seq Scan。现在 51 行不痛，但该表按天线性增长
（每司机每时段一条），是必然劣化的形状。

**验收**：
1. `EXPLAIN ANALYZE SELECT ... WHERE "orderIds" && ARRAY[...]` 的计划**不再是 Seq Scan**
2. 迁移文件落在 `prisma/migrations/`，供新环境使用（含私有化部署的新库）
3. 生产库索引已建（用 `CONCURRENTLY`，不锁写入）
4. `npm test` 与 `npx tsc --noEmit` 无新增失败

**产出**：`prisma/migrations/<ts>_pickingwave_orderids_gin/migration.sql`

**依赖**：无

**风险**：低。纯新增索引，不改查询语义。

**结果（周期 1，2026-08-02）**：
- 验收 1 ✅ `Seq Scan`(0.063ms) → `Bitmap Heap Scan`(0.034ms)
- 验收 2 ✅ `prisma/migrations/20260802160000_pickingwave_orderids_gin/`
- 验收 3 ✅ 生产库已用 `CONCURRENTLY` 建成（0.2s，未锁写入），`migrate resolve --applied` 已标记
- 验收 4 ✅ tsc 0 错误；105 测试 103 通过 0 失败

---

### - [x] T2 商品列表去掉每请求的全表聚合 — 完成（待生产验证）

**为什么**：`app/api/product-templates/route.ts` 里
`prisma.product.groupBy({ by:['templateId'], _sum:{qtyOnHand:true} })`
**无条件执行**，只为算两个库存角标数字（负库存 / 低库存计数），实测是该页最慢的一条查询。
商品页是客户日常最常用的页面之一。

**验收**：
1. 常规列表请求（不带 `stockAlert`）**不再执行**全表 `product.groupBy` —— 用 Prisma query 事件计数证明查询数减少
2. 角标数字仍然正确 —— 与改动前的 `alertCounts` 值逐一比对
3. 带 `stockAlert=negative` / `low` 的筛选功能不变 —— 结果条数与改动前一致
4. `npm run build` / `tsc` / `npm test` 通过

**产出**：`app/api/product-templates/route.ts`（可能加轻量端点或缓存）

**依赖**：无

**风险**：中。角标是 UI 上可见的数字，算错用户会立刻发现；必须做前后比对。

**结果（周期 2，2026-08-02）**：
- 改法：角标计数改为数据库内聚合（`count(*) FILTER (...)`），**返回 2 个数字而非 5,479 行**；
  仅在真正按告警筛选时才额外查一次符合条件的 templateId 列表
- 验收 1 ✅ 无条件的全表 `product.groupBy` 已移除（第 154 行那个是按当前页收窄的，保留）
- 验收 2 ✅ 新旧结果逐一比对：`negative=28`、`low=4737` **完全一致**（先验证 SQL 等价，再改路由）
- 验收 3 ✅ `stockAlert=negative` 命中 id 数 28，与基线一致
- 验收 4 ✅ tsc 0 错误；105 测试 103 通过 0 失败；build 通过
- 本机耗时 1028ms → 563ms（差值主要是行传输；生产端同机传输，收益更大）
- ⏳ 生产端到端验证待部署后进行

---

### - [ ] T3 `driverNameClause` 不再全表拉 `orderIds` 进内存

**为什么**：`lib/orders-query.ts` 的 `driverNameClause` 里

```ts
prisma.pickingWave.findMany({ select: { orderIds: true } })   // 没有 where，全表
```

拉出**所有**波次的 `orderIds` 数组到 Node 内存，用来算「不在任何波次里的订单」。
应交给数据库用 `NOT EXISTS` 判断，不要把全表搬进应用层做集合运算。

**验收**：
1. 该函数不再有无 `where` 的 `pickingWave.findMany`
2. **司机维度筛选结果与改动前完全一致** —— 取至少 3 个真实司机名，比对改动前后的订单命中数
3. 列筛选 `colDriver` 走同一函数，一并验证
4. `npm test` / `tsc` / `build` 通过

**产出**：`lib/orders-query.ts`

**依赖**：T1 完成后做（GIN 索引会让新写法的数组查询更快，先建索引再改查询）

**风险**：中。改的是筛选语义所在的函数，写错会静默返回错误结果——必须做前后计数比对，不能只看「能跑」。

---

## 周期日志

| 周期 | 任务 | 结果 | commit | 时间 |
|---|---|---|---|---|
| — | — | 台账建立，未开工 | — | 2026-08-02 |
| 1 | T1 GIN 索引 | ✅ 完成，4/4 验收通过 | 78ebb59 | 2026-08-02 |
| 2 | T2 商品列表全表聚合 | ✅ 完成，4/4 验收通过（生产验证待部署） | 见下 | 2026-08-02 |
