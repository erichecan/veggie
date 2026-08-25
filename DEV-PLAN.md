# DEV-PLAN：合并 ProductTemplate 到 Product，删除模板/变体两层结构

## 背景与结论

商品名兜底排查中发现：管理后台改商品名改的是 `ProductTemplate.name`，下单/报价选品读的是 `Product.name`，两者独立存储、只有价格字段有单向传播，改名不传播 → 生产库实测 6 个商品出现"列表页新名字、选品下拉旧名字"。

进一步核查发现这不是孤立 bug，是结构性问题：全库只有 `Product.templateId` 这一处外键指向 `ProductTemplate`，其余几十处外键（OrderLine、Lot、ProductSaleUom、ProductAlias、ProductSupplierInfo、StockMove、采购单行、盘点记录……）全部指向 `Product`。而生产库 5479 个模板对 5479 个商品，**严格 1:1，从未真正使用过"一个模板多个变体"**。模板层是仿 Odoo product.template/product.product 抄来的骨架，在这个项目里没有承载任何实际业务，只是让同一份"商品名"多存了一份、多一处会分叉的地方。

**结论：删除 ProductTemplate，把它的字段并入 Product。** 保留 Product 是因为它是全系统事务外键的真正落点，改动面远小于反过来做。

## 读取的文档

无独立 PRD，本次需求来自对话内排查（商品改名不同步 → 追问设计逻辑 → 用户决定去掉多余的一层）。事实依据来自一次全库调查（90 文件 / 320 处引用扫描 + 生产库/本地库实测数据）。

## 一、字段合并设计

### 1.1 从 ProductTemplate 并入 Product 的字段（20个）

`type` `canBeSold` `canBePurchased` `description` `saleDescription` `weight` `netWeight` `volume` `isPackaging` `canBeExpensed` `uomId`+关系 `purchaseUomId`+关系 `unitOfMeasure`(deprecated) `purchaseUoM`(deprecated) `tracking` `websitePublished` `websiteName` `vendorTaxRate` `forecastQty` `createdBy` `updatedBy` `barcode`

`attributeLines`（变体属性生成配置）**不迁移，直接废弃**——没有变体场景，留着就是死字段。

### 1.2 Product 保留、模板从不涉及的字段

`qtyOnHand` `active` `spec` `stock`(旧兼容) `price`(旧兼容) `safetyStockMin` `currentZoneId`+关系，及五个反向关系（`supplierInfos`/`orderLines`/`lots`/`saleUoms`/`aliases`）。

### 1.3 两边同名字段的合并取舍

| 字段 | 取舍规则 | 依据 |
|---|---|---|
| `name` | 以 **Product 侧当前值**为准 | 选品/下单实际展示的就是这个值 |
| `listPrice`/`standardPrice`/`customerTaxRate`/`commissionPrice` | 理论应一致（已有传播机制），迁移前跑 diff 校验，有分歧按 Product 侧 | 定价引擎读 Product-first |
| `internalRef`/`categoryId`/`images` | Product 非空则用 Product，否则退回 Template | 与 `/api/products` 现有兜底逻辑一致 |
| `status`/`sequence`/`externalId`/`createdAt`/`updatedAt` | 迁移前各查一次 diff 数量，逐类裁决 | 目前无强制同步机制 |

回填 SQL 前必须先跑一次**全字段 diff 报表**（不只是 name 那 6 条），把所有分歧字段和条数列出来，异常多的话要停下来问，不能悄悄拿 COALESCE 糊过去。

## 二、迁移阶段

### Phase 0：数据前置修复（必须在 schema 迁移前完成，且**必须在生产库上跑**，不能只在本地库验证）

- `OdooPricelistItem.items` 是 JSON 字段，`applyOn:'product'` 的条目里存的 `productTemplateId` 是**没有数据库级 FK 约束的松引用**，指向 `ProductTemplate.id`。本地库实测 621 条这样的记录（`applyOn:'variant'` 的 2651 条已经指向 `Product.id`，不用管）。删表前必须先跑一个 `scripts/backfill-pricelist-item-product-ids-<日期>.ts`，把这 621 条的 `productTemplateId` remap 成对应的 `Product.id`，否则删表瞬间这批定价规则全部失效或指向不存在的 id。
- **本地库数字不代表生产库**，落地前先在生产库重新跑一遍同样的统计，确认真实规模，再决定是否需要人工抽查。

### Phase 1：schema 迁移

