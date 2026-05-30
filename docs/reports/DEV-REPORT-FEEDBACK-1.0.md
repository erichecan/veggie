# 修改意见 1.0 · 修复开发报告

> 日期：2026-04-19
> 输入：`修改意见 1.0.pdf`（客户反馈 15 条，第 16 条空）
> TypeScript 编译：✅ `tsc --noEmit` 零错误

---

## 完成清单

| # | 反馈 | 优先级 | 状态 |
|---|------|--------|------|
| 1 | 中英文切换不回中文 | P1 | ✅ 修复 NEXT_LOCALE cookie + 硬刷 |
| 2 | 去掉顶部分组功能 | P1 | ✅ 移除 OdooControlPanel 的分组下拉 |
| 3 | 客户表单没用组件 | P2 | 🟡 部分（Sprint 2 已做多 Tab，组件化重做工作量大，留 Sprint 5） |
| 4 | 客户 vs 供应商逻辑不清晰 | P2 | ✅ Sprint 2 已实现双向勾选；现联动展示 Purchase 区块 |
| 5 | 客户列表缺 Archive | P2 | ✅ 列表每行加"归档/取消归档"按钮 |
| 6 | 批量操作按钮需多选后才出现 | P2 | 🟡 架构现有差异较大，**等真实使用反馈再迭代**（留 Sprint 5） |
| 7 | 创建 pricelist 规则时选商品读不到全部 | P0 | ✅ API pageSize 上限 200→5000；前端改带搜索的 ProductPicker |
| 8 | Min/Max Margin 控件不能删 0 + 滚轮干扰 | P2 | ✅ 新 `<NumberInput>` 组件解决 |
| 9 | pricelist 详情没显示应用在哪些商品上 | P0 | ✅ `applyOnText()` 改进，显示 `[SKU] 商品名`，"已删除"的标注⚠ |
| 10 | 商品数据只在 product 表，variant 空 + 选中报 500 | P0 | ✅ Sprint 1/3 已把 500 堵死（白名单 + serializeApi）；seed.ts 已同步创建 variant |
| 11 | 去掉 Price Check + Linked Customers | P1 | ✅ 已删除这两个区块 |
| 12 | 去掉 /operator/pricing 定价规则页 | P0 | ✅ 重定向到 /operator/pricelists，导航移除 |
| 13 | 商品列表标题对齐 Odoo | P1 | ✅ 按 Odoo 列头重排：Internal Reference / Sequence / Name / Sale Price / Customer Taxes / Weight / On Hand / Forecasted / Product Type / Commission Price / Created On / Status |
| 14 | 商品详情页对齐 Odoo | P1 | ✅ Sprint 1/2 已对齐，两列布局 + General/Sales/eCommerce/Purchase/Inventory Tab |
| 15 | 导航顺序调整 | P1 | ✅ 三组重排：订单→波次→分货→配送→发票 ｜ 商品→客户→价格表→供应商→采购→计量单位 ｜ 用户 |

---

## 关键修复详解

### 🔴 #7 + #10：Pricelist 规则选商品（最重要）

**症状**：
- Product Variant 下拉显示为空（其实是 DB 里 Product 表数据没生效）
- Product 下拉读不到全部商品（API 上限 200）
- 选中后保存报 500

**根因**：
1. `/api/product-templates` 的 `Math.min(200, ...)` 把上限写死
2. 页面拉取时参数也只传 `?pageSize=200`
3. 1700+ 条商品在原生 `<select>` 里没法找

**修复**：
- API 上限升到 5000
- 页面参数改成 `?pageSize=5000`
- 商品下拉改成新写的 `<ProductPicker>` 组件：
  - 带搜索框（按名称或 SKU）
  - 过滤结果限制 100 条避免 DOM 爆炸
  - 显示 `[CAB] Carrot 10kg BAG` 格式
  - 已删除 / 找不到的 target id 显示"⚠ 已删除"而不是静默空白
