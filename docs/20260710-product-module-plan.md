# 商品模块统筹改造方案

> 生成日期：2026-07-10
> 范围：商品详情页 / 商品列表页 filter / 计量单位（UoM）模块 / 新建商品查重
> 依据：无独立 PRD，本轮通过对话五问逐条澄清确认（见下方"决策记录"）
> 定性：按项目 CLAUDE.md 第十三节判定为「大改」（改动数据库读写字段、超过 5 个文件），已完成架构/质量/性能三项评估（见第 6 节）

---

## 1. 背景

商品详情页目前是"完全复刻 Odoo"的产物，5 个 Tab 里相当一部分字段是纯前端 `useState`、从不读库也不存库，刷新即丢失；顶部 Print/Action 按钮点了只弹"即将推出"；且详情页与列表页字段口径不一致（尤其是计量单位）。同时新建商品无查重机制，列表页部分列缺 filter。本次统筹处理这四块问题。

---

## 2. 决策记录（本轮 AskUserQuestion 已确认，逐条列出防遗漏）

| # | 问题 | 决策 |
|---|------|------|
| 1 | 摆设字段（POS设置/供应商行表+Vendor Bills/假Print按钮/硬编码Product Moves）怎么处理 | **直接砍掉**，不做后端接线 |
| 2 | 砍完后详情页布局 | **去掉 Tab，改单页分区块** |
| 3 | UoM 字段打通方案 | 详情页 Unit of Measure / Purchase UoM 下拉**改用新外键 `uomId`/`purchaseUomId`**，不再用旧字符串字段 `unitOfMeasure`/`purchaseUoM` |
| 4 | 计量单位模块文案语言 | **英文主标题 + 括号中文注释**，如 `Units of Measure (计量单位)`、`Bulk (大货)` |
| 5 | 相似商品匹配策略 | **模糊匹配商品名称**（不比对编号/条码） |
| 6 | 提醒交互强度 | **软提醒**，不阻断提交 |
| 7 | 查重适用范围 | **商品模块新建页 + 采购模块 quick-create 两处都加**，共用同一套匹配逻辑 |
| 8 | Product Category 列 filter | **多选下拉改成文本输入框**（与 Sale Description 一致） |

---

## 3. 详细设计

### 3.1 商品详情页重新设计

文件：`app/[locale]/classic/operator/products/[id]/page.tsx`（现 966 行）

**保留并重新分区（单页，无 Tab）：**

```
商品详情 - {name}
[图片] [Is Packaging] [Can be Sold] [Can be Purchased] [Can be Expensed]   ← 顶部checkbox，真实字段，保留原位置

【基本信息 Basic Info】
Name / Internal Reference / Barcode / Product Category / Product Type / Sequence

【价格与税率 Pricing & Tax】
Sales Price / Cost / Customer Taxes / Vendor Taxes / Commission Price

【库存与量纲 Inventory & UoM】
Unit of Measure (uomId) / Purchase UoM (purchaseUomId) / Weight / Volume / Tracking / 当前库存（只读，替代原 Smart Button "On Hand"）

【销售描述 Sale Description】
saleDescription 文本框

【内部备注 Internal Notes】
description 文本框
```

**删除：**
- Sales Tab：`availableInPos`/`loyaltyPoint`/`nonRefundable`/`returnValidDays`/`invoicingPolicy`（纯前端 state，从不落库）
- Purchase Tab 整个（Vendors 供应商行表、Vendor Bills、`purchaseDescription`——均无 db 字段支撑）
- 顶部 Print（Product Label/Product Sheet）、Action（Duplicate/Archive/Delete）按钮（点击只弹"即将推出"）
- Smart Button "Product Moves"（硬编码 0）
- Smart Button "Purchased"（标签与实际计算的数据来源不符，是销售额不是采购额）

**待你确认的新发现（未在此前提问中覆盖）：**
- **eCommerce Tab**（`websitePublished`/`websiteName`）：字段本身真实存库，但全项目搜索后**没有任何面向客户的网站在读这两个字段**（这是纯内部操作系统，没有独立电商前台）。建议**一并删除**，因为留着也是摆设，只是"存了库的摆设"而非"没存库的摆设"。如果你们确实有计划做客户官网/独立商城需要这个开关，请告诉我保留。

### 3.2 计量单位（UoM）打通

- `Row label="Unit of Measure"` / `Row label="Purchase UoM"` 的 `<select>` 改为绑定 `tmpl.uomId`/`tmpl.purchaseUomId`，`onChange` 写 `setField('uomId', ...)`/`setField('purchaseUomId', ...)`。
- 保存逻辑 `handleSave` 已经是整体提交 `tmpl` 对象，无需额外改动，只要 `setField` 的 key 换成新字段即可生效。
- `uoms` 下拉选项来源不变（`/api/uoms`），`value`/`key` 从 `u.name` 改成 `u.id`。
- 只读态展示（`ReadField label="Unit of Measure"`）改成按 `uomId` 查 `uoms` 数组取名称。
- 旧字符串字段 `unitOfMeasure`/`purchaseUoM` 保留在 schema 里但不再被详情页写入（本次不做历史数据双向同步或字段删除，避免打扰仍可能间接依赖旧字段的其它代码路径——如有其它读取点，执行时会一并排查）。
- 列表页新增一列 **Unit of Measure**（读 `uomId` 关联的 `Uom.name`/`nameZh`），补上"详情页有列表页没有"的缺口，filterType 用 `multi-select`（枚举值天然有限，适合下拉）。