1. Prisma schema：Product 加上 1.1 列出的 20 个字段（含 `uom`/`purchaseUom` 关系）；写一条手工迁移：
   - `ALTER TABLE "Product" ADD COLUMN ...`（20 个字段）
   - `UPDATE "Product" p SET ... FROM "ProductTemplate" t WHERE p."templateId" = t.id`（回填，按 1.3 规则处理冲突字段）
   - 跑一次完整性校验（每个 Product 都成功回填、没有孤儿行）
   - `ALTER TABLE "Product" DROP COLUMN "templateId"`
   - `DROP TABLE "ProductTemplate"`
2. 项目里 88 条历史迁移没有"合并两表删表"的先例可抄，这条要新写，但可以照抄 `scripts/backfill-*.ts` 的运行习惯（dry-run 先行、`--apply` 才真正写、走 `.env.local`）。

### Phase 2：后端 API 改写

- 删除整个 `app/api/product-templates/` 目录（`route.ts` GET列表+POST创建、`[id]/route.ts` PUT+DELETE、`filter-options/route.ts`）。
- `app/api/products/route.ts`：GET 去掉 `include: {template:...}` 和之后的字段提升 `.map()`，直接 select/return 新字段；POST 补上原本模板专属字段的校验（`canBeSold`/`canBePurchased`/`uomId` 等）。
- `app/api/products/[id]/route.ts`：补上目前**没有**做的模板字段合并——这个路由以前不需要合并是因为可售/UoM 这些字段本来就不在 Product 上，现在字段并过来了，直接读写即可，反而变简单。
- 创建商品的三处唯一入口（`product-templates/route.ts` 内的事务创建、`products/bulk/route.ts`、`products/quick-create/route.ts`）改成"一次 `prisma.product.create`"，不再需要 `$transaction` 里先建模板再建变体。
- 删除 `product-templates/[id]/route.ts:71-83` 那段价格/改名"传播"逻辑（含我上一轮加的 name 传播）——合表后没有"传播"这回事，只有一次更新。
- 两处 PATCH 回写模板的调用改成回写 Product：`app/api/products/[id]/sale-uoms/route.ts:89`、`app/api/purchase-orders/[id]/route.ts:437`。

### Phase 3：业务逻辑改写

- **`lib/pricing-engine.ts:145`（需要你确认的产品语义决策，见下）**：`item.productTemplateId === product.templateId` 这行没有 `templateId` 就无法工作。
- `lib/order-line-stock.ts:20-61`：判断"是否实物记库存流水"的 `type` 字段直接从 Product 读，去掉 `productTemplate.findUnique`。**这是库存记账写路径，改完要重点测**。
- `lib/commission.ts:39-47`：提成价 fallback 逻辑简化，不再需要两层 include。
- 7 个 print/loader 文件（`lib/print/dispatch-loader.ts`、`trip-loader.ts`、`trip-common.ts`、`trip-picking-template.ts`、`line-sort.ts`、`product-sequence.ts`、`uom-conversion-loader.ts`）：去掉 `LEFT JOIN ProductTemplate` / `include: {template:...}`，字段直接在 Product 行上，是纯粹的简化。
- `lib/wave-zones.ts`、`lib/product-similarity.ts`：同上，去掉多余 JOIN。
- `lib/products-query.ts`：`attachQtyOnHand()` 目前按 templateId 分组求和，1:1 场景下这段聚合逻辑直接删除。
- `lib/facets/product-templates.ts`：`variant` 这个分面维度失去意义（本来是"模板下有没有叫这个名字的变体"），删除或与 `name` 合并。
- `lib/export/entities.ts`、`lib/export/registry.ts`、`lib/export/loaders/product-templates.ts`：导出实体改注册到 Product，权限点从 `master.product_template.read` 改成 `master.product.read`。
- **action-log `resource` 约定统一（三处必须同步改，改漏一处商品详情页操作历史会断档）**：`app/api/product-templates/[id]/route.ts:99,116`、`app/api/product-templates/route.ts:126`、以及故意对齐这个约定的 `app/api/stock-moves/route.ts:117-120`，全部统一成 `resource:'product'` + `resourceId: product.id`；商品详情页的 `<ChatterFeed resource="product-template".../>`（`products/[id]/page.tsx:899`）同步改成 `resource="product"`。
- **RBAC 权限点（需要你确认，见下）**：`lib/permissions.ts`、`lib/rbac/catalog.ts`、`lib/rbac/route-map.ts`、`scripts/rbac/generate-business-roles.ts` 里 `product` 和 `product_template` 是两套独立权限点，实测所有角色模板对两者授权一致（没有"能改变体不能改模板"的分裂）。

### Phase 4：前端改写

