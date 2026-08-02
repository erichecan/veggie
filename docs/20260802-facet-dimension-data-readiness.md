# 分面维度数据就绪度体检

> 目的：`docs/20260802-list-facet-search-v2-plan.md` §6 列了 21 页的可搜维度字典，但「schema 里有这个字段」≠「这个字段有数据」。
> 上线一个永远搜不到结果的维度，比不提供这个维度更糟。本文在把维度清单拿给客户之前，先用真实数据把死维度剔掉。
> 方法：解析 `prisma/schema.prisma` 取出全部 47 个模型的标量 String 列，每张表跑一条 SQL（单次全表扫描算完所有列）统计非空非空白填充数。
> 数据时间：2026-08-02，生产库。

---

## 1. 结论摘要

| 类别 | 数量 | 处置 |
|---|---|---|
| 全空文本列 | **27** | ⛔ 不得作为分面维度 |
| 低填充（0 < 填充 < 20%） | 30 | ⚠️ 可上但需预期管理 |
| 空表（无任何行） | 9 | ⛔ 无法验证，暂不做维度 |
| **额外发现的陷阱** | 2 | 见 §5，**其中一条影响最大** |

---

## 2. 全空文本列（27 列，必须剔除）

| 模型 | 行数 | 全空列 |
|---|---|---|
| Order | 149,874 | `deliveryBatch` |
| ProductTemplate | 5,482 | `tracking`, `websiteName`, `createdBy`, `updatedBy`, **`barcode`** |
| ActionLog | 5,283 | `ipAddress`, `userAgent` |
| Customer | 1,605 | `externalNote` |
| CreditNoteLine | 1,320 | `reason`, `sourceTripId` |
| CreditNote | 1,096 | `notes`, `createdBy` |
| ProductSupplierInfo | 192 | `productCode`, `productName` |
| OdooPricelist | 95 | `promotionalCode`, `notes`, `website` |
| Pallet | 83 | `label` |
| User | 51 | `mfaSecret` |
| PurchaseOrderLine | 51 | `uomId` |
| PurchaseSuggestion | 13 | `purchaseOrderId`, `resolvedBy` |
| Trip | 8 | `departTime`, `settledBy`, `settlementNote` |
| BackupJob | 2 | `gcsPath` |

**已处置**：`ProductTemplate.barcode` 已在阶段 1 从商品页维度中摘除（commit `e11faf7`，注释写明恢复位置）。

**对 §6 维度字典的直接影响**：
- 贷记单页原计划的「原因」维度 → `CreditNoteLine.reason` 全空，**删除**
- 价格表页的「备注」类维度 → `OdooPricelist.notes` 全空，**删除**
- 供应商商品编码维度 → `ProductSupplierInfo.productCode` 全空，**删除**

---

## 3. 低填充率（0 < 填充 < 20%，可上但要打招呼）

| 模型（行数） | 字段 | 填充 | 备注 |
|---|---|---|---|
| **Order** (149,874) | **`code`** | **861 (0.6%)** | **见 §5.1，最严重** |
| | `internalNote` | 58 (0.0%) | 几乎无用 |
| | `externalNote` | 8 (0.0%) | 几乎无用 |
| | `deliveryNote` | 1 (0.0%) | 几乎无用 |
| | `driverSlotId` | 22 (0.0%) | 印证 20260801 的结论：该列是「下单意向」，调度台从不回写 |
| | `printType` / `printedByName` | 15 (0.0%) | |
| | `priceType` | 104 (0.1%) | |
| ProductTemplate (5,482) | `internalRef` | 277 (5.1%) | 商品页维度**已上**，需告知客户覆盖率低 |
| | `description` | 14 (0.3%) | 商品页「描述」维度实际靠 `saleDescription`(27%) 支撑 |
| Product (5,479) | `internalRef` | 267 (4.9%) | |
| Customer (1,605) | `notes` | 274 (17.1%) | |
| | `zip` | 248 (15.5%) | |
| | `country` | 158 (9.8%) | |
| | `email` | 84 (5.2%) | 客户页「邮箱」维度价值有限 |
| | `vatNumber` | 46 (2.9%) | |
| | `state` | 7 (0.4%) | ⛔ 实际不可用 |
| OrderLine (1,337,567) | `spec` | 211 (0.0%) | |
| | `note` | 5 (0.0%) | |
| | `priceSourceDetail` | 111,204 (8.3%) | |
| PickingWave (51) | `pickLockedBy` | 8 (15.7%) | |
| PurchaseOrder (30) | `sourceDocumentName` | 1 (3.3%) | |

