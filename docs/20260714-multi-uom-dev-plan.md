# 商品多计量单位销售 — 开发评估方案

## 1. 目标

客户需求：同一个商品既能按"大单位"(如箱 CASE)销售,也能按"小单位"(如瓶/个 PCS)销售,系统自动换算数量、价格、库存扣减,不需要为同一款货维护两条独立商品记录。

已和你确认的两个方向：
- **建模方式**：一个 Product 挂多个可售单位,共享同一份库存池(而非现状"方法一"那样两条商品记录各自独立库存)。
- **落地范围**：先选 2-3 个具体商品试点,验证流程跑通后再考虑全量推广。

## 2. 现状(已核实,不是推测)

- `prisma/schema.prisma:275-280` — `ProductTemplate` 只有一个 `uomId`(销售单位)。
- `Uom` 模型(`prisma/schema.prisma:425-447`)已有 `factor` 换算系数机制,同一 `UomCategory` 内的单位可以互相换算(如 PCS factor=1 是基准, CASE factor=12)。**这套机制现成可以复用**，不需要另起一套换算逻辑。
- `OrderLine` 已有 `uomId`/`uomName` 字段(`prisma/schema.prisma:606-607`),但下单时固定复制商品当前设置的单位,下单页(`place-order/page.tsx:681-733`)没有切换单位的入口。
- `docs/technical/ODOO-REPLICATION-PLAN.md` 里早年设计过 `BomLine`/`BillOfMaterials` 接口(166-180行、793行),但从未落地——全仓库无对应 schema/API/页面实现，只是搁置的设计稿。

## 3. 推荐数据模型改动

新增一张"商品可售单位"关联表,复用现有 `Uom.factor`，不重复造轮子：

```prisma
model ProductSaleUom {
  id            String   @id @default(cuid())
  productId     String
  product       Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  uomId         String
  uom           Uom      @relation(fields: [uomId], references: [id])
  isDefault     Boolean  @default(false)   // 下单页默认选中的单位
  priceOverride Decimal? @db.Decimal(12,2) // 这个单位的独立售价；不填则按"基准单价 × factor"自动算
  active        Boolean  @default(true)
  createdAt     DateTime @default(now())

  @@unique([productId, uomId])
  @@index([productId])
}
```

关键设计决策：**库存 `Product.qtyOnHand` 统一按该商品所属 `UomCategory` 的"基准单位"(factor=1)计数**，所有可售单位下单时都换算成基准单位数量再扣库存，不管你用箱还是用个下单，最终动的是同一份库存数字。

## 4. 后端改动点(按优先级、已定位到具体行号)

| 优先级 | 文件 | 现状问题 | 需要的改动 |
|---|---|---|---|
| 🔴 最高 | `lib/inventory.ts:30,55`(`consumeLotsFIFO`/`restoreLotsFIFO`) | 直接拿 `orderedQty` 扣/补库存批次，**零换算**，调用点遍布 `orders/[id]`、`orders/bulk`、`order-discrepancies`、`stock-takes`、`trips/[id]/returns` 共 7+ 处 | 扣减前按 `qty_in_ref = orderedQty × uom.factor` 换算成基准单位，否则用箱下单只扣 1 份货却发 12 份 |
| 🟠 高 | `lib/commission.ts:54-81`(`sumCommission`) | `commissionPrice × qty` 简单乘法，`commissionPrice` 隐含"按当前唯一单位定义" | 需要你先拍板：提成单价按哪个单位定义(建议按基准单位定义，其他单位换算后再乘) |
| 🟠 高 | `lib/print/trip-picking-template.ts:79-107` | 拣货单按 `productId` 聚合，同商品不同单位的行会被错误合并成一个数字("3箱+5个"→"8箱"或"8个"，取决于哪行先入 Map) | 聚合 key 改成 `productId+uomId`，分单位小计展示，或统一换算成基准单位后再合并 |
| 🟡 中 | `app/api/analytics/margin/route.ts:59-78`、`app/api/analytics/procurement/route.ts:61,66` | `SUM(orderedQty) GROUP BY productId`，不区分单位，销量/毛利/采购满足率会被"箱"和"个"混算失真 | 汇总前换算成基准单位再 SUM |
| 🟡 中 | `lib/pricing-engine.ts:44,67,228-258` + `CustomerSpecialPrice.minQty` | 价格阶梯("满 N 件享价")纯数字比较，不挂单位 | 需要你拍板：`minQty` 按哪个单位计数，混用单位下单会不会绕过阶梯价 |
| 🟢 低 | `lib/order-items.ts` | 逐行映射，天然对多单位无感 | 基本不用改 |

## 5. 前端改动点

- 商品编辑页(`app/[locale]/classic/operator/products/[id]/page.tsx:439-473`)：现在只有 `uomId`/`purchaseUomId` 两个单选下拉，需要加一个"可售单位"多选/列表管理区块(选单位、设默认、可选独立定价)。
- 下单页(`place-order/page.tsx:681-733,914-915`)：现在选中商品直接写死 `product.uomId`，需要在商品选中后加一个单位下拉(只列该商品配置过的可售单位)，切换后自动重算单价(除非该单位设了 `priceOverride`)。

## 6. 需要你先拍板的两个业务定义(会直接决定计算逻辑对不对)

1. **提成单价按哪个单位算？** 比如某商品基准单位是"个"，提成单价 €0.10/个；用户如果下单选"箱"(1箱=12个)，提成是自动按 €1.20/箱算，还是有一个单独的"箱"提成价？
2. **价格阶梯(满 N 件享价)按哪个单位计数？** 客户用"箱"下单 5 箱(=60个)算不算触发"满 50 件优惠价"？

## 7. 试点商品

需要你给 2-3 个具体商品名(最好是那种确实有"整箱走货 + 偶尔拆零卖"真实场景的)，先在这几个商品上把 schema、下单页单位切换、库存扣减跑通，再评估要不要推广。

## 8. 建议执行顺序

1. schema 加 `ProductSaleUom` 表 + migration
2. `lib/inventory.ts` 换算逻辑(最高优先级，不改这个库存会错)
3. 商品编辑页加"可售单位"配置区块
4. 下单页加单位切换 + 自动重算单价
5. 拣货单聚合 key 按 `productId+uomId` 拆分
6. analytics 汇总口径换算
7. 提成/价格阶梯按第 6 节拍板结果实现