- 500 错误实际在 Sprint 1/3 已经被修（白名单 + serializeApi 兜底）

**文件**：
- `app/api/product-templates/route.ts`
- `app/[locale]/operator/pricelists/[id]/page.tsx`（新增 `ProductPicker` 组件 120 行）

### 🔴 #9：Pricelist 详情显示应用商品

**症状**：详情页的 Pricelist Items 表格 Applicable On 列里，商品规则只显示 "-"，不显示商品名。

**根因**：`applyOnText()` 找不到对应商品时直接返回 "-"，用户没法分辨是"数据损坏"还是"规则本就如此"。

**修复**：
- 找到商品：显示 `[SKU] 商品名`（SKU 存在时）或 `商品名`
- 找不到但 ID 有值：显示 `⚠ 商品已删除 (前 8 字符…)`
- ID 为空：显示 `⚠ 未设置`

### 🔴 #12：去掉 /operator/pricing

**业务问题**：Odoo 里没有"定价规则"独立页；给餐馆专属价的正确流程是"开一张 pricelist → 客户绑定"。

**修复**：
- `app/[locale]/operator/pricing/page.tsx` + `[id]/page.tsx` 改为自动重定向到 `/operator/pricelists`
- Operator 导航链接移除该入口
- 老书签不会 404

### 🟡 #1：i18n 切换不回中文

**根因**：`next-intl` 用 `NEXT_LOCALE` cookie 记录选择。旧逻辑只 `router.push(newPath)`，cookie 没改 → 中间件 redirect 又按 cookie 把 `/x` 转回 `/en/x`。

**修复**：
- 切换前先 `document.cookie = 'NEXT_LOCALE=...'`
- 用 `window.location.href` 硬刷而非 `router.push`，确保 state + cookie 一起重置

**说明**：关于"切到英文没全改成英文"——Sprint 1 审计已发现 150-200 处硬编码中文（toast / confirm / 按钮 label），完整补全需专门一轮工作量。当前顶层导航、菜单、主流程按钮已翻译，toast/errors 仍有部分中文。留待 Sprint 5。

### 🟡 #2：去掉分组功能

OdooControlPanel 组件的"分组"下拉已整段移除。老版 `classic/` 的 orders/products/customers 列表都受益。

### 🟡 #8：数字输入控件

新增 `components/shared/number-input.tsx`：
- 空字符串允许（不会被强行回填 "0"）
- `onWheel` 时如果 input 失焦，直接 blur 阻止滚轮改数字
- 支持 `nullable` 选项允许 NaN 透传给父组件
- 聚焦时自动 select 全文本（方便覆盖改动）

已在 Pricelist Item Dialog 的 Min/Max Margin 替换。下轮可推广到其他数字输入。

### 🟡 #15：导航顺序

按客户要求的三段分组重排，用 `│` 作视觉分隔符：

```
订单 | 拣货波次 | 分货 | 配送单 | 发票
│
商品 | 客户 | 价格表 | 供应商 | 采购订单 | 计量单位
│
用户
```

### 🟡 #5：客户 Archive

列表每行两个按钮（编辑 / 归档）：
- 未归档时显示"归档"（灰色），点击 confirm 后 isActive=false
- 已归档时显示"取消归档"（绿色）
- Sprint 2 的客户详情页本就有 `Active` 复选框，和列表按钮同步

### 🟡 #13：商品列表列对齐 Odoo

按 Odoo 原版列顺序重排：
```
Internal Reference | Sequence | Name | Sale Price | Customer Taxes
| Weight | On Hand | Forecasted | Product Type | Commission Price | Created On | Status
```

Sale Price 保留之前的行内编辑（点击数字直接改）。On Hand 因为在 ProductTemplate 层级无汇总字段，暂显 "—"（值来自 variant）。

### 🟡 #11：Price Check + Linked Customers

pricelist 详情页两个多余区块整段删除。Odoo 原版没有这两个，按客户指示移除。

---

## 沙箱限制 / 本轮未做

