# DEV-PLAN：商品库存预警（Low Stock Alert）

## 读取了哪些文档

本次需求没有独立的 PRD 文件，来源是你当场转述的客户原话 + 你自己补的一句判断依据，已逐字存进
`docs/20261025-商品库存预警-需求原话.md`。调研阶段额外读了现有代码（见下）确认有没有可以复用的
基础设施，没有新的产品文档要读。

## 现状调研结论（决定了下面怎么改）

1. **库存预警值字段其实已经存在**：`prisma/schema.prisma` 里 `Product.safetyStockMin`
   （`Decimal? @default(0)`，20260522 加的，注释原本就是"安全库存下限，低于此值触发缺货预警"），
   但整个前端从来没有任何地方能编辑它——**不需要新建字段/不需要迁移**，只是一直没接 UI。
2. 现网所有商品这个字段的值都是默认 **0**（添加这列时迁移把老数据统一填成了 0，不是 null）——
   也就是说现在还没有任何商品真正"设置过"预警值，上线当天不会立刻跳出一堆告警，这是预期行为。
3. 代码里已经有三处在读这个字段（`/api/products/forecast` 的 `belowSafetyStock`、`lib/notify.ts`
   下单确认后的低库存推送、`lib/analytics/inventory-overview.ts` 库存管理页），但口径互相不完全一致，
   且商品列表页现在的"低库存"徽章（`lib/products-query.ts` 的 `productStockAlertCounts`）**跟这个字段完全没关系**，
   用的是硬编码全局阈值 10，不区分商品。这次要把"商品列表页"和"库存管理页"这两处改成统一按
   `safetyStockMin` 逐商品判断；其余两处（下单通知、forecast 接口）不在你这次要求的范围内，不动。

## 判断依据（已向你确认，写进需求原话存档）

预警用**实际在手库存 `qtyOnHand`** 跟预警值比较，条件是 `qtyOnHand ≤ safetyStockMin`（"达到"预警线就算，
不是必须跌破）；`safetyStockMin ≤ 0`（包括现网默认值 0）视为"客户没设置"，不参与告警判断——
跟 `lib/notify.ts` 里已经写好的同一句注释口径对齐。

## 模块拆解

1. **商品编辑页**（`app/[locale]/classic/operator/products/[id]/page.tsx`）
   "Inventory & UoM" 分区加一个"库存预警值"输入框（编辑态）+ 只读态展示，绑定到 `safetyStockMin`，
   走页面已有的 `setField` + 保存逻辑，不新开接口。
2. **保存接口**（`app/api/products/[id]/route.ts`）
   `safetyStockMin` 已经会被现有的 `...data` 透传逻辑接住，不用新增代码路径；只加一条服务端数值
   校验（参照已有的 `listPrice`/`standardPrice` 校验：必须是 ≥0 的有限数），并加进
   `PRODUCT_TRACKED_FIELDS` 让改动留痕到操作记录。
3. **商品列表页告警口径**（`lib/products-query.ts` 的 `productStockAlertCounts`）
   从"全局硬编码阈值 10"改成"逐商品 `safetyStockMin`"：
   - `negative`：`qtyOnHand < 0`（跟预警值无关的明确异常，保留不动）
   - `low`：改成 `safetyStockMin > 0 AND qtyOnHand <= safetyStockMin`（原来是 `qtyOnHand >= 0 AND qtyOnHand < 10`）
4. **商品列表页展示**（`app/[locale]/classic/operator/products/page.tsx`）
   顶部橙色告警横幅、Quantity On Hand 列的黄色徽章，判断条件跟上面第 3 点同步改掉（目前这段是按
   `qty < LOW_STOCK_THRESHOLD` 全局硬编码判断）。
5. **库存管理页**（`lib/analytics/inventory-overview.ts`）
   "需要关注"面板的低库存明细、按品类分组表的"低库存预警"计数，两处 SQL 现在写的是
   `safetyStockMin IS NOT NULL`——因为现网该字段默认是 0 不是 null，这个判断条件现在形同虚设
   （实际上变成了只要 `qtyOnHand <= 0` 就会命中，跟"客户自己设置的预警值"毫无关系）。这次一并
   改成 `safetyStockMin > 0 AND qtyOnHand <= safetyStockMin`，这样商品编辑页一旦填了预警值，
   这页才会真的开始按它报警，不改的话这次新功能等于白做。

## schema 改动

无。`safetyStockMin` 字段已存在，本次不新增迁移。

## 路由清单

无新增路由。改动的是已有路由的内部逻辑：
- `PUT /api/products/[id]`（加校验，字段本来就透传）
- `GET /api/products?page=...`（`alertCounts` 字段口径变化，字段名不变）

## 风险点

- 两处判断条件（列表页 `productStockAlertCounts` / 库存管理页 `inventory-overview.ts`）要保证
  写成完全一样的 SQL 条件，否则同一个商品在两个页面显示的告警状态可能不一致——会抽成同一处常量/
  查询片段复用，不写两份。
- `inventory-overview.ts` 的改动属于"顺手修复一个现有判断条件的潜在 bug"（`IS NOT NULL` 在当前
  数据状态下等价于"全部命中"，不是本次新引入的问题，但不修就等于新功能上线也看不到效果）——
  按你项目惯例，这类技术判断由我自己定并在 commit message 里写清楚理由，不单独上升。

## 附录 A：技术验收标准（verify.sh 内容，我自己验证留证据，你不用看）

- `npx tsc --noEmit` 通过
- `npm run build` 通过
- `npx prisma migrate status`：确认无待应用迁移（本次不新增迁移）
- 路由探针：`PUT /api/products/[id]` 带 `safetyStockMin` 正常保存并能从 `GET` 读回；带非法值
  （负数/非数字）应被 400 拒绝
- 鉴权探针：`PUT /api/products/[id]`（无 token / 错 token / 非 `master.product.update` 角色）
  分别应返回 401 / 401 / 403（这条权限本来就有，验证本次改动没有破坏它）
- 业务不变量脚本：挑 3 个测试商品分别设成"未设置(0)"、"设置且当前库存已达标"、"设置但库存充足"，
  断言商品列表页 `alertCounts.low` 和库存管理页 attention 列表/品类分组的低库存计数，这两处
  对同一批商品给出完全一致的判断结果
- 查询效率：两处改动都是在已有的聚合 SQL 里换判断条件，不新增逐行查询，不引入 N+1

## 需要你确认的场景清单

- [你说的] 在商品编辑里面增加一个库存预警的设定
- [客户说的] 每个商品的预警值不一样，都是客户自己去维护的
- [客户说的] 设置完以后，库存达到这个预警值，商品列表有提醒
- [客户说的] 库存管理这页也有提醒
- [你说的] 判断用实际在手库存 `qtyOnHand` 跟预警值比，不用 Forecast Qty（我追问后你明确选的这个）
- [我推断的] 没给某个商品设置预警值（还是默认的 0）时，这个商品不参与"低库存"提醒——跟"这个商品
  库存是不是负数"的现有告警是两件独立的事，负库存告警照样保留
- [我推断的] "达到预警值"按 `qtyOnHand ≤ safetyStockMin` 触发（到了线就报，不是必须跌破才算）
- [我推断的] 库存管理页的提醒复用现有"需要关注"面板和按品类分组的"低库存"计数两处展示位，
  不是另外新做一块 UI

