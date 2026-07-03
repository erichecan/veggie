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

---

# 追加计划：角色功能补全(2026-06-11)

> 来源:docs/role-feature-matrix.html 盘点 + 用户确认的优先级。
> 不做:利润分析、路线规划、账龄分析、损耗报表、客户健康、实时地图、税务报表、物流分析充实、手机端适配。

## 实施范围(8 项,按实施顺序)

| # | 事项 | 规模 | 改动面 |
|---|------|------|--------|
| 1 | #11 老板欠款入口 | 小 | boss KPI 卡 + 导航项 |
| 2 | #9 角色工作台/导航重组 | 大 | operator 首页工作台 + operator/accounting 导航补全 |
| 3 | #4 报表导出 CSV | 中 | lib/csv-export.ts + 3 处导出按钮 |
| 4 | #13 信用票管理页 | 中 | 新页面(API 已完整) |
| 5 | #12 供应商账单页 | 中 | 新页面 + vendor-bills/[id] PUT |
| 6 | #10 分笔收款核销 | 大 | Prisma Payment 模型 + /api/payments + 发票详情收款 UI |
| 7 | #15 商品/客户批量导入 | 中 | CSV 导入对话框 + bulk API |
| 8 | #14 通知触达 | 中 | lib/notify helper + 下单/低库存触发 |

## 关键设计决策

### #9 工作台
- `operator/page.tsx` 由 redirect 改为「今日工作台」:待确认报价单 / 今日待分配 / 配送中 / 待开票 / 待审退货 / 低库存,每卡片显示数量并直达对应页面。
- operator 导航第一项加「工作台」。
- accounting 导航补全:核销管理 + 财务总览 + 司机交账 + 客户对账单(现状 bug:FINANCE 角色无法从导航到达 finance 页面)。

### #10 Payment(唯一 schema 变更,纯新增表,无破坏)
- Payment { id, invoiceId, customerId, amount, method(cash|transfer|other), paidAt, note, createdBy }
- POST /api/payments:创建收款并原子更新 Invoice.amountPaid/amountDue/status(amountDue<=0 → PAID)。
- 发票详情页加「收款记录」区块 + 记收款对话框。

### #4 导出
- CSV(带 BOM,Excel 直接打开),统一 helper `lib/csv-export.ts`。
- 挂载点:boss/sales-report、ReportingToolbar(透视表)、finance 未结款明细。

### #15 导入
- 客户:CSV → POST /api/customers/bulk。
- 商品:CSV → POST /api/products/bulk(服务端自动创建 ProductTemplate)。

### #14 通知
- `lib/notify.ts`:notifyRole(roles, type, title, body)。
- 触发点:customer-portal 下单成功 → 通知 OPERATOR;订单确认后 ATP 低于安全库存 → 低库存通知。

## 架构/质量/性能评估(大改三问)
1. **架构**:新页面全部复用现有 layout+OdooNav 模式与 withAuth 鉴权,无新边界;Payment 为唯一新表,与 Invoice 单向关联,无单点风险。
2. **质量**:信用票/供应商账单复用现有列表页模式;导出统一走一个 helper,避免三处重复实现。
3. **性能**:工作台统计用 prisma count/groupBy 聚合,不拉全量订单;批量导入走单次事务批插入,不循环单条 API。

## 验证
- 每项完成后 preview 实测 + 控制台无错;全部完成后 npm run build,更新 docs/role-feature-matrix.html 状态,分项 commit。
