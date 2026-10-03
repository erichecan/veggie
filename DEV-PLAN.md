# DEV-PLAN：全站导入导出统一为商品模块同款体验

日期：2026-10-03

## 读取了哪些文档

本次无产品文档改动，依据本次会话的口头指令：

> "导入导出功能,现在没有导入导出功能的就补齐导入导出功能,已经有导入导出的功能都改成按照商品的模块导入导出功能"

以及本会话前序调查产出：
- `docs/20261003-import-export-middleware-review.md`（全站导入导出现状表 + 可抽离中间件清单）

## 关键技术决策（我已经定了，不需要你看这一段的论证过程）

"商品模块的导入"本身**不是**可复用组件——它是 `components/classic/ProductImportDialog.tsx` + `app/api/products/bulk/route.ts` 专属实现，代码注释写明"不复用通用组件"。要让全站"看起来像商品模块"，技术上只有两条路：

- A. 把商品那套字面复制到每个模块 → 制造更多重复代码，是倒退。
- B. 把商品那套**体验和引擎**抽成真正共享的中间件（前端对话框组件参数化、后端批量写入引擎参数化），所有模块（包括商品自己）改成调用同一套，各自只提供字段定义。

我按 B 做。这是架构选型，技术取舍我来定，不升级成问题问你。

## 模块拆解

### 1. 新增中间件（核心基础设施）

- **前端**：`components/shared/BulkImportDialog.tsx` —— 泛化自 `ProductImportDialog`：下载模板 / 选文件解析 / 预览前5行 / 100行一批顺序提交防网关超时 / 结果展示(created/updated/skipped/failed/warnings)。按 columns、exampleRows、endpoint、说明文案参数化，各模块传参复用。
- **后端**：`lib/import/bulk-import-engine.ts` —— 泛化自商品 bulk route 的核心循环：
  - 匹配优先级键 → 命中则更新，否则按 name 判重 → 判重失败则新建
  - 更新只覆盖本行非空字段（不拿默认值冲掉已有数据）
  - 逐行独立事务（Neon 每条网络往返不能批量化，这条迁就按项目 CLAUDE.md 不能因为抽象而优化掉）
  - 失败行记原因、其它行照常导入
  - 收尾统一写 `writeLog`
  各模块只提供：matchKeys、字段 resolver（原始字符串→落库值）、create 默认值。
- **CSV 解析统一**用 `lib/csv-export.ts` 的 `parseCsv`（支持引号/CRLF），废弃 `lib/import-parser.ts` 里裸 split 的那份解析器（顺带修掉"商品名含逗号解析错位"的既有 bug）。
- 导出层本来就统一（`lib/export/registry.ts`），本次不重新发明，只把还没接进来的模块补进去。

### 2. 存量模块迁移到新引擎（已有导入导出，要改造）

| 模块 | 改造内容 |
|---|---|
| 商品 products | `ProductImportDialog`→`BulkImportDialog`，`/api/products/bulk`→改成调用 `bulk-import-engine`。商品自己也要切过去，否则中间件只是摆设。 |
| 客户 customers | `CsvImportDialog`→`BulkImportDialog`，`/api/customers/bulk`→改用引擎，字段校验从"手写照抄"变成"自己的 resolver" |
| 供应商 suppliers | 同上 |
| 供应商账单 vendor-bills | 导入(PDF/Excel解析)**不动**——这是解析订单行场景，跟"批量建档"性质不同，不纳入这次中间件统一范围；导出从"客户端模式"升级成 registry 全量导出 |
| 发票 invoices / 贷项通知单 credit-notes | 导出从"客户端模式"升级成 registry 全量导出；**是否要加导入**——见下方「需要你判断」 |
| 订单 orders | 现存两套导出（registry 版 + `export-csv` 会计专用版）并存，本次合并成一套——具体怎么合并见风险点 |

### 3. 新模块补齐导入导出（之前完全没有）

| 模块 | 风险等级 | 处理方式 |
|---|---|---|
| 单位 Uom | 低 | 按新引擎直接做，name 唯一键做匹配 |
| 产品分类 ProductCategory | 低 | 同上 |
| 产品类型 | — | 这不是表，是硬编码枚举(storable/consumable/service)，没有"导入导出"的对象，本次**不做**，写进歧义清单 |
| 价格表 pricelists | 中 | 现在导入是假按钮(点了弹"coming soon")，导出完全没有；按新引擎实现真正的导入导出 |
| 司机 drivers/DriverSlot | 中 | 按新引擎做，字段少，风险可控 |
| 波次 PickingWave、行程/提成 Trip/commission | **高** | 这些是运行时业务流程对象（有状态机、锁定、司机分配、财务结算关联），不是主数据；"导入一个波次"语义不清楚，强行套用 CSV 批量语义有破坏业务不变量的风险 |
| 库存/批次 inventory/StockMove/Lot | **高** | 批量 CSV 直接改库存数量会绕过 `StockMove` 流水记录机制（项目里本来就有"PATCH/DELETE 改 qtyOnHand 不写 StockMove"的已知坑），批量导入等于放大这个坑 |
| 付款/核销 payments | **高** | 财务凭证，批量导入等于批量造假收款记录的攻击面，权限和审计要求比普通主数据高得多 |
| 用户/角色 users/AppRole/UserRoleLink | **高** | 批量建用户+批量授权是安全敏感操作，误操作或被滥用后果是全站权限错配 |

