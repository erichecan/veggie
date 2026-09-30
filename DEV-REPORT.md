## 给你看的

| 场景 | 来源 | 验证方式 | 状态 |
| --- | --- | --- | --- |
| 商品库导出可选字段，含完整 UoM 配置 | 你说的 | 代码 + typecheck/lint/单测三项通过；本环境无数据库连接，未能起服务实际点一遍导出弹窗（见下方"未能完成的验证"） | 代码完成，**未做端到端验证** |
| 商品导入模板（尤其 UoM 配置） | 你说的 | 同上——模板列与导出列逐一对应，支持"导出→Excel 改→重新导入"；未能起服务实际走一遍导入 | 代码完成，**未做端到端验证** |
| 订单/采购/客户（餐馆）/供应商都要做导入导出 | 你说的 | 订单：已有导入功能做了健壮化（真正的 CSV 解析器、双语表头、模板下载）；采购单：全新导入（复用已有创建接口）；客户：已有导入导出沿用；供应商：全新导入 + 导出 | 代码完成，**未做端到端验证** |
| 导入测试产品后打不开详情页 | 你说的 | 已定位根因（批量导入从不写 `standardPrice`，落库 `null`，详情页非编辑态对 `null.toFixed()` 崩溃）并修复；新导入逻辑本身也会给出默认值 0，双重防护 | 代码完成，**未做端到端验证** |
| 自增长产品 ID，内部主键使用，cuid 对外展示 | 你说的 | 按确认的方案：新增 `Product.productNo`（自增、唯一）作为好记编号，cuid `id` 仍是真正主键和所有外键目标——改动小、不碰 14 张关联表 | 代码完成，**未做端到端验证** |

<br />

### ⛔ 本环境没有数据库连接，无法按 CLAUDE.md 的"完成标准"做种子数据/curl/浏览器验证

这个会话的容器里没有配置 `DATABASE_URL`（没有 `.env.local`），我在过程中已经跟你说明过一次。这意味着：

* 没跑过 `npx prisma migrate dev` / `db push`——新增的 `Product.productNo` 迁移是我**手写的 SQL**（`prisma/migrations/20260930000001_add_product_no/migration.sql`），逻辑上是标准的 Postgres `SERIAL` 列写法，`npx prisma validate` 通过、`npx prisma generate` 生成的 client 类型也确认了字段存在，但**没有在真实数据库上跑过这条迁移**。
* 没有种子数据、没有起过 `next dev`、没有 curl 过任何一个改动的接口、没有打开过浏览器点一遍导入/导出弹窗。
* 没有测试账号可给（数据库是空的，不存在"至少建 1 个测试用户 + 1 条业务数据"这一步的执行环境）。

**这不等于"改完了、大概率没问题"——这是一个明确的、尚未做完的验收缺口。** 在你（或有数据库权限的环境）跑以下步骤之前，我不能对"功能真的可用"打包票：

```bash
# 1. 在有 DATABASE_URL 的环境里跑迁移
npm run db:migrate:dev   # 或 npx dotenv -e .env.local prisma migrate dev

# 2. 起服务
npm run dev

# 3. 建 1-2 个测试商品(含分类/UoM)，走一遍：
#    商品列表页 → 导出(勾字段) → 检查 CSV 是否含 UoM 列
#    商品列表页 → 导入 → 用刚导出的 CSV 改几行 → 重新导入 → 点进详情页确认能正常打开(这是本次要修的 bug 的直接回归验证)
#    Purchases → Vendors → 导入/导出供应商
#    报价单页 → 导入订单(CSV) / 采购页 → 导入采购单(CSV)
```

访问地址：本地起服务后 `http://localhost:3000`（具体端口以 `npm run dev` 输出为准）；生产地址部署后需另行验证。

<br />

## 存档用的（你不用看，出问题时我回来查）

### 改了什么（4 次提交，可用 `git log` 看逐条 diff）

