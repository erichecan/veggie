# DEV-PLAN：订单调整行体系 —— 折扣/差价调整/配送费 + 赠品标记

## 读取的文档

无独立 PRD。需求来自本次对话：排查"拣货单商品分表看 Product.type 还是销售单位"问题时，
在生产库里发现 `price difference`（26 单）、`Small Offer Set`（75 单）、`Discount`（2 单）、
`Deliver Service`（3 单）四个"假商品"，经代码调研确认——系统对差价调整/折扣/配送费三类
需求**完全没有正式承接点**，业务只能靠新建一个虚构商品塞进订单行来实现，产出记录见
`docs/20260913-consu-missing-uom-checklist.md`。用户已确认"四个都要，一次性出完整方案"。

## 问题核实（代码调研结论）

- **差价调整**：`OrderLine` 只有 `unitPrice/subtotal/priceSourceType`（PRICELIST/DEFAULT/
  LAST/SPECIAL/MANUAL）这套价格溯源，没有"调价行"概念。
- **折扣**：`ProductSaleUom.priceDiscountPct` 是价格表 FORMULA 定价规则的一部分，跟下单时
  临时打折是两回事。系统确有正式的"手动改价"通道（`sales.order.override_price` 权限 +
  `resolveOrderLines(overrides.allowManualPrice)`，`app/api/orders/route.ts:268`），但只能
  改**某一真实商品行自己的单价**，没有"整单减免"或"独立折扣行"的概念。
- **配送费**：`Order`/`DriverSlot`/`Trip` 都没有 deliveryFee 字段，`lib/commission.ts` 只算
  商品提成不算运费。
- **促销赠品套装**：`Product` 没有 isBundle/组合明细表，`Pricelist` 只支持单品定价规则，不
  支持"买 A 送 B"或套装价；`OrderLine.note`（`schema.prisma:844` 注释提到"如 free 赠品"）
  是唯一沾边的字段，但那是给**真实单品**打免费标记，业务显然没在用它，才会去建假商品。

## 设计方案与理由

**不做**一个独立的 Bundle/组合商品目录系统——那是四个需求里唯一"新增一类商品概念"的做法，
复杂度和风险都远高于其余三个，而实际业务场景（赠品、打包优惠）用现有"真实商品行"就能表达：

- **赠品** = 真实商品行 + `unitPrice=0`/`isGift=true` 标记，该商品仍会正确扣库存、正确显示在
  拣货单，只是不计入销售额和提成——这比发明"套装商品"更贴近物理事实（仓库拣的是真货，不是
  一个叫"Small Offer Set"的抽象商品）。
- **套装打包优惠** = 各真实商品各自成行 + 一条"折扣"调整行体现整单让利，不需要新建目录。

三个真正缺失的能力（差价、折扣、配送费）共性是"订单需要一笔不对应任何库存商品、可正可负的
金额调整"，因此统一设计成一张新表 **OrderAdjustment**，而不是三套各自的字段/表：

```prisma
enum OrderAdjustmentType {
  DISCOUNT          // 折扣/让利，通常为负
  DELIVERY_FEE      // 配送费，通常为正
  PRICE_CORRECTION  // 补差价/价格修正，可正可负
  OTHER
}

model OrderAdjustment {
  id          String              @id @default(cuid())
  orderId     String
  order       Order               @relation(fields: [orderId], references: [id], onDelete: Cascade)
  type        OrderAdjustmentType
  label       String              // 展示用说明，如"9月促销折扣"/"退货补差价"
  amount      Decimal             @db.Decimal(12, 2)
  note        String?
  createdById String
  createdBy   User                @relation(fields: [createdById], references: [id])
  createdAt   DateTime            @default(now())
  @@index([orderId])
}
```

`OrderLine` 加一个字段：

```prisma
  isGift Boolean @default(false)  // true 时该行不计入销售额/提成基数，仍正常走库存扣减与拣货单
```

（不复用 `note` 文本约定——note 是自由备注，拿它做统计过滤等于拿注释当数据源，`isGift` 才是
"显式优于聪明"该有的样子。）

