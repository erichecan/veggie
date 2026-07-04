# 价格模块 PRD（Product Requirements Document）

> 本文档描述 Veggie Demo 系统中价格模块的完整产品逻辑，基于 Odoo 定价体系设计。

---

## 一、核心数据结构（三层）

```
商品 (Product / Variant)
  └── listPrice              ← 牌价，最低优先级兜底

价格表 (OdooPricelist)
  └── items[]                ← 定价规则列表
        └── 每条规则 = 适用范围 + 触发条件 + 计算方式

客户 (Customer)
  ├── pricelistId            ← 关联一张价格表
  └── specialPrices[]        ← 客户专属特殊价格（最高优先级）
```

---

## 二、最终价格计算优先级（从高到低）

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1（最高）| 客户专属特殊价格 `CustomerSpecialPrice` | 直接覆盖一切，跳过价格表 |
| 2 | 价格表规则 `OdooPricelistItem` | 按 `sequence` 排序，第一条匹配生效 |
| 3（兜底）| 商品牌价 `product.listPrice` | 未命中任何规则时使用 |

---

## 三、价格表（OdooPricelist）

### 3.1 表头字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 价格表名称 |
| `active` | boolean | 是否启用（关闭后不参与定价） |
| `currency` | string | 货币，默认 `EUR` |
| `selectable` | boolean | 是否在 POS / 电商前台可选 |
| `website` | string? | 关联网站 |
| `countryGroups` | string[] | 适用国家组（内联可编辑列表） |
| `promotionalCode` | string? | 电商促销码 |
| `sequence` | number | 排序序号 |

### 3.2 定价规则（OdooPricelistItem）

每张价格表包含若干条规则，**按 `sequence` 升序排列，第一条命中即生效，后续规则不再计算。**

---

## 四、定价规则的两个维度

### 维度 1：适用范围（Apply On）

决定这条规则作用于哪些商品。

| 值 | 含义 | 需要额外选择 |
|----|------|-------------|
| `global` | 全部商品 | 无 |
| `category` | 指定商品分类 | `categoryId` |
| `product` | 指定商品模板（含该模板所有变体） | `productTemplateId` |
| `variant` | 指定具体商品变体（最精确） | `productVariantId` |

> **优先级说明**：优先级由 `sequence` 决定，不是 Apply On 本身。  
> sequence 越小越先匹配，第一条命中的规则生效。

---

### 维度 2：计算方式（Compute Price）

决定命中后如何计算最终价格。

#### ① Fix Price（固定价格）

```
最终价 = fixedPrice
```

直接设定一个固定价格，与牌价无关。

| 字段 | 说明 |
|------|------|
| `fixedPrice` | 固定单价（€） |

---

#### ② Percentage / Discount（折扣）

```
最终价 = listPrice × (1 - percentDiscount / 100)
```

例：`percentDiscount = 10` → 在牌价基础上打九折（减 10%）

| 字段 | 说明 |
|------|------|
| `percentDiscount` | 折扣百分比，10 = 减 10% |

---

#### ③ Formula（公式定价）

最灵活的方式，分三步计算：

**第一步：选择基准价（formulaBase）**

| 值 | 基准 |
|----|------|
| `list_price` | 商品牌价（Public Price） |
| `standard_price` | 商品成本价（Cost） |
| `pricelist` | 另一张价格表的计算结果（支持嵌套，最多 5 层防循环） |

**第二步：折扣 + 加价**

```
价格 = 基准价 × (1 - priceDiscount / 100) + priceSurcharge
```

| 字段 | 说明 |
|------|------|
| `priceDiscount` | 在基准价上再打折，单位 %（5 = 减 5%） |
| `priceSurcharge` | 额外加价，单位 €（可为负数） |

**第三步：利润保护（可选）**

```
if priceMinMargin → 价格 = max(价格, 成本 + priceMinMargin)   // 确保不低于最小利润
if priceMaxMargin → 价格 = min(价格, 成本 + priceMaxMargin)   // 确保不高于最大利润
```

| 字段 | 说明 |
|------|------|
| `priceMinMargin` | 最低利润（€），价格不能低于 成本 + 此值 |
| `priceMaxMargin` | 最高利润（€），价格不能高于 成本 + 此值 |
| `roundingMethod` | 四舍五入精度 |

---

## 五、定价规则的触发条件（过滤器）

每条规则在匹配 Apply On 之前，还必须满足以下条件：

| 条件 | 说明 |
|------|------|
| `minQty` | 购买数量 ≥ 此值才触发（0 = 始终适用） |
| `dateStart` | 今天 ≥ 开始日期才触发（空 = 无限制） |
| `dateEnd` | 今天 ≤ 结束日期才触发（空 = 无限制） |

> 三个条件同时满足才算命中。

---