---

## 4. 空表（9 张，无法验证）

`ProductAttribute`、`ProductAttributeValue`、`CustomerSpecialPrice`、`OrderDiscrepancy`、`Payment`、`PurchaseRecord`、`JournalEntry`、`JournalEntryLine`、`Statement`

影响：
- **`Statement` 空表**，但 `finance/statements` 页面存在且计划里给了「客户 / 期间」维度 → 该页数据来自别处（`/api/statements` 实时聚合），维度需按实际返回结构重新确认，不能按 Statement 模型设计。
- **`ProductAttributeValue` 空表** → 直接回答了计划 §8 的问题 2：截图里 Odoo 的 `Search Attribute Values` 在我们这边**没有任何数据可搜**，不必投入。
- `Payment` / `JournalEntry` 空表属于会计域数据状态，与本次分面无关，但值得单独关注。

---

## 5. 两个额外发现

### 5.1 ⛔ 单号搜索会「看得见却搜不到」（影响最大）

`Order.code` 仅 **861 / 149,874 (0.6%)** 有值，且全部是系统内新建单（样本 `OP-260721-001`）；Odoo 导入的 14.8 万历史单该列为 null。

问题不在于覆盖率低，而在于**界面上是有单号显示的**：

```tsx
app/[locale]/classic/accounting/page.tsx:547        {o.code ?? o.id.slice(-8)}
app/[locale]/classic/driver/settlement/page.tsx:177 {o.code ?? o.id.slice(-8)}
app/[locale]/classic/boss/page.tsx:252              {o.code ?? o.id.slice(0, 8)}
app/[locale]/classic/boss/sales-report/page.tsx:235 {o.code ?? o.id.slice(0, 8)}
```

用户在列表上读到一个单号 → 粘进搜索框 → **搜不到**，因为分面查的是 `code` 列，而屏幕上那个值是渲染时从 `id` 现算的，数据库里根本不存在。

这比 barcode 全空糟糕得多：barcode 是「没有就搜不到」，这个是「明明看得见却搜不到」，用户会认为系统坏了。

**建议（三选一，需你决定）**：
1. 分面的单号维度同时匹配 `code` 和 `id` 后缀 —— 改动最小，但 `id.slice` 用 `contains` 匹配 cuid 尾部性能差
2. 给历史单回填 `code`（一次性脚本，14.8 万行）—— 一劳永逸，但要先定编码规则且不能与现有 `OP-` 序列冲突
3. 单号维度只在有 `code` 的单上可用，界面明示 —— 最省事但体验割裂

### 5.2 同一张单在不同页面显示两个不同的"单号"

上面四处兜底写法不一致：`id.slice(-8)`（会计、司机结算）取**后** 8 位，`id.slice(0, 8)`（老板看板、销售报表）取**前** 8 位。同一张没有 `code` 的订单，在会计页和老板页会显示两个完全不同的编号。

与分面搜索无关，属独立缺陷，建议统一（推荐并入 5.1 的方案 2 一并解决）。

---

## 6. 对 §6 维度字典的修订建议

在把清单拿给客户之前，先做以下裁剪：

| 页面 | 删除 | 保留但需说明 |
|---|---|---|
| 商品 | 条码（已删） | 内部编号 5.1%、描述实靠 saleDescription 27% |
| 客户 | 省/州(0.4%) | 邮箱 5.2%、增值税号 2.9%、邮编 15.5% |
| 贷记单 | 原因、备注（全空） | — |
| 价格表 | 备注、促销码、网址（全空） | — |
| 采购 | 供应商商品编码（全空） | 来源单据名 3.3% |
| 对账单 | — | Statement 表为空，维度需按 API 实际返回重定 |
| 全部含单号的页面 | — | **先解决 §5.1 再上单号维度** |
| （原计划）属性值 | 直接放弃 | ProductAttributeValue 空表 |
