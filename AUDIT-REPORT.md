# veggie-demo 商业级上线审计报告

> 审计日期：2026-04-19
> 审计方法：全栈深度审计（代码级）
> 对标基线：Odoo / 同类成熟 B2B SaaS
> 审计范围：数据模型 · API · UI · 非功能性 · 主流程
> 本次审计**只审计、不开发**

---

## TL;DR（给老板/PM 的一页纸）

**当前状态**：功能骨架约 55%，但"看起来能跑通"和"商业级能交付"之间还差 **3-4 个月集中迭代**。

**三大核心风险**（任何一个都能阻断上线）：

1. 🔴 **定价引擎没接到订单创建路径** — Pricelist 的计算逻辑完整，但 `POST /api/orders` 直接信任前端传来的单价，`priceType`（Multi/Default/Last）完全形同虚设。客户随便改个价都能存进数据库。
2. 🔴 **供应商模型完全缺失** — 采购单里 supplier 是自由文本字段，没有 Vendor 表、没有 is_vendor 布尔、没有供应商应付账款。Odoo res.partner 的核心设计理念（客户=供应商=联系人统一模型）完全未采纳。
3. 🔴 **无多租户、无会计分录、无库存预留** — 任何一条都不具备做 SaaS 商用的资质；Decimal → Float 的金额精度也会在长期累积中出问题。

**综合评分**：**4.8 / 10**

| 维度 | 分数 | 说明 |
|------|------|------|
| 数据模型 | 4.3 / 10 | 16 个 model 覆盖核心 60%，缺会计/库存/采购/供应商 |
| API / 业务逻辑 | 5.0 / 10 | 端点完整但无事务、无幂等、无速率限制 |
| 前端 UI | 5.5 / 10 | 56 页完成 45%，i18n 70%，权限 UI 0% |
| 非功能性 | 3.5 / 10 | 多租户/GDPR/MFA/Audit 全缺 |
| 主流程（商品） | 6.0 / 10 | 能跑通，但 sequence 不排序、UoM 无换算 |
| 主流程（Pricelist） | 3.5 / 10 | 计算引擎完美但没接订单；无 Duplicate |
| 主流程（客户/供应商） | 5.0 / 10 | 客户 OK；供应商完全缺 |

---

## 目录

