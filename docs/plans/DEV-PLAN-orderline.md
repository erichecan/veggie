# DEV-PLAN: OrderLine 表重构（方案 B）

**日期**: 2026-04-29
**类型**: BIG change（schema 迁移 + 跨多模块业务逻辑）
**目标**: 1:1 对齐 Odoo Sale Order 的数量流转 — Ordered → Delivered → Invoiced，并实现动态 Forecast Qty。

---

## 一、需求核心

客户截图里的 5 个数量列：

| 列 | 含义 | 数据来源 |
|---|---|---|
| Ordered Qty | 报价单填的数量 | OrderLine.orderedQty |
| Forecast Quantity | 预测库存（运行时计算） | qtyOnHand + 在途入库 - 未交货确认订单 |
| Quantity On Hand | 仓库实物数量 | Product.qtyOnHand（已存在） |
| Delivered Quantity | 司机送达数量 | OrderLine.deliveredQty |
| Invoiced Quantity | 开票数量 | OrderLine.invoicedQty |

业务规则：
- Quotation 保存即生成订单号 D146145（已实现）
- 确认 → 扣减 qtyOnHand 作为预留（已实现）
- 司机送完货 → Trip.delivered=true → 回写 OrderLine.deliveredQty = orderedQty（待实现）
- 部分送达场景：Trip 完成时手填实际送达数量 → 写入 deliveredQty（待实现）
- 生成发票时：lines.qty 取 deliveredQty 而不是 orderedQty → 写 OrderLine.invoicedQty

---

## 二、Schema 变更

### 新增模型 `OrderLine`

```prisma
model OrderLine {
  id           String   @id @default(cuid())
  orderId      String
  order        Order    @relation(fields: [orderId], references: [id], onDelete: Cascade)
  productId    String
  product      Product? @relation(fields: [productId], references: [id])
  productName  String   // 快照
  spec         String?  // 快照
  uomId        String?
  uomName      String?
  unitPrice    Decimal  @db.Decimal(12, 2)
  taxRate      Decimal? @db.Decimal(6, 4)
  orderedQty   Decimal  @db.Decimal(14, 3)
  deliveredQty Decimal  @default(0) @db.Decimal(14, 3)
  invoicedQty  Decimal  @default(0) @db.Decimal(14, 3)
  subtotal     Decimal  @db.Decimal(12, 2) // unitPrice × orderedQty 快照
  sequence     Int      @default(0)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([orderId])
  @@index([productId])
}
```

### `Order.items` 处理

- **保留** `Order.items` JSON 字段不删（向后兼容历史订单 + 简化只读场景）
- 新订单：双写 OrderLine + 同步更新 items JSON 的 deliveredQty/invoicedQty 字段
- 历史订单：写一次性迁移脚本回填 OrderLine

---

## 三、迁移与数据回填

1. 手写 SQL 迁移文件 `prisma/migrations/<ts>_add_order_line/migration.sql`
2. 执行 `prisma migrate resolve --applied`
3. 数据回填脚本 `prisma/migrations-scripts/backfill-order-lines.ts`：
   - 遍历所有 Order，把 items JSON 转写为 OrderLine 行
   - 状态 = COMPLETED 的订单：deliveredQty = orderedQty, invoicedQty = orderedQty（按现有发票判断）
   - 状态 = IN_DELIVERY 的订单：deliveredQty = 0, invoicedQty = 0
   - 状态 ≤ CONFIRMED 的订单：deliveredQty = 0, invoicedQty = 0

---

## 四、API 改动清单

| 文件 | 改动 |
|---|---|
| `app/api/orders/route.ts` | POST 创建时双写 OrderLine；GET 列表 include OrderLine |
| `app/api/orders/[id]/route.ts` | PATCH 时同步更新 OrderLine；CONFIRMED 流程里读 OrderLine 替代 items |
| `app/api/orders/bulk/route.ts` | mass_edit 不涉及 line，无需改 |
| `app/api/trips/[id]/route.ts` | **新增** Trip.delivered=true 时遍历 orderIds 把 OrderLine.deliveredQty = orderedQty 回写 |
| `app/api/invoices/route.ts` | POST 创建时取 OrderLine.deliveredQty 写 invoicedQty 回写 |
| `app/api/products/forecast/route.ts` | **新增** GET 返回 `{ productId, qtyOnHand, inboundPending, outboundReserved, forecast }` |

---

## 五、UI 改动清单