## Schema 设计

大部分模块复用现有表，不改 schema。Uom/ProductCategory 已有 `name` 唯一键可直接做匹配键；Driver/DriverSlot、Pricelist 的匹配键需要在执行阶段确认现有唯一约束是否够用，不够的话补一个（小改，走数据库迁移）。高风险模块(库存/支付/用户/波次提成)本次不做，无 schema 变更。

## 路由清单（预计新增/改造）

- 新增：`lib/import/bulk-import-engine.ts`、`components/shared/BulkImportDialog.tsx`
- 新增：`app/api/uoms/bulk/route.ts`、`app/api/product-categories/bulk/route.ts`、`app/api/pricelists/bulk/route.ts`、`app/api/driver-slots/bulk/route.ts`（视下方确认结果取舍）
- 改造：`app/api/products/bulk/route.ts`、`app/api/customers/bulk/route.ts`、`app/api/suppliers/bulk/route.ts`
- `lib/export/registry.ts` 新增 entity：`uoms`、`product-categories`、升级 `invoices`/`vendor-bills`/`credit-notes`/（视确认结果）`pricelists`
- `orders` 导出合并：删掉 `app/api/orders/export-csv/route.ts` 或将其能力并入 registry 版（取决于确认结果）

## 风险点

1. **商品模块是久经生产考验的代码**（处理过 Neon P2028 超时、200行上限客户投诉、价格变更留痕等多轮真实踩坑），抽成通用引擎时任何边界行为（逐行独立事务、部分更新语义、匹配优先级回退、价格留痕）都不能回归。改造后必须用同一份真实数据跑一遍新旧实现对比验证。
2. **高风险模块如果你坚持要做**，批量导入会绕过现有业务不变量保护（库存绕过 StockMove、支付绕过正常收款流程、用户绕过手动审核授权、波次/提成绕过状态机），一旦做错是生产数据/资金/权限风险，不是界面问题。
3. **Neon 迁就不能丢**：逐行独立事务这类专为 Neon 网络延迟写的代码，迁到自有服务器后会不再必要，但现在还在 Neon 上跑，中间件设计必须保留这个行为，不能"优化掉"。
4. **orders 导出两套合并**需要先确认两套的使用方/权限点差异（会计专用 summary/detail 口径 vs 列表页口径），合并错了影响财务对账，这步要额外做一次权限点和字段级 diff 核对。
5. 存量模块（customers/suppliers）迁移到新引擎后，现有字段校验规则必须完整保留，不能在"抽共享函数"的过程中漏掉某条校验导致数据质量下降。

---

## 📋 计划已生成。三块内容，只有第 1 块需要你判断：

### 【需要你判断 — 场景清单】

- **[我推断的]** 高风险四项——库存/批次、付款核销、用户权限、波次/行程提成——本次**不做**批量导入导出，继续保持手工维护。理由见上方风险点。
- **[我推断的]** 产品类型是固定枚举不是表，本次**不做**导入导出。
- **[我推断的]** 发票/贷项通知单本来没有导入功能（现在是系统从退货/收款流程生成，不是手工建档），本次**只升级导出**(到registry全量模式)，**不加导入**。如果你需要给发票/贷项通知单也加批量导入，这个要单独说一句，因为它跟"系统生成单据"这个业务语义有冲突，我不会默认加。
- **[我推断的]** 价格表、司机这两个"中风险"模块，按新引擎实现真正的导入导出（价格表现在的导入是假按钮，司机现在完全没有）。如果你觉得这两个也不需要批量功能（数据量小，手工维护够用），请明说，我就不做。
- **[我推断的]** orders 的两套导出会合并成一套，具体合并方式（保留会计口径还是列表口径，还是两边字段取并集）会在执行阶段核对两边实际用户和权限点后再定，不会在这里让你选技术方案。

### 【我负责 — 你不用看】

- 中间件的具体设计（前端 `BulkImportDialog` 组件接口、后端 `bulk-import-engine` 的函数签名、匹配优先级算法、事务边界）、商品/客户/供应商三个存量模块改造后的回归验证方式、技术验收标准与 verify.sh，全部我自己定、自己验、自己贴证据。
- 技术栈沿用项目现状（Next.js App Router + Prisma + PostgreSQL，无需额外询问）。

### 【一次性告知 — 不同意就说】

- 歧义清单：你说"全部模块"，我按"排除4个高风险模块+1个非表枚举"解释，理由见上方风险点，不是我自己想少做。
- 假设清单：Uom/ProductCategory 用 `name` 作为导入匹配键；Driver/DriverSlot、Pricelist 的匹配键在执行阶段按现有唯一约束确定，不够用会补一个字段（小改）。

回复"确认"后我不再就实现细节打断你；如果你想调整"需要你判断"那几条里的任何一条范围，直接说，我按你说的改计划。