**`Order.totalAmount` 语义不变，保持只等于商品行合计**（这是 `sales-accounting-tax-convention`
既有 SSOT——税前商品额，`taxRate`/`orderIncTaxTotal` 等派生量全建立在这个不变量上，改了会牵一
发动全身）。发票/结算/司机对账等"客户实际应付/应收金额"的场景，改为读
`totalAmount + Σ(OrderAdjustment.amount)`（新增一个 `lib/order-adjustments.ts` 里的
`getOrderPayableTotal(orderId)` 辅助函数统一计算，不允许每个消费端各自手写加总）。

**提成（`lib/commission.ts`）与商品维度分析（毛利/透视）不需要改动**——两者都基于
`OrderLine`，`OrderAdjustment` 是独立表，天然不会被算进去；`isGift=true` 的行需要在
`lib/commission.ts` 和 `lib/analytics/metrics.ts` 里加一行"排除 isGift 行"的判断（这是唯一
需要动这两个文件的地方）。

**拣货单/司机打印**：`OrderAdjustment` 独立于 `OrderLine`，不会出现在
`lib/print/trip-picking-template.ts` 的商品聚合里，无需改动；但发票/账单类打印模板
（如有）需要补一段展示调整行明细。

## 模块拆解

1. **Schema**：新增 `OrderAdjustment` 模型 + `OrderAdjustmentType` 枚举；`OrderLine` 加
   `isGift Boolean @default(false)`；迁移文件。
2. **计算层**：新建 `lib/order-adjustments.ts`——`getOrderPayableTotal()`、
   `listAdjustments()`、`createAdjustment()`、`deleteAdjustment()`，所有对 Order 应付金额的
   读取统一走这里，不允许 API 路由内联加总逻辑。
3. **权限**：新增权限点 `sales.order.manage_adjustment`（按现有 RBAC 流程：`role-access` +
   `middleware/route-map.ts` 注册 + `scripts/sync-sortkeys.ts` + 幂等迁移 + `permVersion`
   bump，见 memory `new-protected-api-route-needs-route-map-registration`）。是否需要按
   `type` 再拆细粒度权限（比如折扣需要经理审批、差价不需要）——**见下方"需要确认"**。
4. **API**：`app/api/orders/[id]/adjustments/route.ts`（POST 新增/GET 列出）、
   `app/api/orders/[id]/adjustments/[adjustmentId]/route.ts`（DELETE），走
   `assertOrderNotPickLockedForLineEdit` 同款拣货锁校验（调整金额本质也是订单内容变更）。
   `OrderLine` 的 PATCH 接口加 `isGift` 字段透传（连带 `unitPrice` 校验：`isGift=true` 时
   强制 `unitPrice=0`，不允许"又是赠品又收钱"的矛盾状态）。
5. **下单页/订单详情页 UI**：
   - 商品行加"标为赠品"勾选（勾选后单价锁定为 0、行内 UI 提示"赠品，不计入销售额/提成"）。
   - 新增"调整"面板：类型下拉（折扣/配送费/差价调整/其他）+ 说明文字 + 金额（可正可负）+
     增/删列表；应付合计单独一行显示 `商品小计 + 调整合计 = 实际应收`。
6. **发票/结算/司机对账等下游读取点**：梳理所有当前直接读 `order.totalAmount` 当"客户应付
   金额"用的地方（发票生成、Trip 结算、Statement），改为调用 `getOrderPayableTotal()`；
   **单纯统计销售额/毛利/提成的地方维持读 `totalAmount`/`OrderLine`，不改**——这两类消费端
   要在实现时逐个标注清楚，避免混用出错。
7. **存量四个假商品**：不迁移历史订单数据（106 笔历史假商品订单行保持原样，本次不追溯）；
   新机制上线后把 `price difference`/`Small Offer Set`/`Discount`/`Deliver Service` 四个
   `Product.active` 置为 `false`，防止上线后业务还习惯性地继续用旧方式下单。