| 页面 | 改动 |
|---|---|
| `/operator/orders/[id]` | 商品明细表加 5 个量列：Ordered / Forecast / On Hand / Delivered / Invoiced |
| `/operator/orders/[id]` | "已交货 0.00" 写死改成读 OrderLine.deliveredQty |
| `/classic/operator/place-order` | 写入时直接生成 OrderLine 而非塞 JSON（双写期间两边都写） |
| `/operator/trips/[id]` | 司机标记送达时新增"实际送达数量"输入（默认 = orderedQty，可改） |
| `/operator/invoices/[id]` | 发票明细取 invoicedQty 而非 orderedQty |
| `lib/types.ts` | 新增 `OrderLine` 类型，`Order` 加 `lines: OrderLine[]` |

---

## 六、Forecast Qty 公式

```
forecast = qtyOnHand
         + Σ PurchaseOrderLine.orderedQty - Σ PurchaseOrderLine.receivedQty   // 在途采购
         - Σ OrderLine.orderedQty + Σ OrderLine.deliveredQty                  // 在途销售（已确认未交货）
where Order.status ∈ {CONFIRMED, WAVE_ASSIGNED, IN_DELIVERY}
```

性能：每个商品独立计算，O(n)；列表场景走批量端点 `/api/products/forecast?ids=a,b,c`。

---

## 七、性能与边界

- **N+1 风险**：列表页拉 OrderLine 必须 `include` 进 Order 查询，禁止 line 内逐行查 Product
- **分页**：单订单 line 数通常 ≤ 20，不需要分页
- **Forecast 缓存**：热点商品场景下后续可加 Redis；当前 demo 阶段直接现算
- **种子数据**：seed-orders-stock.ts 改成同时写 OrderLine（150 单 × 平均 3 行 ≈ 450 行）

---

## 八、文件清单（按改动顺序）

1. `prisma/schema.prisma` — 加 OrderLine model + Product/Order 反向关系
2. `prisma/migrations/<ts>_add_order_line/migration.sql` — 手写
3. `prisma/migrations-scripts/backfill-order-lines.ts` — 一次性回填
4. `lib/types.ts` — 加类型
5. `app/api/orders/route.ts` — 双写
6. `app/api/orders/[id]/route.ts` — 双写 + 修预留逻辑
7. `app/api/products/forecast/route.ts` — 新增
8. `app/api/trips/[id]/route.ts` — Trip 完成回写 deliveredQty
9. `app/api/invoices/route.ts` — 取 deliveredQty 写 invoicedQty
10. `app/[locale]/operator/orders/[id]/page.tsx` — 表格加 5 列
11. `app/[locale]/operator/trips/[id]/page.tsx` — 配送数量编辑
12. `app/[locale]/classic/operator/place-order/page.tsx` — 写 line
13. `app/[locale]/classic/operator/quotations/page.tsx` — 列表显示 OrderLine 汇总（可选）
14. `prisma/seed-orders-stock.ts` — seed 时写 OrderLine
15. `prisma/seed.ts` — 触发 backfill（idempotent）

---

## 九、风险点

- ⚠️ 共享 Neon DB（WMS/TMS 同库）— 加 OrderLine 不影响其他业务，但迁移命令必须按 CLAUDE.md 用 `migrate resolve` 而非 `migrate dev`
- ⚠️ 双写期间数据一致性 — items JSON 与 OrderLine 表双向同步，需在 PATCH 路由里做事务
- ⚠️ Trip 完成回写依赖 Trip 现有的 `restaurants[].orderIds` 数组结构 — 需先验证生产数据这字段都填了

---

## 十、验收标准

完成后必须能演示：

1. 新建 quotation D146xxx，包含 3 行商品 → DB 有 3 条 OrderLine，deliveredQty=0
2. 确认订单 → qtyOnHand 扣减 + Forecast Qty 立即变小
3. 司机标记送达 → OrderLine.deliveredQty = orderedQty + Forecast Qty 复原
4. 生成发票 → OrderLine.invoicedQty = deliveredQty + 发票明细数量来自 deliveredQty
5. 订单详情页 5 列实时显示，全部非 0/非写死
6. 部分送达场景：司机修改 Trip 中某行送达数量为 0.5 × ordered → OrderLine.deliveredQty = 0.5 × orderedQty + 发票数量按 0.5 算

---

## 十一、估时

- Schema + 迁移 + 回填：~1 小时
- 后端 API（5 个文件）：~2 小时
- 前端页面（5 个页面）：~2 小时
- 测试 + 部署：~1 小时
- **总计 ~6 小时**