**1. Bug 修复 + `productNo` 字段**
* `app/[locale]/classic/operator/products/[id]/page.tsx`：非编辑态渲染 `listPrice`/`standardPrice` 时补 `?? 0`，修掉 `null.toFixed()` 崩溃；新增"产品编号"只读展示（编辑态和只读态各一处）
* `prisma/schema.prisma`：`Product` 新增 `productNo Int @unique @default(autoincrement())`；cuid `id` 不受影响，仍是主键和全部外键目标
* `prisma/migrations/20260930000001_add_product_no/migration.sql`：手写迁移（`ALTER TABLE ... ADD COLUMN "productNo" SERIAL NOT NULL` + 唯一索引）——**未在真实库跑过**，见上方验收缺口
* `app/[locale]/classic/operator/products/page.tsx`：列表页加"编号"列

**2. 导出框架泛化（字段可选）+ 供应商导出**
* `lib/export/types.ts`：`ExportColumn` 加必填的 `key` 字段（勾选/`?fields=` 用的稳定标识，不随 locale 变化），新增 `filterColumnsByKeys()`
* `lib/export/columns/*.ts`（8 个文件：product-templates / customers / purchase-orders / orders / statements / invoices / vendor-bills / credit-notes）：给每一列补 `key`；`product-templates.ts` 额外加了 `productNo`/`barcode`/`netWeight`/`volume`/`purchaseUomName`/`saleUomsSummary`（UoM 配置摘要，格式 `单位名:系数:是否默认`，用 `;` 分隔多个单位）
* `lib/export/loaders/product-templates.ts`：相应地查出 `purchaseUom`、`saleUoms`（含 `uom`/`factor`/`isDefault`）
* `components/shared/export-field-picker-dialog.tsx`（新增）：字段勾选弹窗，全选/单选
* `hooks/use-csv-export.tsx`（原 `.ts` 改 `.tsx`）：`useCsvExport` 支持可选的 `columns`，传了就先弹字段勾选框，返回值多了 `dialog` 字段（调用方要把它渲染进 JSX 才会弹出来）；没传 `columns` 的调用方（多数财务类页面）行为不变
* `app/api/export/[entity]/route.ts`：支持 `?fields=k1,k2` 按 key 过滤导出列
* `lib/export/registry.ts` / `lib/export/entities.ts`：新注册 `suppliers` 实体（复用 `customers` 的列定义和查询逻辑，服务端强制加 `isVendor=1` 过滤，不依赖调用方记得传）
* `lib/rbac/route-map.ts`：`/api/export/suppliers` 自动跟着 `EXPORT_ENTITY_META` 生成规则，无需手改
* `lib/role-access.ts`：旧 token 白名单里，凡是已经有 `exportOf('customers')` 的角色都配套加 `exportOf('suppliers')`
* 页面接入字段勾选：`products/page.tsx`、`customers/page.tsx`、`purchases/vendors/page.tsx`、`quotations/page.tsx`（订单）、`purchases/page.tsx`（采购单）

**3. 供应商批量导入**
* `app/api/suppliers/bulk/route.ts`（新增）：镜像 `/api/customers/bulk`，固定写 `isVendor:true, isCustomer:false`，字段换成供应商场景（`supplierPaymentTerm`/`vendorTaxRate` 而非客户的 `paymentTerm`/`salesman`）；复用同一个权限点 `master.customer.bulk_import`（不为供应商视图另开权限点，与导出的思路一致）
* `lib/rbac/route-map.ts` / `lib/role-access.ts`：给 `/api/suppliers/bulk` 补权限规则，镜像 `/api/customers/bulk` 已有的角色授权
* `app/[locale]/classic/operator/purchases/vendors/page.tsx`：加导入/导出按钮和弹窗（这个页面原来两个都没有）