### 3.3 计量单位模块英文化

文件：`app/[locale]/classic/operator/settings/page.tsx`（UoM Tab，约 L559-604 及页面内其它中文文案）

- 页面标题、按钮、表头统一改成"英文 (中文)"格式，如：
  - `计量单位` → `Units of Measure (计量单位)`
  - `新建单位分类` → `+ New Category (新建分类)`
  - `大货`/`散货` → `Bulk (大货)` / `Loose (散货)`
- 商品详情页里 Unit of Measure 相关文案目前是纯英文硬编码、不跟随 `locale`——本次保持英文（与 Settings 页新规范一致），不再单独处理双语切换。

### 3.4 新建商品相似度查重

**匹配逻辑**（新建一个共享函数，如 `lib/product-similarity.ts`）：
- 对商品名做归一化（去空白、转小写，中文不分词）后计算相似度（用 bigram 重叠的 Dice 系数或简单的子串包含判断，不引入新依赖、不建 Postgres trigram 索引——当前商品量级约 1718 条，请求时全表内存比对即可，性能可接受）。
- 相似度阈值触发候选列表（如 Dice ≥ 0.5 或存在子串包含关系），返回 Top 5 候选（含 id/name/internalRef，供前端渲染"查看"链接）。

**接入点：**
- 新增一个只读 API，如 `GET /api/products/similar?name=xxx`，供前端输入名称时防抖调用。
- 前端两处接入：
  - 商品模块新建页（表单输入 Name 时）
  - 采购模块 `purchases/new` 里的 quick-create 弹窗（输入 Name 时）
- UI：黄色提示条 + 候选商品链接列表 + "继续新建 {name}"按钮，不阻断提交，不加勾选确认框。

### 3.5 列表页 filter 调整

文件：`app/[locale]/classic/operator/products/page.tsx`（列定义 `L225-436`）

- `Sale Description` 列：新增文本输入 filter（`filterType: 'text'`），替换掉目前的 `multi-select`（长文本枚举成下拉不合理）。
- `Product Category` 列：`filterType` 从 `multi-select` 改成 `text`（按分类名子串过滤），去掉 `editOptions`。

---

## 4. 涉及文件清单

| 文件 | 改动类型 |
|------|----------|
| `app/[locale]/classic/operator/products/[id]/page.tsx` | 大改（去 Tab、删摆设字段、UoM 字段切换） |
| `app/[locale]/classic/operator/products/page.tsx` | 小改（两列 filterType 调整 + 新增 UoM 列） |
| `app/[locale]/classic/operator/settings/page.tsx` | 小改（UoM Tab 文案英文化） |
| `app/api/product-templates/route.ts` / `[id]/route.ts` | 检查 `uomId`/`purchaseUomId` 是否已支持读写（如未支持需补） |
| `lib/product-similarity.ts` | 新增 |
| `app/api/products/similar/route.ts` | 新增 |
| 商品模块新建页（新建商品的表单组件，待定位具体文件） | 小改（接入查重提示） |
| `app/api/products/quick-create/route.ts` 对应的前端弹窗组件 | 小改（接入查重提示） |

---

## 5. 明确不做（本次范围外）

- 不做旧字段 `unitOfMeasure`/`purchaseUoM` 的删除或历史数据清理，只是详情页不再写入
- 不给商品名称/编号/条码加数据库唯一约束（查重只是提醒，不是强校验）
- 不改动采购模块正在进行中的其它工作（PDF 识别、运费摊销、汇率等，见现有 `DEV-PLAN.md`）
- 不做详情页多语言（i18n）适配，维持现状英文为主

---

## 6.「大改」三项评估

- **架构**：查重逻辑抽成公共函数供两个入口复用，避免复制粘贴；UoM 从"新旧两套字段并存互不通气"收敛为详情页/列表页统一走新外键，消除一处历史 SSOT 分裂。
- **质量**：列表页 filter 复用现有 `OdooTable` 的 `columnFilters` 机制（已有 `text`/`multi-select` 现成模式），不新增筛选框架；UoM 下拉复用现有 `/api/uoms`，不新增接口。
- **性能**：商品目录约 1718 条，查重全表内存模糊匹配可接受，不引入 trigram 扩展索引；列表页 filter 沿用现状的前端本地过滤，不新增负担。

---

## 7. 验证方式（开发完成后逐条过）

- 详情页：Edit 模式下改 Unit of Measure 保存后刷新页面，确认新值持久（写入 `uomId` 而非旧字段）
- 详情页：确认 Sales/Purchase Tab 的假字段、假按钮已不在页面上出现
- 列表页：Sale Description、Product Category 两列下方均可输入文本筛选，且能正确过滤
- 列表页：新增 Unit of Measure 列正确显示 `Uom.nameZh`/`name`
- 查重：分别在商品模块新建页、采购 quick-create 弹窗输入已有相似商品名称（如"小青菜"命中"青菜"），确认提示出现且不阻断提交；输入完全不相关名称确认无提示
- Settings 页 UoM Tab 文案确认改为"英文 (中文)"格式
