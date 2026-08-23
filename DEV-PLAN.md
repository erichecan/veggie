# DEV-PLAN — 商品基准单位/采购单位/可售单位换算与定价

> 更新日期：2026-08-23
> 读取依据：无独立 PRD 文档；需求由用户对话直接描述（附两张截图），随后通过 `AskUserQuestion` 四问逐条确认关键决策（见下方「已确认决策」）。未读取额外产品文档。
> 涉及模块：商品详情页 `app/[locale]/classic/operator/products/[id]/page.tsx`、可售单位 API `app/api/products/[id]/sale-uoms/route.ts`、商品模板创建 `app/api/product-templates/route.ts`、采购单确认流转 `app/api/purchase-orders/[id]/route.ts`、公用换算函数 `lib/sale-uom.ts`、Schema `prisma/schema.prisma`。

---

## 0. 现状（实测代码，不是猜测）

### 0.1 基准单位（Unit of Measure）

- 存在 `ProductTemplate.uomId`（外键指向 `Uom`，`prisma/schema.prisma:316-318`）。
- 商品详情页点击「Edit」进入编辑态后，页头就有一个可编辑的下拉框（`app/[locale]/classic/operator/products/[id]/page.tsx:580-591`），改完随整页一起 `PUT /api/product-templates/[id]` 保存——**这个值本来就能改**，不是只读。
- 但下面「可售单位（多单位销售试点）」区块的"基础"单选钮（`:665-675`），保存时（`saveSaleUoms` → `PUT /api/products/[id]/sale-uoms`）也会把这个字段覆盖掉（`app/api/products/[id]/sale-uoms/route.ts:59-73`，这段代码本身是 20260819 为了修复"模板单位与可售单位基础不一致导致订单页系数算错"这个真实 bug 才加的，动机是对的，但做法是"两个入口各自写同一个字段"）。
- **已确认决策**：基准单位只能通过页头「Unit of Measure」下拉框改，「可售单位」区块的"基础"不再是可操作的开关，只是"哪一行等于页头选的那个单位"的自动展示。

### 0.2 采购单位（Purchase UoM）

- 存在 `ProductTemplate.purchaseUomId`（`prisma/schema.prisma:320-321`），页面展示同样在 `:620-624`。
- 实测**没有任何代码**会在采购单确认/收货时回写这个字段——现在库里的值全部来自 Odoo 导入时的一次性快照，或 `quick-create` 时手工选的（`app/api/products/quick-create/route.ts`），此后再也不会变。
- `PurchaseOrderLine.uomId` 是一个**没有 `@relation` 的裸字符串字段**（`prisma/schema.prisma:1215-1250` 内确认，只有 `@@index([uomId])`，不像 `ProductTemplate.uomId` 那样有正式外键关系）——不在本次改动范围，只是记录在案。
- **已确认决策**：采购单「确认采购」（`PATCH /api/purchase-orders/[id]` action=confirm，`targetStatus==='CONFIRMED'` 分支，与现有"生成供应商草稿账单+通知财务"同一个触发点）时，把这张单里每个商品最后一次出现的 `PurchaseOrderLine.uomId` 回写到该商品 `ProductTemplate.purchaseUomId`（`uomId` 为空的行跳过，不拿空值覆盖）。历史数据不做回填，只影响这次改动上线之后新确认的采购单。

### 0.3 可售单位换算系数（ProductSaleUom.factor）

- 完整模型见 `prisma/schema.prisma:382-428`：`factor` = "1 个此单位 = factor 个基础单位"，基础单位那一行恒为 1；`priceOverride` 留空则按 `基础单价 × factor` 自动折算。
- 前端目前要求用户**直接手填 factor 数字**（`= 基础 × [数字]`，`:676-691`），没有任何"输入真实规格、自动算比例"的辅助。
- `ProductTemplate.weight`（原有，通用"默认商品重量"）之外，这次对话前已经有一条**未提交但已应用到本地库**的迁移 `prisma/migrations/20260823000001_product_gross_net_weight/`，新增了 `grossWeight`/`netWeight` 两个字段（`prisma/schema.prisma:307-311`），目前全部商品该值为空，且**没有任何代码读它们**（只在导出 CSV 时显示）。
- **已确认决策**：换算计算器用 `netWeight`（净重，不是 `weight`）作为"1 个基准单位的真实重量"。同时用户指出一个更普遍的场景——大包装拆成多份小包装出售（如"一大袋=20小袋"，需要配出"1袋装/5袋装/10袋装"三个可售单位），这不是重量场景，是**计数场景**，见下方 §2.3 设计。

### 0.4 价格公式