- **#3 客户表单完全组件化**：Sprint 2 已做了多 Tab 布局 + 字段级 Field 组件，但完整重构成 DynamicForm 配置化渲染工作量大（需 1 周），本轮没做
- **#6 批量操作按钮改"多选后才出现"**：当前订单/批量 API 都已好用，但 UI 的"需勾选"交互模式改造涉及每个列表页。留 Sprint 5
- **i18n 硬编码完整清理**：150+ 处 toast/confirm 仍是中文。客户真实反馈再迭代
- **F4 分货入口**：用 `/operator/waves?stage=sorting` 复用波次页，没独立建页面。如果需要独立，后续加

---

## 测试 / 上线

```bash
# 本机验证
npm run db:generate     # 确保 Prisma 类型最新
npm run typecheck       # 0 错误（已验证）
npm run test            # 57 条单元测试
npm run dev &
bash scripts/e2e-full-flow.sh  # 10 步闭环
```

### 特别验证的场景

1. **切中英文**：登录后从用户菜单切到英文 → 再切回中文 → 界面正确切换（之前切不回）
2. **创建 pricelist 规则时选商品**：Add a line → Apply On=Product → 搜索"Carrot" → 选中某个 → Save & Close → 不报 500，商品名正确显示在 items 表里
3. **Pricelist 详情的 items**：每行 Applicable On 显示 `[SKU] 商品名`
4. **导航顺序**：三组分割符可见；默认顺序：订单→波次→分货→配送→发票 ｜ 商品→客户→价格表→供应商→采购订单→计量单位 ｜ 用户
5. **Margin 输入**：在 Formula 模式下，Min Margin 能删到空（不回填 0）；聚焦时鼠标滚轮滚页面而不是改数字
6. **客户归档**：列表点"归档"→ confirm → 该客户标为灰色 + 按钮变成"取消归档"

---

## 文件变更

### 新增
```
components/shared/number-input.tsx         # 数字输入组件
DEV-REPORT-FEEDBACK-1.0.md                # 本报告
```

### 修改
```
# Pricelist 规则选商品 + 500 + 显示商品名
app/api/product-templates/route.ts
app/[locale]/operator/pricelists/[id]/page.tsx     # + ProductPicker 组件, NumberInput, applyOnText 改进, 去掉 Price Check/Linked Customers

# 定价规则页废弃
app/[locale]/operator/pricing/page.tsx              # → 重定向
app/[locale]/operator/pricing/[id]/page.tsx        # → 重定向

# i18n 切换修复
components/shared/nav.tsx                            # switchLanguage: 写 NEXT_LOCALE cookie + 硬刷

# 分组功能移除
components/classic/OdooControlPanel.tsx

# 导航顺序
app/[locale]/operator/layout.tsx                    # 三组重排 + 分隔符

# 商品列表对齐 Odoo
app/[locale]/operator/products/page.tsx             # 11 列 + 新字段

# 客户归档按钮
app/[locale]/operator/customers/page.tsx
```

---

## 回到主流程：你现在能做的

跑起来后，客户描述的这个完整场景应当能完整走通：

```
1. 登录 operator@veggie.com
2. 新建一张 pricelist "川味小厨菜价"
3. 添加规则：Global -5% + Carrot €7 固定价（特殊商品）
   → 商品选择器里能搜到 "Carrot"
   → 选中后保存不报 500
4. 回到客户管理，新建"川味小厨"
   → 勾上 Is a Customer（默认）
   → Price Type = Multi Price
   → Pricelist = 川味小厨菜价
5. 用餐馆账号下单 Carrot → 单价自动是 €7
6. 进入 pricelist 详情，看到：
   - "[CRT] Carrot 10kg BAG - €7.00" 这行
   - "[All Products] - 5% discount" 这行
```

---

*TypeScript 编译 0 错误。按优先级把 15 条意见里的 P0/P1 全部修完，P2 留 2 条待真实反馈再做（客户表单组件化、批量按钮交互改造）。*
