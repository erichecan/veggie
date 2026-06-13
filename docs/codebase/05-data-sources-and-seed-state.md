# 05 · 数据来源与种子现状

> 每张核心表的数据由「真实 API 操作」「种子脚本」还是「完全为空」产生，以及现有种子的割裂问题。
> 这是「为什么种子数据串不起来」的诊断依据。

---

## 1. 种子脚本清单

| 脚本 | 执行 | 职责 | 幂等 |
|---|---|---|---|
| `prisma/seed.ts` | `npm run db:seed`（package.json 行 12） | 用户/分类/属性/单位/科目/模板+变体/价格表/演示客户/演示订单/演示行程 | ✅ upsert |
| `prisma/seed-orders-stock.ts` | 手动 `npx tsx` | 150 条全状态订单(30×5) + 审计日志 + 35 商品初始入库 | ❌ **无标记，重跑累积** |
| `prisma/seed-returns.ts` | 手动 | 给 3 条行程加退货演示 | ✅ |
| `prisma/seed-trips.ts` | 手动 | 爱尔兰示例客户 + 演示订单 + 多状态行程 | ✅ |
| `prisma/seed-waves.ts` | 手动 | **先 deleteMany 全部波次** 再建 6 条 | ⚠️ 删全部 |
| `scripts/seed-transactions.ts` | `npx tsx scripts/seed-transactions.ts` | 完整链：订单→波次→行程→发票→对账单→信用票，带 `seed-tx` 标记便于清理 | ✅ **最佳实践** |

---

## 2. 表级覆盖矩阵

| 表 | 来源 | 覆盖 |
|---|---|---|
| User / ProductCategory / ProductAttribute / Uom(+Cat) / Account / OdooPricelist | seed.ts upsert | ✅ 完整 |
| ProductTemplate / Product | seed.ts（CSV 导入） | ✅ 批量 |
| Customer | seed.ts + seed-trips + seed-transactions（CSV+演示+真实） | ✅ 大量 |
| DriverSlot | seed.ts + seed-transactions | ✅ |
| Order | seed.ts(DEMO) + seed-orders-stock(150 随机,无标记) + seed-trips + seed-transactions(标记) | ⚠️ **分散，部分无标记** |
| OrderLine / OrderAuditLog / DeliverySlip | 随 Order 级联 | ✅ 自动 |
| PickingWave | seed-waves(删全部重建) + seed-transactions(标记) | ⚠️ 冲突 |
| Trip | seed.ts + seed-returns + seed-transactions | ⚠️ 分散 |
| Invoice | seed-transactions（INV 前缀） | ✅ 标记 |
| StockMove | seed-orders-stock（仅 35 商品 IN，无来源） | ⚠️ 只入不出、无 source |
| Statement / CreditNote(+Line) | seed-transactions（标记） | ✅ 标记 |
| **Payment** | — | ❌ **空** |
| **PurchaseOrder / POLine / GoodsReceipt / VendorBill** | — | ❌ **全空** |
| **Lot** | — | ❌ **空**（仅收货时生成） |
| **JournalEntry / JournalEntryLine** | — | ❌ **空**（仅发票过账生成） |
| **PurchaseSuggestion / Notification / OrderDiscrepancy** | — | ❌ **空** |
| **ProductSupplierInfo / CustomerSpecialPrice** | — | ❌ **空** |

---

## 3. 割裂问题根因（关键）

### 问题 A：种子绕过真实业务逻辑 → 库存不守恒
`seed-orders-stock.ts` 用 `prisma.order.create()` **直接造各状态订单**（含 CONFIRMED/COMPLETED），但**绕过了 `/api/orders/[id]` 的确认逻辑** —— 而真正扣库存、写 `StockMove(OUT)` 的代码就在那段确认逻辑里（见 [03 §5](03-business-rules.md)）。结果：
- 订单虽是「已确认/已完成」，**库存却没被扣**；
- 库存入库（行 201-221）是**另一个独立随机循环**，只给前 35 个商品 `type:'IN'`，且**缺 sourceType/sourceId/lotId**，无法追溯；
- 两个循环无交叉校验 → `Σ(IN) - Σ(OUT) ≠ qtyOnHand`，下单页 ATP 缺货告警失真。

> ✅ 纠正旧判断：业务代码**不缺**「下单扣库存」的桥（确认时已实现）。问题是**种子没走这座桥**。正确解法是事件驱动重放（调真实逻辑），不是补业务代码。

### 问题 B：状态机不自洽
- seed-orders-stock 的 WAVE_ASSIGNED 订单**没有对应 PickingWave**；
- `seed-waves.ts` 建波次前 `deleteMany({})` 删全部，会清掉 seed-transactions 的波次；
- 各脚本对 Trip/Wave 用不同（或无）标记，互相踩。

### 问题 C：无标记重跑累积
`seed-orders-stock.ts` 直接 create 无 `externalRef` 标记，每跑一次多 150 单。对比 `seed-transactions.ts`：统一 `MARK='seed-tx'`，跑前 `deleteMany({where:{externalRef:MARK}})`，可重复。

### 问题 D：整条链为空
采购链（PO→GR→VendorBill）、批次 Lot、会计凭证、收款 Payment、补货建议、通知、拣货差异 —— **全空**。导致采购分析、财务报表、批次/效期、收款历史等页面无数据可展示。

---

## 4. 当前可用的演示运行顺序（含已知冲突）

```bash
npm run db:seed                          # 1. 主数据 + 少量演示
npx tsx prisma/seed-trips.ts             # 2. 示例客户/订单/行程
npx tsx prisma/seed-returns.ts           # 3. 退货
npx tsx prisma/seed-waves.ts             # 4. ⚠️ 会清空第 5 步的波次
npx tsx scripts/seed-transactions.ts     # 5. 完整业务链
```
冲突：第 4 步 `deleteMany` 清波次。建议改为只删演示前缀。

---

## 5. 结论

现有种子是「**按表灌数据**」：多脚本各自 `create`，缺统一标记与幂等，绕过业务逻辑，导致库存/应收/状态机不守恒，且采购/会计/批次整链空白。
重构方向 = **事件驱动**（调真实确认/收货/开票/收款逻辑重放）+ 统一标记幂等 + 末尾断言守恒。详见 [seed-data-design](../20260612-seed-data-design.md) 与 [seed-data-refactor-plan](../20260612-seed-data-refactor-plan.md)（注：这两份旧文档中「全程不扣库存/必须补桥」的判断已被本轮代码核实推翻 —— 扣库存逻辑在确认时已存在，待据此修订）。

---

## 关联文档
[00 概览](00-overview.md) · [01 数据模型](01-data-model.md) · [02 角色与工作流](02-roles-and-workflows.md) · [03 业务规则](03-business-rules.md) · [04 功能与报表](04-features-and-reports.md)