- 现状价格只有"留空自动折算 / 填了就固定用这个数"两种状态（二选一），没有截图2那种"基准价 − 折扣% + 金额"的公式面板。
- 项目里已经有一套非常接近的 UI（客户价目表规则，`app/[locale]/classic/operator/pricelists/[id]/page.tsx:1072-1226`：`fixed / percentage / formula` 三态单选 + formula 态下的"Based on 下拉 + New Price = 基准 − 折扣% + 金额 + 取整/最低最高毛利"完整公式面板），可以直接借用这套交互模式，不用另起一套设计语言。
- **已确认决策**：可售单位这块除了换算计算器，还要照这个模式加一套独立的"价格公式"面板（自动/固定/公式三态），比现在"留空自动算"更透明可调。

---

## 1. Schema 改动

**只有价格公式这一项需要新增字段，基准单位/采购单位两项都是纯逻辑改动，不改表结构。**

`prisma/schema.prisma` 的 `ProductSaleUom` 新增：

```prisma
enum SaleUomPriceMode {
  AUTO     // 基准单价 × factor，四舍五入两位小数（现状默认行为）
  FIXED    // 直接用 priceOverride（现状"填了就固定"，只是显式建模成一个状态）
  FORMULA  // 基准单价 × factor × (1 − priceDiscountPct/100) + priceSurcharge
}

model ProductSaleUom {
  ...既有字段不变...
  /// 价格计算方式；默认 AUTO 与现状完全一致，存量数据据 priceOverride 是否有值一次性回填
  priceMode        SaleUomPriceMode @default(AUTO)
  /// FORMULA 模式下的折扣百分比，如 10 表示"打 9 折"
  priceDiscountPct Decimal          @default(0) @db.Decimal(6, 4)
  /// FORMULA 模式下的加减金额（可正可负），折扣之后再加
  priceSurcharge   Decimal          @default(0) @db.Decimal(12, 2)
}
```

迁移脚本（按项目现有做法：`db push` + 手写迁移 + `migrate resolve`，不用 `migrate dev`，理由见记忆"Prisma 迁移 shadow DB 问题"）：

```sql
CREATE TYPE "SaleUomPriceMode" AS ENUM ('AUTO', 'FIXED', 'FORMULA');
ALTER TABLE "ProductSaleUom" ADD COLUMN "priceMode" "SaleUomPriceMode" NOT NULL DEFAULT 'AUTO';
ALTER TABLE "ProductSaleUom" ADD COLUMN "priceDiscountPct" DECIMAL(6,4) NOT NULL DEFAULT 0;
ALTER TABLE "ProductSaleUom" ADD COLUMN "priceSurcharge" DECIMAL(12,2) NOT NULL DEFAULT 0;
-- 存量行按现有 priceOverride 是否有值一次性归类，行为不变
UPDATE "ProductSaleUom" SET "priceMode" = 'FIXED' WHERE "priceOverride" IS NOT NULL;
```

不新增字段记录"换算计算器"当时输入的参考数量/参考单位（比如"100g"这个原始输入）——计算器只是帮你把系数算对、填进现有的 `factor` 框，本身不作为一份"还原公式"持久化。理由：避免为一个纯辅助工具引入新的持久状态和另一套"要不要跟 factor 保持同步"的问题；下次要改，重新用计算器按一遍就行，比维护两份真相简单。

---

## 2. 三处改动详细设计

### 2.1 基准单位单一入口

- `app/[locale]/classic/operator/products/[id]/page.tsx`：「可售单位」区块里，判定"是否基础"改成纯派生 `row.uomId === tmpl.uomId`，不再是可点的单选钮——是基础的那一行显示一个"基础"徽章、系数锁定显示 1；点击其他行不会再把"基础"转移过去。真要换基准单位，去页头「Unit of Measure」下拉框改。
- 页头「Unit of Measure」下拉框旁边加一句提示：如果已经配置了「可售单位」，换基准单位后各行系数是相对**旧基准**算的，不会自动换算，需要重新核对——这是主动加的一个提醒，不做阻塞性校验（校验"库存是否已有发生额"超出本次范围，现状本来就允许随时改）。
- `app/api/products/[id]/sale-uoms/route.ts`（PUT）：
  - 删除"把 `isDefault` 那行写回 `ProductTemplate.uomId`"的整段逻辑（现 `:59-73`）。
  - 改成读当前 `product.template.uomId`：如果非空，服务端**忽略**客户端传来的每行 `isDefault`，一律按 `item.uomId === template.uomId` 重新计算；如果提交的行里没有一行匹配这个基准单位，自动补一行（`factor=1, priceOverride=null`）一起存，不报错——用户没必要先手动把基准单位也加进列表才能保存其余行。
  - 如果 `product.template.uomId` 目前是空的（历史遗留、从未设置过），维持现状：按客户端提交的 `isDefault` 回填一次 `ProductTemplate.uomId`（老逻辑里"顺带修掉模板没设销售单位"的兜底价值还在，只是从"每次都覆盖"降级成"仅当前模板还没设过才补一次"）。