**4. 商品批量导入全面重写**
* `lib/product-sale-uom-upsert.ts`（新增）：从 `PUT /api/products/[id]/sale-uoms` 抽出的可售单位(UoM)落库逻辑，逐字保留原有的"基准单位单一入口"规则，供该路由和新的批量导入共用
* `app/api/products/[id]/sale-uoms/route.ts`：改成调用上面的共享函数，行为不变（`tests/sale-uom.test.ts` 45 个用例全过）
* `app/api/products/bulk/route.ts`（重写）：全字段支持（分类/UoM/条码/含税成本/类型/状态等），支持按 `internalRef→barcode→externalId` 优先级匹配做**更新**（不再是只能创建），未匹配上按名称判重（撞了跳过，保留原有安全行为），支持批量写入可售单位配置；返回 `{created, updated, skipped, warnings}`，不再是只有 `{created, skipped}`
* `components/classic/ProductImportDialog.tsx`（新增）：专用导入弹窗，列头与导出列逐一对应（"导出→Excel 改→重新导入"闭环），税率/商品类型的百分数/长标签自动转换成入库需要的格式，导入结果展示新建/更新/跳过计数 + 完整 warning 列表（不只是一个 toast）
* `app/[locale]/classic/operator/products/page.tsx`：接入新弹窗，替换掉原来那个只有 7 个字段、纯新建的旧导入

**5. 订单导入健壮化 + 采购单导入（新）**
* `app/[locale]/classic/operator/quotations/page.tsx`：订单导入原本就有（分组按餐馆名、逐个调现有 `POST /api/orders`），这次把手写的 `text.split(',')` 解析器换成正规的、处理引号/BOM/换行的共享解析器，表头中英文都认，加了"商品编号"作为比商品名更可靠的匹配键，补了模板下载按钮
* `app/[locale]/classic/operator/purchases/page.tsx`：采购单原来完全没有导入——新增，做法跟订单导入一致（分组按供应商名、逐个调现有 `POST /api/purchase-orders`，复用它已有的定价/校验逻辑，不新开一套采购单批量创建的后端接口）；同时补上了这个页面之前漏掉的导出字段勾选弹窗

### 技术验收

* `npx tsc --noEmit`：通过
* `npx prisma validate`：通过；`npx prisma generate` 正常生成（无数据库连接，无法 `migrate`/`db push`，见上方缺口说明）
* `npx eslint`（本次改动到的文件）：0 error，剩余 warning 全部逐一核对过是改动前就有的（用 `git stash` 对照验证），未新增
* `node --test --import=tsx tests/*.test.ts`：913 个测试，900 通过、7 个 skip、**6 个失败**——这 6 个失败在改动前（`git stash -u` 到完全干净的树）就已经存在，是关于 `/api/auth/register` 缺权限闸和几个 RBAC 可达性矩阵快照的既有问题，与本次改动无关，未修（不在本次任务范围）
* `npm run build` / 起服务 / curl / 浏览器实测：**均未执行**（无数据库连接），见上方"未能完成的验证"

### 已知不可用 / 未做的功能

* **本环境无法验证的部分**（不是没做，是没法测）：`productNo` 迁移是否能在真实 Postgres 上干净跑通、批量导入/导出接口的真实请求/响应是否符合预期、UI 弹窗交互是否顺畅——全部需要你在有数据库的环境里跑一遍上面列的验证步骤。
* 商品导入/导出没有支持"批量导入图片"，图片仍需逐个商品上传。
* 供应商批量导入目前只做"创建，撞名跳过"，不像商品那样支持"按编号匹配后更新"——如果你需要供应商也支持更新导入，需要再开一轮（现有客户/供应商都没有对外的"内部编号"字段可作为可靠匹配键，得先补一个）。
* 订单/采购单的批量导入沿用"整份 CSV 一次性提交、失败的整组跳过"策略，没有做"部分行成功、部分行失败"的行级颗粒度报告——报错信息是按订单/采购单分组给的，不是逐行。