## 六、客户专属特殊价格（CustomerSpecialPrice）

**最高优先级，直接绕过价格表所有规则。**

适用场景：长期合作特价、大客户专属价、谈判价格等。

| 字段 | 说明 |
|------|------|
| `productId` | 针对哪个商品变体（精确到变体） |
| `fixedPrice` | 固定价格（€） |
| `minQty` | 最低购买数量（多条记录时，数量阈值最高的优先） |
| `dateStart` / `dateEnd` | 有效期（空 = 永久有效） |
| `note` | 内部备注，如"长期合作特价" |

---

## 七、完整价格计算流程

```
客户下单某商品（购买数量 = qty）
        │
        ▼
客户有 specialPrices，且存在匹配项？
（匹配条件：productId 相同 + qty >= minQty + 今天在有效期内）
        ├── 是 → 取数量阈值最高的一条
        │       最终价 = specialPrice.fixedPrice ✅ 结束
        └── 否 ↓

客户有关联 pricelistId？
        ├── 否 → 最终价 = product.listPrice ✅ 结束
        └── 是 ↓

按 sequence 升序遍历 pricelist.items，对每条规则检查：
    ① qty >= item.minQty ？
    ② 今天在 dateStart ~ dateEnd 之间？
    ③ 商品匹配 applyOn（global / category / product / variant）？

    三项全部通过 → 按 computeType 计算
        ├── fixed      → 最终价 = fixedPrice ✅ 结束
        ├── percentage → 最终价 = listPrice × (1 - percentDiscount/100) ✅ 结束
        └── formula    → 最终价 = (基准价 × (1 - priceDiscount/100) + priceSurcharge)
                         再应用 minMargin / maxMargin 保护 ✅ 结束

所有规则均未命中 → 最终价 = product.listPrice ✅ 结束
```

---

## 八、UI 模块对照

### 8.1 新版（绿色主题）

| 模块 | 路由 | 功能 |
|------|------|------|
| 价格表列表 | `/operator/pricelists` | 列表 + 新建 + 点击进详情 |
| 价格表详情 | `/operator/pricelists/[id]` | 编辑表头 + Items CRUD + Price Check |
| 客户定价列表 | `/operator/pricing` | 所有客户 + 关联价格表概览 |
| 客户定价详情 | `/operator/pricing/[id]` | 分配价格表 + 管理专属特殊价格 |

### 8.2 经典版（Odoo 紫色主题，1:1 还原）

| 模块 | 路由 | 功能 |
|------|------|------|
| 价格表列表 | `/classic/operator/pricelists` | Odoo 风格列表 |
| 价格表详情 | `/classic/operator/pricelists/[id]` | Odoo 表单布局（OdooField + Active 按钮 + Country Groups 内联表格 + Item Dialog） |
| 客户定价 | `/classic/operator/pricing` | 内联面板，点击行展开客户的价格表分配和特殊价格管理 |

> 两个版本底层共用同一个定价引擎：`lib/pricing-engine.ts`

---

## 九、定价引擎 API（供开发参考）

```typescript
// 根据价格表计算商品价格
resolvePrice(
  product: Product,
  pricelist: OdooPricelist,
  allPricelists: OdooPricelist[],
  qty?: number,       // 默认 1
  date?: string,      // 默认今天
): PriceResolution

// 根据客户（含专属特殊价格 + 关联价格表）计算商品价格
resolveCustomerPrice(
  product: Product,
  customer: Customer,
  allPricelists: OdooPricelist[],
  qty?: number,       // 默认 1
): PriceResolution

// 返回值
interface PriceResolution {
  price: number           // 最终价格
  pricelistName: string   // 触发的价格表名称
  itemDesc: string        // 触发规则的描述（用于调试/展示）
  isFallback: boolean     // true = 未命中任何规则，使用了牌价
  isSpecialPrice?: boolean // true = 由客户专属特殊价格触发
}
```

---

## 十、数据库模型

### OdooPricelist（价格表）
```prisma
model OdooPricelist {
  id              String    @id
  name            String
  currency        String    @default("EUR")
  items           Json      @default("[]")   // OdooPricelistItem[]
  sequence        Int       @default(0)
  selectable      Boolean   @default(true)
  active          Boolean   @default(true)
  promotionalCode String?
  website         String?
  countryGroups   Json      @default("[]")   // string[]
  updatedAt       DateTime  @updatedAt
}
```

### Customer（客户，价格相关字段）
```prisma
model Customer {
  pricelistId   String?                      // 关联价格表
  specialPrices CustomerSpecialPrice[]       // 专属特殊价格
}

model CustomerSpecialPrice {
  id          String
  customerId  String
  productId   String
  minQty      Float     @default(0)
  fixedPrice  Float
  dateStart   String?
  dateEnd     String?
  note        String?
}
```