- `app/api/product-templates/route.ts`（POST，新建商品）：创建时同理，按提交的 `data.uomId`（页头选的）而不是 `saleUoms` 里的 `isDefault` 来决定谁是基础行，写法与上面一致（新建场景两者理论上应该一致，这里是保险，不是预期会分叉）。

### 2.2 采购单位跟着采购单走

- `app/api/purchase-orders/[id]/route.ts`，`targetStatus === 'CONFIRMED' && po.status !== 'CONFIRMED'` 分支（现有生成草稿账单的那段，约 `:412-423`）里追加：
  - 对 `po.lines` 里 `uomId` 非空的行，按 `productId` 去重（同一采购单里同一商品出现多行时，取最后一行的 `uomId`，這种情况本身就少见，没必要引入额外判断/报错）；
  - 查一遍这些 `productId` 对应的 `templateId`（`prisma.product.findMany`），把 `ProductTemplate.purchaseUomId` 更新成对应的 `uomId`；只更新确实变化的（`purchaseUomId !== 新值`才写，减少无意义的 `updatedAt` 刷新）。
  - 这段和生成账单一样是"确认采购"的副作用之一，不新增权限点，跟着现有 `purchase.order.approve` 走。

### 2.3 可售单位换算计算器

面向两种真实场景，做成同一个小工具的两个模式（点击换算系数输入框旁边一个"🔧 帮我算"按钮展开，不强制使用，手动直接填数字的老路径继续保留）：

**模式一·按重量**：适用于"一箱=6kg，拆成 100g 一份卖"这种。
- 输入：数量 + 单位（克/公斤）下拉。
- 前提：商品「其他信息」里的 `Net Weight` 必须先填了；没填时这个模式整体置灰，提示"请先在其他信息里填净重"。
- 计算：`factor = (此单位重量换算成公斤) / 商品净重(公斤)`，保留 6 位小数存库（`Decimal(14,6)` 精度足够，100g/6kg 这种算出来是 0.016667，不会因为小数位不够丢精度）；旁边同时显示一个人话版本"约等于 1 箱可以拆成 60.000 份"（`= 1 / factor`，保留 3 位小数，用户说的"保留小数点后 3 位"对应的是这个更好读的展示数，不是数据库里存的原始 factor）。
- 点"应用"把算出来的 factor 写进上面已有的系数输入框（还能再手动微调）。

**模式二·按已有可售单位的倍数**：适用于"一大袋=20小袋，要配 1 袋装/5袋装/10袋装"这种计数场景。
- 前提：这个商品已经有至少一行"最小可售单位"配置好了系数（比如先手动填一行"1 小袋 = 0.05 基础"——0.05 从哪来，是采购/仓库同事自己知道"一大袋 20 小袋"换算出来的，这一步维持现状手填，不额外做"请输入基准单位一共分成几份"这种一次性声明字段，避免为了省这一次手算，多加一个需要长期维护的数据）。
- 有了这一行之后，模式二 = 选择"参照哪一行" + 填倍数，算出 `factor = 倍数 × 参照行.factor`（比如参照"小袋"0.05，填 5，算出 0.25，对应"5袋装"）——这一步是这次真正省事的地方：不用再手算 5×0.05，尤其倍数一多(10、20)容易算错或按错方向（正好呼应截图里"头/盒"两行系数疑似都填成 1 这种一眼看得出算错了的情况）。
- 点"应用"同样写入系数框。

两种模式都只是"帮你把系数算对、填进已有输入框"的计算器，不改变 `ProductSaleUom` 的数据形状，落库的东西和现在手填一个数字完全一样。

### 2.4 价格公式面板

每一行（非基础行）的价格展示从单一输入框，改成"收起时显示一行结果摘要 + 点开可切三态"，模式参照 `pricelists/[id]/page.tsx` 那套 fixed/percentage/formula 单选交互：

- **自动（默认，对应现状"留空"）**：只读展示 `基准单价(tmpl.listPrice) × 系数 = 结果`，不能改数字，要改就换模式。
- **固定**：一个金额输入框，直接对应现有 `priceOverride`（老数据全部落在这一态，行为不变）。
- **公式（新增）**：只读展示"基准 × 系数 = X"这一步，下面照截图2的样子：`New Price = 上一步的 X − 折扣 [___]% + [___]`，两个数字输入框，改完实时算出并展示最终价格。对应新字段 `priceDiscountPct`/`priceSurcharge`。