- `app/[locale]/classic/operator/products/page.tsx`：**改造量最大的一块**。整页数据源从 `GET /api/product-templates`（分页/分面/库存告警/内联编辑）切到 `GET /api/products`。
- `app/[locale]/classic/operator/products/[id]/page.tsx`：现在的写法是"先查模板、再查全表过滤出变体、再拿变体 id 查可售单位"三段式（`load()` 第139-184行），合表后压成一次查询，是简化不是重写。
- `app/[locale]/classic/operator/pricelists/[id]/page.tsx`：31 处引用，UI 上现有"模板级选择器"和"变体级选择器"两个不同的选品下拉——处理方式取决于下面的产品语义决策。
- 轻量引用（`print/pricelist/page.tsx`、`pricelists/page.tsx`）跟着类型改名即可。
- `lib/hooks.ts` 的 `useProductTemplates()`：确认调用方清空后随手删除。

### Phase 5：脚本 / 测试跟进

- `prisma/seed.ts:161-166`：种子脚本改成直接建 Product。
- `scripts/db/bootstrap-fresh.ts`：本地空库启动链路要跟着新 schema 走。
- `scripts/audit/*`（约 20 个文件）：仍在运行的合同功能核实探针，多是只读 `prisma.productTemplate.count()/findFirst`，逐个替换成 `prisma.product.*`。
- 6 个测试文件（`tests/pricing-engine-*.test.ts`、`export-columns.test.ts`、`facet-search.test.ts`、`public-api-routes.test.ts`）跟着 schema 改。
- 历史一次性脚本（`scripts/import-odoo-products-full-20260717.ts` 等 16 个，已在调查报告列出）不需要迁移，建议顺手挪进一个 archive 目录，不占实施工作量。

## 三、产品语义决策（已确认）

**1. 价格表"模板级/变体级"→ 选 B，合并成一个选择器。** `pricelists/[id]/page.tsx` 现有的两个选品下拉（`applyOn:'product'` 锁模板 / `applyOn:'variant'` 锁变体）合并成一个，`applyOn` 概念一并清理。这块 UI 需要重新设计，不是简单改字段名。

**2. `product_template.*` 权限点 → 选 B，保留为 `product.*` 的别名。** 不从权限目录删除这四个点，只是让它们在校验逻辑上等同于对应的 `product.*` 点，避免这次改动触碰权限目录结构（结构不变就不强制全员重登录，只是常规部署）。

**3. 并行分支时序 → 不等，main 直接开始。** `can-be-sold-purchased-enforcement` 已经合并进 main（两次 merge commit，worktree 已不存在，磁盘残留目录可忽略）。`purchase-rfq-copy-history` 还有大量未提交改动（含未完工的财务中心整块功能，且触碰 `prisma/schema.prisma`），不满足"改好了"的前提，保持现状不动，这次重构只在 main 主工作区进行，不碰那个 worktree 目录。

## 四、风险总览

| 风险 | 应对 |
|---|---|
| `OdooPricelistItem` 621 条松引用（JSON 字段无 FK 约束） | Phase 0 前置 remap，先在生产库核实真实规模 |
| `lib/order-line-stock.ts` 库存记账写路径改动 | 改完后用真实订单走一遍确认/发货流程，核对 StockMove 是否正常生成 |
| action-log resource 约定三处不同步 | 清单已列全，作为一个原子改动一起提交，不要拆开改 |
| RBAC 权限目录结构变化 | 已决定保留别名，权限目录结构不变，不触发强制重登录 |
| 两表同名字段历史分叉（不止 name） | Phase 0 先跑全字段 diff 报表，异常多要停下来问，不能默默 COALESCE |

## 五、验证清单（完成前必须全部过一遍）

- `npm run build` 无报错，迁移在本地库（`.env.local`）先跑通
- 商品管理列表页：新建/改名/改价/归档/恢复，改完立刻在下单页/报价单页选品验证名字一致
- 下单页、报价单编辑页、销售单编辑页：新建行、编辑行、可售单位切换均正常
- 采购下单页"当场建档"新建商品流程正常
- 价格表编辑页：两级规则按选定方案验证匹配行为符合预期
- 库存流水：确认订单后 StockMove 正常生成，缺货判断正常
- 商品详情页 ChatterFeed 操作历史：改名后能查到新记录，历史记录（迁移前产生的）也还能查到
- RBAC：迁移后重新登录，抽查 2-3 个角色的商品相关权限行为未变化
- `scripts/audit/*` 探针跑一遍不报错

---

✅ 计划已确认（价格表选 B 合并成一层选择器 / 权限点选 B 留别名 / 不等并行分支，main 直接开始）。这是预计超 30 分钟的大改，按台账制执行：`docs/20260825-producttemplate-merge-tasks.md`。
