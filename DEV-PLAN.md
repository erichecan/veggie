# DEV-PLAN：商品可售单位装货顺序（UoM Sequence）—— 拣货/卸货堆叠顺序

## 读取的文档

无独立 PRD。需求来自本次对话确认：仓库配货 / 司机卸货时，重的商品要放最下面、轻的不放最下面、怕压的放最上面；商品用了多单位销售（UoM）的话，基础单位和每个可售单位都要能单独设置。

⚠️ **设计经过一次推翻，这里记录最终定案**：第一版按对话讨论定成"分层"（BOTTOM/NORMAL/TOP 三档枚举），已经实现、验证、部署到本地开发库。客户随后明确表态：**还是要纯数字 sequence**（跟 `Product.sequence` 语义一致的可编辑整数），只是要求在可售单位（`ProductSaleUom`）这一级也各自有一个值，不要枚举下拉。本文档描述的是**这一版**——数字方案；分层版已被完全替换（迁移 `20260907000001` 加的字段被 `20260907000002` 撤掉重建，没有保留双轨）。

最终确认的两点设计：

1. **纯数字**，语义/校验逐字照抄 `Product.sequence`：可编辑整数，可空，**不做唯一性/重复校验**——同一个数字可以有很多商品共用，不需要处理冲突。数字越小越先装/放最下（重、耐压），越大越后装/放最上（轻、怕压）。
2. **粒度**：基础单位 + 每个可售单位（`ProductSaleUom` 每一行）都要能单独设置，不是只设基础单位、其它单位继承。

## 现状核实（复用性检查）

- **`Product.sequence`（已存在）不是本次要动的字段，也不能直接拿来用**：它是"该商品在打印单据/商品目录里排第几行"（`lib/print/line-sort.ts` 注释：2026-08-18 客户要求，Odoo 的目录/拣货顺序），已经接入全部打印单据（`lib/print/trip-picking-template.ts`、`dispatch-loader.ts`、`invoices/[id]`）和商品列表页排序。它是**单个数字挂在 Product 上**，语义是"单据里第几行"，跟本次要的"物理上放第几层"是两个维度，会同时存在、互不覆盖、互不合并。
- 这个字段的真实数据也是本次"不做唯一性校验"这个决定的直接依据：`line-sort.ts` 注释记录生产实测——132,847 张多行订单里 77.5% 所有行 sequence 相同（排了等于没排），18.4% 的订单行干脆没有值。客户明确表示接受这个现状（"客户需要的就是这个"），所以新字段照抄它的语义，不额外加防重复机制。
- **基础单位本来就是 `ProductSaleUom` 里 `isDefault=true`（factor=1）的那一行**，不是 `Product` 上的独立字段。所以"基础单位 + 每个可售单位都要设置"只需要在 `ProductSaleUom` 一张表上加字段，不用在 `Product` 和 `ProductSaleUom` 两处重复。
- 拣货/卸货相关的现有页面和数据流：
  - **打印路径**（司机拣货单 `print/trip/[id]/picking`、调度拣货单 `print/dispatch/picking`）：都走 `lib/print/dispatch-loader.ts` / `lib/print/trip-loader.ts` 取数 → `lib/print/trip-picking-template.ts` 渲染，行上有真实的 `productId`+`uomId`（来自 `OrderLine`），已有 `fetchProductSequences` + `sortLinesBySequence` 的排序范式可以照抄。
  - **网页拣货单/托盘**（`/api/waves/[id]/pick-sheet`、`/api/waves/[id]/pallets`）：数据来自 `Pallet.items` JSON 快照，字段是 `productId` + `uomName`（字符串），**没有 `uomId`**。按单位精确取 sequence 时只能用 `productId + uomName` 反查 `ProductSaleUom`，理论上存在同商品下单位重名的碰撞风险（业务上目前不会出现，可接受）。

## Schema 设计