`lib/sale-uom.ts` 改动：
- `SaleUomRow`/`SaleUomItemInput` 加 `priceMode/priceDiscountPct/priceSurcharge` 三个字段。
- `validateSaleUomItems` 加校验：`priceDiscountPct` 在 0–100 之间；`priceSurcharge` 在 −1,000,000–1,000,000 之间（允许负数，对应"再减一点"的场景，截图只画了加号，但没理由锁死不让减）。
- `priceOf()` 按 `priceMode` 分支计算：`FIXED` 用 `priceOverride`；`FORMULA` 按上面公式；`AUTO` 维持现状逐字不变（`priceOverride` 有值就用，否则 `基准×系数`）——这保证 5474 个从没配过多规格、以及所有存量已配置行的计算结果一个数字都不变。
- 下单页/报价单/订单详情页三处调用 `priceOf` 的地方（`orders/[id]/page.tsx`、`quotations/[id]/page.tsx`、`place-order/page.tsx`）不用改代码，只要它们读到的 `saleUoms` 数据里带上新的三个字段（GET 接口自然返回），函数内部行为自动生效。

---

## 3. 路由/文件清单

| 文件 | 改动 |
|---|---|
| `prisma/schema.prisma` | `ProductSaleUom` 新增 `priceMode`/`priceDiscountPct`/`priceSurcharge` + 新枚举 `SaleUomPriceMode` |
| 新迁移（手写 SQL，`db push` 方式应用） | 建枚举类型、加三列、按 `priceOverride` 是否有值回填存量行 `priceMode` |
| `lib/sale-uom.ts` | 新字段的类型、校验、`priceOf()` 三态计算逻辑 |
| `app/api/products/[id]/sale-uoms/route.ts` | 去掉写回 `ProductTemplate.uomId` 的逻辑，改成读它来派生 `isDefault`；接住价格公式三个新字段并落库 |
| `app/api/product-templates/route.ts` | 新建商品时，`isDefault` 同样按提交的 `data.uomId` 派生（保险对齐，非预期会分叉） |
| `app/api/purchase-orders/[id]/route.ts` | 「确认采购」时按行 `uomId` 回写商品 `purchaseUomId` |
| `app/[locale]/classic/operator/products/[id]/page.tsx` | 「可售单位」区块重做：基础行改为纯展示、加换算计算器（两种模式）、加价格公式面板（三态）；页头 Unit of Measure 旁加换基准单位的提示文案 |

---

## 4. 风险点

1. **换基准单位本身早就是能做的事，这次没有新增这个能力，只是把"能改它的地方"从两处收敛成一处**——但换了之后，商品当前库存 `qtyOnHand` 的计量单位含义会跟着变（原来按 A 单位计数的库存数字，换了基准后系统会当成按 B 单位计数），这是现状就有的行为，本次不额外加"已有库存/历史单据时禁止改基准单位"这类阻塞校验，只在 UI 上加一句提醒。如果客户希望更严格，需要另外提出。
2. **采购单位回写只影响以后新确认的采购单**，不做历史数据回填（用户已确认）；如果同一商品在不同供应商那里买的包装不一样，`purchaseUomId` 会随"最近一次确认的采购单"变来变去——这是"跟着采购单走"这个设计本身的自然结果，不是 bug。
3. **换算计算器不持久化输入过程**（只存最终算出的 `factor`），下次要改同一行需要重新走一遍计算器；这是主动的简化决定（见 §1 末尾），如果以后需要"记住这行是怎么算出来的"，属于另一个需求。
4. **`PurchaseOrderLine.uomId` 缺少正式外键关系**是发现的一个数据完整性小问题，与本次三个需求无关，不顺手修（避免打包无关变更），只记录在案。

---

## 5. 是否需要额外确认

以下是主动做出的设计选择（非又一轮征询），如无异议按此执行：

- 换算计算器"按倍数"模式要求先有一行手填的最小单位作为参照，不新增"基准单位一共分几份"这类额外持久字段——原因见 §2.3 末尾。
- 价格公式面板的"基准"固定是 `tmpl.listPrice`，不像 `pricelists` 那样给"Based on"下拉选择多种来源——因为可售单位场景里"基准"本来就只有一个含义（这个商品自己的门市价），不需要那个灵活度。
- 换基准单位不加阻塞性校验，只加提示文案——原因见风险点#1。

请回复"确认，开始开发"以进入实现；如需调整以上任一点，请直接指出。
