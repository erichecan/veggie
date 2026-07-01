# 设计方案：部分数量开票（Partial-Qty Invoicing）

> 日期：2026-07-01
> 状态：立项（设计，未实现）
> 背景：B-2（`docs/20260701-数据所有权审计-销售会计链路.md`）已解决「行拆分开票」（不同行开在不同发票），但**同一行部分数量开票**仍未支持——本方案立项。

---

## 一、问题陈述

当前 `OrderLine.invoicedQty` 回写恒为 `= deliveredQty`（B-2 后按行 scope）。这假设「一行要么全开、要么不开」。

**缺口场景**：某订单行交货 100，先开票 60、后开票 40。
- 现状：第一张发票开 60 → `invoicedQty` 被设为 `deliveredQty`(=100)，**第二张 40 无从判断是否已开**，且第一张开票后该行就显示「已全开」。
- 期望（Odoo `qty_to_invoice = delivered − invoiced`）：开 60 后 `invoicedQty=60`、可开票量=40；再开 40 后 `invoicedQty=100`、可开票量=0。

---

## 二、核心设计：`invoicedQty` 改为派生聚合（SSOT）

**原则**：`OrderLine.invoicedQty` 不再由「最后一张发票」独立写，而是 **= Σ 所有有效发票行中引用该 orderLineId 的已开数量**。发票行本就带 `qty`（本张开票量）+ `orderLineId`（B-2 已加）——「已开量」已在数据里，缺的是**累加口径**与**可开票量约束**。

- 写入权威 = 发票行（Invoice line 的 `qty`）。
- `OrderLine.invoicedQty` = 派生聚合，每次发票 POST/作废/贷记时 **从源重算**（幂等，不累加式 +=，避免重复/漏减）。
- **可开票量** `qtyToInvoice(line) = deliveredQty − invoicedQty`，开票 UI 与服务端校验都以此为上限。

---

## 三、Schema 决策（关键）：Json 聚合 vs 关系表

`Invoice.lines` 现为 Json。要按 `orderLineId` 跨所有发票聚合 Σqty，两条路：

| 方案 | 做法 | 优 | 劣 |
|---|---|---|---|
| **A. 保留 Json + 应用层聚合** | 重算时 `findMany` 该客户/该单相关发票，在 JS 里过滤 lines[].orderLineId 求 Σqty | 无 schema 迁移，改动小 | 聚合靠全量拉发票+JS，量大慢；无 DB 级约束；并发下需在事务内重算 |
| **B. 新增关系表 `InvoiceLine`（含 orderLineId FK + qty）** | 发票行落关系表，`invoicedQty` 由 `SELECT SUM(qty) ... WHERE orderLineId=? AND invoice.status<>CANCELLED` 直算 | 可 DB 级聚合/索引、可加约束、审计清晰；与 OrderLine 对称 | 需迁移 + 把现有 Json lines 回填到新表 + 所有读发票行处改读关系表 |

**推荐：B（关系表）**，但**分两期**：
- **一期（MVP）**：走 A——不加表，回写改为「事务内按 orderLineId 聚合当前订单的所有非作废发票行 Σqty 重算 invoicedQty」。快速支持部分开票，风险可控。
- **二期（可选加固）**：若发票量增长/需报表级发票行分析，再引入关系表 `InvoiceLine`，把 Json 回填过去，聚合下沉到 SQL。

> 理由：一期不动 schema、不回填历史，最快闭合业务缺口；关系表是纯加固，非必须，按需再上（Strangler）。

---

## 四、一期（MVP）实现清单

### 4.1 数据/口径
- `OrderLine.invoicedQty` 语义正式定为「派生聚合 = Σ 非作废发票行 qty（按 orderLineId）」。
- 新增 `lib/invoice-invoiced-qty.ts` 的 `recomputeInvoicedQtyForOrders(tx, orderIds)`：在事务内，拉这些订单的所有非 CANCELLED 发票，按 orderLineId 汇总 Σqty，`UPDATE OrderLine SET invoicedQty = <sum>`（含未被任何发票引用的行 → 0）。**替换**现有 `writebackInvoicedQty` 的「= deliveredQty」语义。