```prisma
model ProductSaleUom {
  // ...现有字段不变
  /// 装货顺序：仓库配货/司机卸货用。数字越小越先装/放最下（重、耐压），
  /// 越大越后装/放最上（轻、怕压）。与 Product.sequence（单据里排第几行）
  /// 是两个独立维度，互不覆盖。语义/校验逐字照抄 Product.sequence：可空、
  /// 不做唯一性校验，允许大量商品共用同一个数字。
  sequence Int?
}
```

- 可空、无默认值——跟 `Product.sequence` 一致，不强制每条历史数据都补值，未设置的排序时按"没有"处理（排最后）。
- 不加唯一约束、不加索引——重复是设计目标，不是异常。

## 模块拆解

1. **数据层**：`prisma/schema.prisma` 加字段 + 迁移。
2. **商品编辑页录入**：`app/[locale]/classic/operator/products/[id]/page.tsx` 的可售单位表格，每行加一个"装货顺序"数字输入框（跟页头 Product Sequence 同款 `NumericInput`），随现有整份保存流程（`PUT /api/products/[id]/sale-uoms`）一起提交，不新增接口。
3. **API 透传**：`app/api/products/[id]/sale-uoms/route.ts`（GET/PUT）、`lib/sale-uom.ts`（`SaleUomItemInput` 类型）。
4. **拣货/卸货单据接入排序**（本轮范围）：
   - `lib/print/uom-sequence.ts`（新建，仿 `product-sequence.ts`）：按 `productId+uomId` 精确查；`lib/print/line-sort.ts` 新增 `sortLinesByUomSequence`，先按装货顺序排，同值/都没有时再按现有商品 sequence→商品名排（二级键，不改现有行为）。
   - `lib/print/trip-picking-template.ts`（司机/调度打印拣货单）接入。同一商品多单位混装成一组时，取数字更大的那个（更保守，偏向"当怕压处理"）。
   - `app/api/waves/[id]/pick-sheet/route.ts`（网页拣货单）—— 按 `productId+uomName` 反查装货顺序后排序 `pallet.items`。
   - `app/api/waves/[id]/pallets/route.ts` 的已入盘托盘明细 —— 同上；待分盘池维持按餐馆/商品名排序不变（那是"找货"用途，不是装车顺序）。
5. **暂不覆盖**：`dispatch-summary-pdf` 等未确认包含逐品明细的打印路由，先不动；如果打印出来客户觉得也要按顺序排，复用第 4 步同一套工具函数二次接入即可，不算大改。

## 路由/文件清单

- `prisma/schema.prisma` + 迁移（`20260907000001` 加分层字段 → `20260907000002` 撤掉重建为数字字段，两条迁移都保留，不改写已应用的历史）
- `lib/sale-uom.ts`
- `app/api/products/[id]/sale-uoms/route.ts`
- `app/[locale]/classic/operator/products/[id]/page.tsx`
- `lib/print/uom-sequence.ts`（新建）
- `lib/print/line-sort.ts`
- `lib/print/dispatch-loader.ts` / `lib/print/trip-loader.ts` / `lib/print/trip-common.ts`
- `lib/print/trip-picking-template.ts`
- `app/api/waves/[id]/pick-sheet/route.ts`
- `app/api/waves/[id]/pallets/route.ts`

## 风险点

1. **不做防重复/唯一性校验**是客户明确要的行为，等同 `Product.sequence` 现状（77.5% 订单行 sequence 相同、18.4% 缺失）——后续如果同一批商品的装货顺序全填一样的数字，排序会退化成"没排"，这是已知、被接受的权衡，不是 bug。
2. **`Product.sequence`（单据行序）与新的 `ProductSaleUom.sequence`（装货顺序）会同时存在**，两者互不影响、互不合并，命名相似容易混淆，代码里已用完整变量名（`productSequence` / `uomSequence`）区分。
3. **网页拣货单/托盘明细按 `uomName` 字符串反查单位**（因为 `Pallet.items` 快照没存 `uomId`），理论上有重名碰撞风险，实测目前业务里不会撞名，本轮按可接受处理，不改动 `Pallet.items` 的数据结构。