1. [审计方法与对标基线](#1-审计方法与对标基线)
2. [数据模型层](#2-数据模型层)
3. [API / 业务逻辑层](#3-api--业务逻辑层)
4. [前端 UI 层](#4-前端-ui-层)
5. [非功能性需求](#5-非功能性需求)
6. [主流程审计 A：商品创建与购买](#6-主流程审计-a商品创建与购买)
7. [主流程审计 B：Pricelist 能力](#7-主流程审计-bpricelist-能力)
8. [主流程审计 C：客户与供应商](#8-主流程审计-c客户与供应商)
9. [Top 20 生产阻断问题（按优先级）](#9-top-20-生产阻断问题按优先级)
10. [分阶段修复路线图](#10-分阶段修复路线图)
11. [商业级上线 Checklist](#11-商业级上线-checklist)

---

## 1. 审计方法与对标基线

本次审计使用 3 个并行的 Explore Agent，对项目进行全栈代码级扫描：

- **数据模型层**：读 `prisma/schema.prisma` + `lib/types.ts` + CSV 导入脚本
- **API / 业务逻辑层**：读 `app/api/**/route.ts` + `lib/auth.ts` / `pricing-engine.ts` / `api.ts`
- **前端 UI 层**：读 `app/**/page.tsx` + `components/**` + `messages/*.json`
- **非功能性**：读 `cloudbuild.yaml` / `Dockerfile` / `sentry.*.config.ts` / `.env*`
- **主流程**：按用户在审计中追加的 7 个商品检查点 + 4 个 pricelist 检查点 + 3 个客户检查点逐条验证

**对标基线**：

- 真实的 Odoo 实盘数据（88 个 pricelist、1463 个客户、1798 个商品、14.5 万笔销售订单——来自同行业的爱尔兰亚洲食材批发商）
- Odoo 官方 8 大业务域模型：product / res.partner / pricelist / purchase / sale / account / stock / base

---

## 2. 数据模型层

### 2.1 已有 Model 一览

项目共 **16 个 Prisma model**：

User · ProductTemplate · Product · ProductCategory · ProductAttribute · ProductAttributeValue · Customer · CustomerSpecialPrice · OdooPricelist · Order · PickingWave · Trip · Invoice · StockMove · PurchaseRecord · ActionLog

### 2.2 关键缺失 model（对标 Odoo）

| 严重度 | 缺失模型 | 业务影响 |
|--------|---------|---------|
| 🔴 | account.move / account.move.line / journal / account | 无法对账、无法生成财务报表、无法支持审计 |
| 🔴 | stock.location / warehouse / stock.picking | 无法多仓库、无标准收货单 |
| 🔴 | purchase.order / purchase.order.line | PurchaseRecord 只是纯历史记录，没有审批工作流 |
| 🔴 | res.partner 的 is_vendor 维度 | 供应商完全无法管理 |
| 🔴 | res.company / tenant_id | 无法做 SaaS 多租户 |
| 🟡 | stock.inventory / stock.valuation | 无盘点、无加权平均成本 |
| 🟡 | account.payment | Invoice 有 amountPaid 但无支付流水表 |
| 🟡 | UoM / UoM.category | 计量单位只是自由文本，无法表达"1 CASE = 10 UNIT" |
| 🟡 | product.supplierinfo | 商品-供应商多对多关联缺失 |
| 🟢 | crm.lead / opportunity / ir.attachment | 线索、附件管理后期可补 |

### 2.3 字段级致命问题

- **全表用 `Float` 而非 `Decimal`**：listPrice、totalTax、amountPaid 等金额字段都是 Float。`0.1 + 0.2 = 0.30000000000000004` 的累积偏差会在成千上万笔订单后破坏对账。**必须迁移为 `Decimal @db.Numeric(10,2)`**。
- **全表零索引**：没有任何 `@@index`。`Order.customerId` / `Invoice.status` / `StockMove.productId` 这些高频查询字段都没索引，几百条订单后列表页会明显变慢。
- **外键靠纯文本**：`Order.restaurantId`、`Trip.waveId`、`CustomerSpecialPrice.productId` 都是 String，没有 Prisma `@relation`。删除客户时订单变成孤儿数据。
- **缺审计字段**：除 ProductTemplate 外，`createdBy` / `updatedBy` / `deletedAt` 普遍缺失。
- **无多租户**：任何 model 都没有 `company_id`，B2B SaaS 直接死穴。

### 2.4 状态机完整度

| 业务对象 | 现有状态 | Odoo 对应 | 缺失 |
|---------|---------|---------|------|
| Order | PENDING / WAVE_ASSIGNED / IN_DELIVERY / COMPLETED | draft/sent/sale/done | 缺 QUOTATION 层 |
| Invoice | DRAFT / POSTED / PAID / CANCELLED | draft/posted/paid/reversed | 缺 REVERSED、REFUND |
| Wave | PENDING / PICKING / PICKED / SORTING / SORTED | - | 合理（自研） |
| Trip | PENDING / VERIFYING / IN_PROGRESS / COMPLETED | - | 合理（自研） |
| PurchaseOrder | **无 model** | RFQ→sent→confirmed→received→invoiced | **整套缺失** |

---

## 3. API / 业务逻辑层

### 3.1 端点总览

共 ~30 个 API 端点，`withAuth` 覆盖率约 85%（写操作全部已覆盖，得益于 4 月 17 日的健壮性修复）。

### 3.2 业务闭环评估

| 闭环 | 状态 | 缺失环节 |
|------|------|---------|
| 销售闭环（报价→订单→发货→开票→收款） | 🟡 部分 | 无报价 Quotation 层；无收款 Payment API；订单→发票→收款无事务捆绑 |
| 采购闭环（PO→收货→入库→账单→付款） | 🔴 大量缺失 | 只有 PurchaseRecord 历史记录，无 PO、无 GRN、无 Vendor Bill、无 AP |
| 库存闭环（出入库→调整→盘点→保留） | 🟡 部分 | 有 StockMove，无 Reservation（下单不预留库存）、无盘点、无多仓 |
| 会计闭环（事件→分录） | 🔴 全缺 | 无 journal entry，发票创建后不产生任何会计影响 |

### 3.3 高危问题（逐条）

| # | 问题 | 位置 | 风险 |
|---|------|------|------|
| 1 | 订单创建时不扣减库存、不预留库存 | `POST /api/orders` | 并发超卖 |
| 2 | 订单创建不是事务 | `POST /api/orders` | 中途失败脏数据 |
| 3 | 发票创建不是事务 | `POST /api/invoices` | 发票-订单-收款三者不一致 |
| 4 | 订单的 `items[].price` 完全信任前端 | `POST /api/orders` 校验层 | 客户/销售员可随意改价 |
| 5 | 无 Idempotency-Key | 所有 POST | 网络重试导致重复下单 |
| 6 | JWT_SECRET fallback 默认值 | `lib/auth.ts:4` | 生产环境未设环境变量时任何人可伪造 token |
| 7 | 图片上传接口无 withAuth | `POST /api/upload-image` | 任何人可上传占用 GCS |
| 8 | 无速率限制 | 所有接口 | 暴力破解 / DDoS |
| 9 | 错误信息大量中文硬编码 | 所有 route.ts | i18n 断裂 |
| 10 | ActionLog 无字段级 diff | `lib/action-log.ts` | 审计追溯不到价格/税率改动的前后值 |

### 3.4 与 Odoo 的功能缺口

- 无 Quotation → Sale Order 升级流程
- 无工作流审批（大额订单、大额发票无审批卡点）
- 无 EDI / 自动开票 / 账期预警
- 无多货币（EUR 硬编码）
- 无 CRM（线索、商机）

---

## 4. 前端 UI 层

### 4.1 页面总览

56 个页面：✅ 完成 7 / 🟡 部分 25 / 🔴 缺失 24，完成度约 **45%**。

**按角色分布**：

- 运营 (operator)：18 页 · 6 🟡 · 6 🔴
- 餐馆 (restaurant)：2 页 · 2 🟡
- 拣货/分货/司机：5 页 · 4 ✅ · 3 🟡
- 老板/财务/仓库：3 页 · 3 🟡（基本只有骨架）
- 公共：3 页 · 1 ✅ · 2 🔴

**关键缺失页面**：

| 缺失 | 对应 Odoo 页面 | 影响 |
|------|--------------|------|
| `/operator/customers/[id]` 详情页无 Tab 布局 | Partner form (Sales & Purchase / Invoicing / Loyalty / Internal Notes) | 看不到单个客户的完整画像 |
| `/operator/products/[id]` 无完整详情 | Product form | 变体、BOM、成本历史全无入口 |
| Invoice 详情无 Payment Tab | account.move payment widget | 无法登记收款 |
| 无 Dashboard 首页 | `/web#action=...` | 运营每次进来都要从菜单选 |
| 无用户/角色/权限管理页 | Settings > Users & Companies | 无法自助加账号 |

### 4.2 i18n 覆盖度

- `messages/{zh,en}.json` 共 302 行，通用 key 完整
- 但 **~150-200 处硬编码中文** 散在 `toast.error()`、`confirm()`、空状态、按钮 label 里
- 英文质量中等，个别 key 缺英文（如订单 status tab 标签）
- 覆盖评分：**6.5 / 10**

### 4.3 交互四象限

| 维度 | 评分 | 主要问题 |
|------|------|--------|
| List（列表） | 6.5 | 无虚拟滚动、无高级筛选、无持久化排序 |
| Form（表单） | 5.5 | 无实时校验、无字段级 error、无防重复提交视觉反馈 |
| Detail（详情） | 6.0 | 缺 Tab 布局、缺关联数据面板、按钮分组混乱 |
| Action（操作） | 5.0 | 无批量操作、无工作流可视化、无撤销 |

### 4.4 权限 UI

🔴 **完全缺失**：无论什么角色，所有按钮（删除、编辑、新增）都显示为可点。点击后由后端 withAuth 拦截返回 403，但 UI 没有隐藏/禁用/提示。用户体验极差，也给了恶意用户探测权限边界的可能。

### 4.5 移动端 / 可访问性

- 🔴 表格固定宽度，移动端左右横滑
- 🔴 `/operator/pricelists/[id]` 的 Items 编辑在小屏不可用
- 🔴 图片大量无 `alt`，icon-only 按钮无 `aria-label`
- 🔴 表单无键盘导航 `Tab` 顺序优化

### 4.6 组件复用

- ✅ `OdooTable` / `OdooNav` / `StatusBadge` 系列已抽象
- 🔴 70% 页面仍手写 `<table>` markup、手写 pagination、手写 loading
- 🔴 无 `FormBuilder` / `CrudList` / `DetailTabs` 高阶组件
- 🔴 样式硬编码（`className="bg-green-600 ..."` 到处都是，无 design token）

---

## 5. 非功能性需求

12 维度审计结果：

| # | 维度 | 状态 | 紧迫度 |
|---|------|------|-------|
| 1 | 认证 / 授权 | 🟡 | P1（无 MFA / SSO / Token 吊销 / field-level 权限） |
| 2 | 多租户隔离 | 🔴 | **P0**（完全缺 company_id） |
| 3 | 审计日志 | 🟡 | P1（无字段级 diff、无 append-only） |
| 4 | 可观测性 | 🟡 | P1（Sentry DSN 未配置，无结构化日志，无 Trace ID） |
| 5 | 性能 | 🟡 | P2（无索引、无虚拟化、无缓存） |
| 6 | 安全 | 🟡 | P1（无速率限制、无 CSP/HSTS、无依赖审计） |
| 7 | 合规 GDPR | 🔴 | **P0**（无数据导出/删除 API、无 Cookie 同意） |
| 8 | 备份 / 灾难恢复 | 🔴 | P1（靠 Neon 默认，无 RTO/RPO 文档、无演练） |
| 9 | CI/CD | 🟡 | P1（用 `prisma db push` 而非 `migrate`，min-instances=0 冷启动） |
| 10 | 开发者文档 | 🔴 | P2（README 只有 create-next-app 模板，无 OpenAPI、无 ADR） |
| 11 | i18n / 多货币 | 🟡 | P2（货币写死 EUR、VAT 硬编码 13.5%、时区未处理） |
| 12 | 可用性 / SLA | 🔴 | P1（无 `/api/health`、无超时配置、min-instances=0） |

**NFR 覆盖率估计：35%**

---

## 6. 主流程审计 A：商品创建与购买

按用户给出的 7 个检查点逐条审计：

| # | 检查点 | 状态 | 关键发现 |
|---|--------|------|---------|
| 1 | **Sequence 决定打印顺序** | 🟡 部分 | `ProductTemplate.sequence` 字段存在、商品表单能编辑、`GET /api/products` 按 sequence 排。**但发票打印页 `invoices/[id]/print/page.tsx:152` 直接 `inv.lines.map()`，不按 sequence 排序**。拣货波次、司机配送页同样不排序。打印出来的顺序和商品设置的 sequence 对不上 —— 这会导致司机装车顺序乱。 |
| 2 | **Product Type 联动** | 🟡 部分 | Enum product/consu/service 存在，下拉能选。**但选了 consu（消耗品、不记库存）后，qtyOnHand / qtyForecast 的 UI 仍然展示**。Odoo 的行为是选 consu 后库存 tab 直接隐藏。 |
| 3 | **UoM 配置** | 🔴 缺失 | `unitOfMeasure` / `purchaseUoM` 是 String 自由文本。没有 UoM / UoMCategory model，没有 `app/operator/uoms` 配置页。无法表达"1 CASE = 10 UNIT"这种换算关系——这对批发行业（进货一箱，卖零散件）是必需功能。 |
| 4 | **Commission Price（司机佣金）** | 🟡 字段有 / 流程无 | `commissionPrice` 字段存在、能编辑。**但 driver 端没有佣金计算、没有司机收入汇总、Trip / SaleOrder 也没有 driverCommission 字段**。司机看不到自己送这一单能拿多少钱。 |
| 5 | **Vendor 绑定** | 🔴 缺失 | 没有 `ProductSupplierInfo` / `product.supplierinfo` 模型。采购记录里 `supplier` 是纯文本字段。商品编辑页没有 Purchase Tab（Odoo 上该 Tab 列出"本商品的几个供应商 + 各自的进货价"）。 |
| 6 | **图片上传** | ✅ 完整 | `POST /api/upload-image` 接 GCS，支持多图、MIME 校验、5MB 限制；商品编辑页有上传控件；餐馆下单页正确渲染。**唯一问题**：上传接口无 `withAuth`，任何人都能上传（参见 3.3 #7）。 |
| 7 | **餐馆端能否购买** | ✅ 基本闭环 | `restaurant/page.tsx` 拉 `GET /api/products`（含过滤 ACTIVE），价格走 `resolveCustomerPrice`，下单时快照 `pricelistId / priceType`。**但下单的价格不校验**（见 3.3 #4），所以闭环在形式上是通的，实际不可信。 |

**主流程 A 完整度**：**6 / 10**

---

## 7. 主流程审计 B：Pricelist 能力

按用户的 4 块检查：

### 7.1 详情 / Items 管理

| 能力 | 状态 |
|------|------|
| 列表点击进入详情 | ✅ |
| 详情展示 items（全局/类目/商品/变体 4 级） | ✅ |
| 新增 item（ItemDialog 弹窗） | ✅ |
| 编辑 / 删除 item | ✅ |
| Items 列表**分页** | 🔴 缺失 |
| 按商品名/SKU **搜索** | 🔴 缺失 |
| 列**排序**（Min Qty / 日期 / Price 升降序） | 🔴 缺失 |
| 按 Apply On / 日期范围 **filter** | 🔴 缺失 |

单张 pricelist 可能有 70+ 条 items（实盘 CITY CENTRE 菜价是 72 条），无搜索/分页/排序/过滤时运营基本找不到想改的那一条。

### 7.2 Pricelist 复制（Duplicate）

🔴 **完全缺失**。列表页只有"新建"和"删除"，详情页没有"复制"按钮。业务场景里非常常见："给新客户 X 做一张类似 Y 的 pricelist" —— 现在只能手工逐条再输入 70 条。

### 7.3 三层规则能力

| 能力 | 状态 |
|------|------|
| Global（All Products）Fix / Percentage / Formula | ✅ |
| Product Category 级规则 | ✅ |
| Product 级规则 | ✅ |
| Variant 级规则 | ✅ |
| Based On = Other Pricelist（嵌套） | ✅（含防循环深度 5） |
| Min Qty / Start Date / End Date | ✅ |

**规则定义能力本身是这次审计里最完整的部分，基本 100% 对标了 Odoo 的 pricelist.item 弹窗。**

### 7.4 挂客户并生效

| 能力 | 状态 |
|------|------|
| 客户编辑能绑 pricelist | ✅ |
| 订单快照 `pricelistId / priceType` | ✅ |
| **订单创建时真正调用 `resolvePrice()` 定价** | 🔴 **未接入** |
| 订单行价格溯源（显示来自哪条规则） | 🔴 缺失 |

**这是整个 Pricelist 模块最致命的缺陷**：引擎实现的非常完整（`lib/pricing-engine.ts` 做得很好），但 `POST /api/orders` 压根没调用它。前端传什么价后端就存什么价。

**主流程 B 完整度**：**3.5 / 10**（规则定义 9 分，但业务集成 0 分）

---

## 8. 主流程审计 C：客户与供应商

### 8.1 Price Type 生效性

| 能力 | 状态 |
|------|------|
| `Customer.priceType` 字段 | ✅ |
| UI 能选 Multi / Default / Last | ✅ |
| 订单创建快照 priceType | ✅ |
| **Last Price 查询 API**（`/api/orders/last-price`） | ✅ 存在 |
| **根据 priceType 分派计算**（Multi 走 pricelist / Default 用 listPrice / Last 查历史） | 🔴 **未落地** |

priceType 是一个"看起来能用"的字段，但后端没有根据它做任何分派。Last Price API 独立存在，却未被订单创建路径调用。

### 8.2 Commission Rate 配送佣金

| 能力 | 状态 |
|------|------|
| `Customer.commissionRate` 字段 | ✅ |
| `Customer.commissionFixed` 字段 | 🔴 缺失 |
| 客户编辑页能编辑 | ✅ |
| 司机端按客户佣金汇总 | 🔴 缺失 |
| Trip / SaleOrder 落地"本单司机应得佣金" | 🔴 缺失 |

当前的 commissionRate 被金融模块解读为"累计客户佣金展示"，**和司机完全没有关联**。司机端看不到自己应得多少钱。

### 8.3 Vendor 在 Contacts 里管理

| 能力 | 状态 |
|------|------|
| `Customer.isVendor` 布尔 | 🔴 缺失 |
| `Customer.isCustomer` 布尔 | 🔴 缺失 |
| 独立的 Supplier / Vendor model | 🔴 缺失 |
| 客户列表过滤"只看客户/只看供应商/双方" | 🔴 缺失 |
| 采购单 supplier 关联到 Customer 表 | 🔴 缺失（纯文本） |

**Odoo res.partner 的核心设计理念（客户=供应商=联系人统一模型，通过两个布尔字段区分）完全没有在本项目中实现。** 这不仅仅是缺字段的问题，是整个"Contacts"模块的骨架性缺失。

### 8.4 字段覆盖度

对比 Odoo res.partner 的 14 个核心字段，本项目 Customer 覆盖了 6 个（externalId / name / priceType / pricelistId / paymentTerm / creditLimit / commissionRate / vatNumber / address / city），覆盖度 **约 45%**。

**主流程 C 完整度**：**5.0 / 10**

---

## 9. Top 20 生产阻断问题（按优先级）

### 🔴 P0（不能上线，必须修）

| # | 问题 | 所属层 | 估时 |
|---|------|--------|------|
| 1 | 订单 `items[].price` 不校验、Pricelist 引擎未接入订单路径 | API / 主流程 | 5 天 |
| 2 | 供应商模型完全缺失（无 is_vendor / 无 ProductSupplierInfo） | 数据 / 主流程 | 10 天 |
| 3 | 金额用 Float 而非 Decimal（长期对账偏差） | 数据 | 5 天 + 数据迁移 |
| 4 | 无多租户（无 company_id，SaaS 死穴） | 数据 / API | 10 天 |
| 5 | JWT_SECRET 有 fallback 默认值（生产可伪造） | 安全 | 0.5 天 |
| 6 | 订单 / 发票创建不是事务（中途失败脏数据） | API | 3 天 |
| 7 | 订单不扣库存、不预留（并发超卖） | API | 5 天 |
| 8 | 无 GDPR 数据导出 / 删除 API（EU 客户违法） | 合规 | 5 天 |

### 🟡 P1（3 个月内必须解决）

| # | 问题 | 所属层 | 估时 |
|---|------|--------|------|
| 9 | 权限 UI 缺失（所有按钮对所有人可见） | UI | 5 天 |
| 10 | Sequence 字段有但发票/波次/配送不排序 | UI + API | 2 天 |
| 11 | ProductType 选 consu 后库存 UI 不隐藏 | UI | 1 天 |
| 12 | 无速率限制 / CSP / HSTS | 安全 | 2 天 |
| 13 | Pricelist 无 Duplicate 复制 | UI + API | 2 天 |
| 14 | Pricelist Items 无分页/搜索/排序/过滤 | UI | 3 天 |
| 15 | Customer / Invoice 详情无 Tab 布局 | UI | 5 天 |
| 16 | ActionLog 无字段级 diff | API | 3 天 |
| 17 | 无 health check endpoint，min-instances=0 冷启动 | NFR | 1 天 |
| 18 | Sentry DSN 未配置、无结构化日志 | NFR | 2 天 |
| 19 | `prisma db push` → 切换到 `prisma migrate` | CI/CD | 2 天 |
| 20 | i18n 150-200 处硬编码中文残留 | UI | 3 天 |

P0 合计估时：~45 人日
P1 合计估时：~35 人日

---

## 10. 分阶段修复路线图

### Phase 1（4 周）— 阻断性修复，不做不能上线

- [ ] Pricelist 引擎接入 `POST /api/orders` 并做价格校验
- [ ] 建 Supplier / ProductSupplierInfo 模型，加 is_customer / is_vendor 到 Partner
- [ ] Float → Decimal 迁移脚本 + 数据回填
- [ ] 加 company_id 字段 + RLS 策略 + 查询中间件
- [ ] 订单 / 发票 / 库存三个核心写路径包 `prisma.$transaction`
- [ ] 订单下单预留库存（StockReservation 表）
- [ ] JWT_SECRET 强制环境变量 + Upstash Redis blacklist
- [ ] GDPR：/api/gdpr/export + /api/gdpr/delete

### Phase 2（6 周）— 核心商业能力补齐

- [ ] account.move / account.move.line / journal 会计分录
- [ ] purchase.order / vendor bill / goods receipt 完整采购流
- [ ] stock.location / warehouse / stock.picking 标准单据
- [ ] UoM 体系（含换算）
- [ ] Pricelist Duplicate + Items 分页/搜索/排序
- [ ] 权限 UI（@casl/ability + React Context）
- [ ] 字段级 ActionLog diff

### Phase 3（4 周）— 上线运维就绪

- [ ] Sentry + Pino 结构化日志 + trace ID
- [ ] /api/health + min-instances=1 + 蓝绿部署
- [ ] 速率限制 + CSP + HSTS
- [ ] OpenAPI 文档 + 架构 ADR
- [ ] 灾难恢复演练 + RTO/RPO 文档
- [ ] MFA（TOTP）

### Phase 4（3 周）— 细节打磨

- [ ] 移动端响应式（table → card）
- [ ] 可访问性（alt / aria / 键盘导航）
- [ ] 批量操作 + 高级筛选 + 虚拟滚动
- [ ] 工作流 Stepper + 全局操作日志面板
- [ ] 多币种 + 动态税率

**总工期估算**：17 周（约 4 个月），按 3-4 人团队计。

---

## 11. 商业级上线 Checklist

运维 / 老板验收用的一页纸清单（上线前必须全绿）：

### 安全堡垒
- [ ] JWT_SECRET 环境变量必填，无 fallback 默认值
- [ ] Token 吊销机制（Redis blacklist）
- [ ] 全部写接口有速率限制
- [ ] CSP / HSTS / X-Frame-Options HTTP 头
- [ ] `npm audit` 零高危漏洞，CI 集成
- [ ] 密钥季度轮换计划
- [ ] 文件上传接口有 withAuth

### 数据治理
- [ ] 所有表有 company_id 字段 + RLS 策略测试通过
- [ ] 金额字段全部 Decimal（grep 无残留 Float）
- [ ] ActionLog 含 before/after diff
- [ ] 关键表有 @index
- [ ] 软删除规范（archived / deletedAt）统一

### 业务完整性
- [ ] 订单 / 发票 / 库存写路径都是事务
- [ ] 订单创建扣减 / 预留库存
- [ ] Pricelist 引擎真的被订单调用
- [ ] 供应商模型可用（Vendor 管理页、is_vendor、采购单有外键）
- [ ] 会计分录自动生成

### 可观测性
- [ ] Sentry 生产 DSN 已配置，告警规则就位
- [ ] `/api/health` endpoint 存在且 GCP 健康检查接通
- [ ] 结构化日志（Pino / Winston），每条带 trace ID
- [ ] min-instances ≥ 1

### 合规
- [ ] `/api/gdpr/export` + `/api/gdpr/delete`
- [ ] Cookie 同意 banner
- [ ] 隐私政策、数据处理协议上架
- [ ] 爱尔兰 VAT 动态化（不硬编码 13.5%）

### 部署
- [ ] `prisma migrate`（非 `db push`）
- [ ] 回滚剧本 + 一键回滚命令
- [ ] 备份恢复演练过 1 次
- [ ] RTO / RPO 文档化

### 文档
- [ ] OpenAPI / Swagger auto-generated
- [ ] 架构 ADR 记录（为什么 Neon / 为什么多租户用 RLS）
- [ ] 运维手册、新人 onboarding 文档

---

## 附：审计证据索引

本报告的每一条结论都可追溯到具体文件。详见三份分 agent 的原始报告（已合并到本文各章节）：

- 数据模型审计 → 第 2 章
- API / 业务逻辑审计 → 第 3 章
- 前端 UI 审计 → 第 4 章
- 非功能性审计 → 第 5 章
- 主流程 A/B/C 审计（按用户追加的 14 个检查点） → 第 6/7/8 章

---

*审计人：Claude (全栈深度审计) · 审计模式：只读分析、不修改代码*
*下一步建议：按 Phase 1 的 8 条 P0 立即启动，不建议边修边上线*