8. **测试**：`OrderAdjustment` CRUD 单测；`getOrderPayableTotal` 含"无调整/多条调整/正负混合"
   用例；`isGift` 行不计入 commission/analytics 的回归测试；权限点 403/401 测试
   （`api-auth-templates` 清单）。

## 路由/文件清单

- `prisma/schema.prisma` + 新迁移（`OrderAdjustment` 模型、`OrderLine.isGift`）
- `lib/order-adjustments.ts`（新建）
- `app/api/orders/[id]/adjustments/route.ts`（新建）
- `app/api/orders/[id]/adjustments/[adjustmentId]/route.ts`（新建）
- `app/api/orders/[id]/lines/[lineId]/route.ts`（加 `isGift` 透传与校验）
- `lib/commission.ts`（排除 `isGift` 行）
- `lib/analytics/metrics.ts`（排除 `isGift` 行）
- 发票/结算/司机对账相关路由与模板（具体清单需先梳理"谁在读 totalAmount 当应付金额"，
  开发时第一步产出，不在此处先猜）
- 下单页/订单详情页对应前端组件（`app/[locale]/classic/**/orders/**`）
- `middleware`/`route-map.ts` + `scripts/sync-sortkeys.ts`（新权限点登记）
- 测试文件（`tests/order-adjustments.test.ts` 等，新建）

## 风险点

1. **发票/结算消费端清单需要先枚举，遗漏一处就会导致对账不平**——这是本计划影响面最大的
   不确定项，开发第一步就要做，不能等实现到一半才发现漏改。
2. **会计口径需要人工拍板，不能由开发自行决定**（见下方"需要确认"）：配送费/折扣算不算进
   销售额和毛利统计？提成基数要不要扣掉折扣？这些决定会实际改变客户看到的报表数字，做错了
   等同于之前分析中心那次"CONFIRMED 双重扣减"级别的数字失真事故。
3. **isGift 与手动改价（`sales.order.override_price`）两条路径并存，容易被绕过**——如果销售
   员不用"标为赠品"而是直接手动改价成 0，效果一样能免单，但不会被 `isGift` 统计口径排除，
   commission/analytics 会把它当正常低价单算——这不是本计划能堵死的漏洞，只能在文档/培训层
   说明"免单一律用赠品勾选，不要手动改价成 0"。
4. **权限粒度**：`sales.order.manage_adjustment` 目前设计成单一权限点管四种类型，如果客户
   要求"折扣需要经理审批、差价不需要"这类差异化管控，需要拆细（对照
   `decorative-permission-points` 的教训——拆权限点必须同步补给原本够用的角色，否则会造成
   静默功能中断）。

## 需要确认（停下等回复，不属于"能自己判断的细节"）

1. **配送费/折扣是否计入销售额与毛利统计？** 默认方案是"不计入"（`OrderAdjustment` 独立于
   `OrderLine`，天然不影响 `totalAmount`/毛利口径），只影响客户应付总额。如果客户希望运费单
   独算一笔"其他收入"科目体现在财务报表里，需要另外设计，不在本计划范围内。
2. **提成基数要不要扣掉折扣？** 默认方案是"不扣"（提成走 `lib/commission.ts` 现有 `OrderLine`
   逻辑，`OrderAdjustment` 不参与）。如果折扣应该冲减对应商品行的提成基数，需要在
   `commission.ts` 里加关联逻辑（比如折扣行可选择关联到具体订单，而不只是整单）。
3. **是否需要按调整类型做差异化审批权限？**（如折扣需经理审批、差价不需要）默认方案是单一
   权限点 `sales.order.manage_adjustment` 覆盖全部四种类型。
4. **历史 106 笔假商品订单行是否需要一次性迁移成 OrderAdjustment 记录？** 默认方案是不迁移，
   只保证以后新单不再产生假商品行；历史报表数字维持现状不追溯修正。

技术栈沿用项目默认（Next.js/Prisma/PostgreSQL/本地开发库），无需再问。
