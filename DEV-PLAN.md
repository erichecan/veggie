# DEV-PLAN：P0 + P1 功能实现计划

> 参考文档：`BUSINESS-FLOW.md`、`Veggie-业务流程文档.html`、`prisma/schema.prisma`
> 生成日期：2026-05-21

---

# 追加计划：批号/批次 + 保质期管理

> 来源：2026-05-22 会议 #10
> 追加日期：2026-05-28

---

## 功能范围

1. **Lot（批次）数据模型** — 新建 `Lot` 表，记录批号、商品、保质期（bestBefore）、生产日期等
2. **收货时创建批次** — GoodsReceipt 收货流程中，每个收货行可指定批号（手动输入/扫码）或自动生成
3. **StockMove 关联批次** — StockMove 新增 `lotId` 字段，每条库存变动追踪到具体批次
4. **临期商品看板告警** — 在库存看板（warehouse 页面）展示临期商品警告卡片
5. **批次库存查询 API** — 支持按批次查看库存余量和保质期状态
6. **PurchaseOrderLine.bestBefore 传递** — 采购订单行的 bestBefore 自动传递到收货创建的 Lot

---

## 数据库 Schema 变更

### 新增 Lot 模型

```prisma
model Lot {
  id          String    @id @default(cuid())
  name        String    // 批号：LOT-20260528-001 或手动输入
  productId   String
  product     Product   @relation(fields: [productId], references: [id])
  bestBefore  DateTime? // 保质期/最佳食用日期
  producedAt  DateTime? // 生产日期（可选）
  qtyOnHand   Decimal   @default(0) @db.Decimal(14, 3)
  sourceType  String?   // 来源：GOODS_RECEIPT / MANUAL
  sourceId    String?
  sourceRef   String?
  note        String?
  createdAt   DateTime  @default(now())
  stockMoves  StockMove[]

  @@unique([name, productId])
  @@index([productId])
  @@index([bestBefore])
}
```

### 修改 StockMove — 新增 lotId
### 修改 Product — 新增 lots 关联

---

## 模块拆解（按开发顺序）

| # | 模块 | 内容 |
|---|------|------|
| 1 | Schema + 迁移 | 新增 Lot 模型，StockMove 加 lotId，执行迁移 |
| 2 | 批次 CRUD API | `GET/POST /api/lots`，`GET /api/lots/expiring` |
| 3 | 收货流程改造 | goods-receipts POST 自动创建 Lot，传递 bestBefore |
| 4 | 其他变动关联批次 | stock-moves POST 支持 lotId，出库/报废/退货可选批次 |
| 5 | 临期告警看板 | warehouse 页面新增临期告警卡片 |
| 6 | 批次详情 UI | adjustments 页面显示批号，商品详情页增加批次 tab |

---

## API 路由清单

| 路由 | 方法 | 说明 | 新增/修改 |
|------|------|------|-----------|
| `/api/lots` | GET | 批次列表（支持 productId 筛选、临期过滤） | 新增 |
| `/api/lots` | POST | 手动创建批次 | 新增 |
| `/api/lots/expiring` | GET | 临期批次查询（未来 N 天到期 + 已过期） | 新增 |
| `/api/goods-receipts` | POST | 收货时自动创建 Lot | 修改 |
| `/api/stock-moves` | POST | 支持 lotId 参数 | 修改 |
| warehouse 页面 | - | 临期告警卡片 | 修改 |
| inventory/adjustments | - | 显示批号列 | 修改 |

---

## 风险点

1. GoodsReceipt.lines 是 JSON 字段，无法 Prisma relation 直接关联 Lot，需业务层处理
2. 现有 StockMove 数据 lotId 为 null，兼容无影响
3. FEFO（先到期先出）本次仅支持手动指定批次，自动 FEFO 排序后续优化
