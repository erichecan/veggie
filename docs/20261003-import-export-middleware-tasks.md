# 全站导入导出中间件改造 — 任务台账

对应 DEV-PLAN.md「全站导入导出统一为商品模块同款体验」。

## 已完成

- [x] 核心引擎 `lib/import/bulk-import-engine.ts` + 共享对话框 `components/shared/BulkImportDialog.tsx`
      验收命令：`npx tsc --noEmit`（通过）
      可看物：file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20261003-products-import-dialog.png
      定性状态：待你确认
      证据：curl 功能验证见下方「存档用的」
- [x] 商品 products 迁移到新引擎（`ProductImportDialog` 删除，列定义移到 `product-import-columns.tsx`）
      验收命令：curl 新建+按 externalId 更新回归，含改价审计日志核验
      可看物：file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20261003-products-import-dialog.png
      定性状态：待你确认
      证据：见 DEV-REPORT.md
- [x] 客户 customers 迁移到新引擎（`CsvImportDialog` 删除），新增按 ID 更新能力
      可看物：file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20261003-customers-import-dialog.png
      定性状态：待你确认
- [x] 供应商 suppliers 迁移到新引擎，新增按 ID 更新能力
      定性状态：待你确认
- [x] CSV 解析器引号 bug 修复（`lib/csv-export.ts` 泛化 + `lib/import-parser.ts` 收编）
      验收命令：引号内逗号解析脚本已跑通（见会话记录），采购单/账单解析商品名含逗号不再错位
      定性状态：我已验证，技术问题不升级
- [x] 单位 Uom 补齐导入导出（create-only，见限制说明）
      可看物：file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20261003-uom-import-dialog.png
      定性状态：待你确认
- [x] 产品分类 ProductCategory 补齐导入导出（按 ID 更新）
      可看物：file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20261003-product-category-tab.png
      定性状态：待你确认

## 按计划排除（发现代码里已有明确理由，不是我偷懒）

- [ ] ~~发票/供应商账单/贷项通知单导出升级到服务端 registry 模式~~
      原因：`lib/export/columns/invoices.ts` 明确注释"⛔ 不能改走 /api/export/<entity>"——这三个页面是
      "全量拉前端+客户端筛选"架构，改服务端导出会让"导出当前筛选结果"这个功能失效。要做的话需要先把
      整个列表页改造成服务端分页，那是一个单独的、更大的改动，不在本次范围。
- [ ] ~~orders 导出两套合并~~
      原因：`lib/export/entities.ts` 明确注释"不动它以免已配置好的角色权限发生变化"。这是前人已经
      做过的决定，不是遗留技术债，不应该在这次顺手合并掉。

## 20261003 第二轮：价格表（已完成，用户确认要做）/ 司机排班（用户确认不做）

- [x] 价格表 pricelists 真实导入导出。数据模型是 `OdooPricelist.items` JSON 数组，不是平铺表，
      不能复用 `lib/import/bulk-import-engine.ts`（那套假设"一行=一条独立记录"，价格表是
      "多行共享同一个父记录"）。改成独立实现 `app/api/pricelists/bulk/route.ts`：逐行处理，
      每行自己去查/建父价格表(按 externalId→名称匹配)，再对该价格表的 items 数组做
      读-改-写(按规则 ID 原地替换或追加，不支持删除已有规则)。
      顺带把 `app/api/pricelists/[id]/route.ts` 里原来内联的 items 校验逻辑抽成共享的
      `lib/pricelist-item.ts`，两边不再各判一套。
      验收：鉴权探针 401；新建价格表+2条规则、按 externalId 更新设置、按规则 ID 原地替换
      （曾经有个真实 bug：替换时规则 ID 会被意外重新生成，已修复并重新验证）、
      settings-only 行（不带规则，只改名）、导出 CSV 核对字段，全部用 curl 在本地开发库
      实测通过，测试数据已清理。code-review high + security-review 已跑。
      可看物：file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20261003-pricelists-import-dialog.png
      定性状态：待你确认
- [x] 司机 DriverSlot 导入导出 —— 用户明确说"司机排班就不用导入导出了"，本次确认不做。

## 确认过不需要动的

- 鉴权（withAuth 全覆盖）、PDF 生成（已统一）、缓存（故意不给 orders/products 这类高频列表接口加）

## 本次 code review 发现、记录但未处理的技术债（下次动这块代码时顺手做）

- [ ] `MAX_ROWS_PER_REQUEST` 校验 + `rowOffset` 解析，在 6 个 bulk 路由里逐字重复，可以抽一个
      `parseBulkImportBody(req)` 共享函数。
- [ ] "按名字(中英文均可)建字典"这个模式在 products/pricelists/product-categories/uoms 四个
      bulk 路由里各写一遍，可以抽一个 `buildBilingualNameIndex()` 共享函数。
- [ ] customers/suppliers 批量导入改走分批提交(100行/批)后，一次大文件导入会产生多条
      ActionLog 记录而不是原来的一条——可接受的副作用(原来大文件反而有 Neon 超时风险)，
      但如果要恢复"一次导入一条审计日志"的粒度，需要给同一次导入操作加一个共享 id。
- [ ] 价格表批量导入是独立实现，没有复用 `lib/import/bulk-import-engine.ts`——如果以后还有
      "多行共享一个父记录"这种形状的导入需求(如多联系人客户、多行采购单)，值得考虑把引擎
      扩展出一个"分组模式"，而不是每次都手写一遍这套"查/建父记录+子数组读改写"的循环。