### 4.2 开票入口（创建/自动建票）
- **可开票量**：`lib/invoice-from-order.ts` 与手工建票 `invoices/route.ts` 建行时，每行可开量 = `deliveredQty − invoicedQty`（不再无脑用 deliveredQty）。
- 自动建票：默认按「全部可开量」建（= 剩余未开），而非 deliveredQty。
- 手工建票：前端可编辑每行 qty，服务端校验 `0 < qty ≤ 可开量`，超额 400。

### 4.3 回写触发点（都改为调 `recomputeInvoicedQtyForOrders`）
- 发票 **POST**（`invoices/[id]/post`）：过账后重算相关订单。
- 发票 **创建**（`invoices/route.ts`，若创建即计入应开）：按现有语义决定 DRAFT 是否计入（建议**仅 POSTED 计入 invoicedQty**，DRAFT 不计——与 Odoo「过账才占用可开量」一致；需确认业务口径）。
- 发票 **DELETE / CANCEL**：重算（Σ 自动减少）。
- **CreditNote**（贷记/退货冲回）：若允许冲减已开量，纳入 Σ（负向）——需与退货流程对齐，二期再定。

### 4.4 校验与并发
- 服务端建票/过账在**事务内**先算可开量再落库，防并发超开（可加 `SELECT ... FOR UPDATE` 或唯一约束兜底）。
- 幂等：重算是「从源 Σ」，重跑结果一致。

---

## 五、边界与风险
- **DRAFT 是否占用可开量**：建议不占（仅 POSTED），否则草稿堆积会锁死可开量。需业务确认。
- **舍入**：qty 是数量（Decimal 14,3），Σ 精确；金额按行 round2，Σ 后再 round2。
- **改单删行**：某 OrderLine 被删但已有发票引用其 orderLineId → 悬挂引用。重算时 orderLineId 已不存在则跳过；建议禁止删除「已开票行」。
- **历史数据**：一期不回填；历史 invoicedQty 现为 deliveredQty，重算首次运行会把「无发票引用的行」归 0——**需先跑一次 dry-run 看影响面**（类似 `fix-tax-pretax-unification.ts` 的做法）。
- **B-2 兼容**：一期后 `writebackInvoicedQty` 的「行级 vs 整单」回退逻辑被聚合重算取代；旧发票行无 qty？——现 Json 行有 `qty`，兼容。

## 六、测试计划
- 单测：`recomputeInvoicedQtyForOrders` 对「单发票全开 / 两发票 60+40 / 作废一张 / DRAFT 不计」各断言 invoicedQty。
- E2E（`testing-end-to-end-experience`）：下单→确认→送达(deliveredQty=100)→开票 60→查可开量=40→开票 40→可开量=0→作废第二张→可开量回 40。
- dry-run 脚本：上线前统计历史 invoicedQty 与「Σ发票行」差异面。

## 七、落地顺序（Strangler）
1. 定义 invoicedQty 派生口径 + 写 `recomputeInvoicedQtyForOrders`（不改触发点，先加函数 + 单测）。
2. dry-run 脚本核历史影响。
3. 切触发点（POST/DELETE/CANCEL）到重算，删旧 `= deliveredQty` 语义。
4. 开票 UI 加「可开票量」列 + qty 可编辑 + 超额校验。
5. （二期，可选）引入关系表 `InvoiceLine`，Json 回填，聚合下沉 SQL。

---

## 关联
- 前置 B-2：`docs/20260701-数据所有权审计-销售会计链路.md`、`lib/invoice-invoiced-qty.ts`
- 参照 Odoo 流程：`docs/odoo12_sales_delivery_invoice_flow.svg`（`qty_to_invoice = delivered − invoiced`）
</content>
