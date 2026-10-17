# DEV-PLAN：采购运费按数量分摊进成本，确认时联动成本价、取消时回滚

日期：2026-10-17

## 读取了哪些文档

本次无项目内 PRD 文件改动。需求来源是客户在采购单页面截图上的手写批注，逐字存档见
`docs/20261017-采购运费分摊成本联动-需求原话.md`。

## 现状排查（技术决策依据，不用你看）

调研了三轮代码（成本字段、确认/取消路由、收货加权平均算法），关键发现：

1. **"Cost"列现状**：采购单详情页的 Cost 列显示的是 `Product.standardPrice`（历史参考成本），有
   tooltip 说明"不写入本单"——跟客户左①批注完全吻合，只是客户想把它从"一直显示"改成"hover 显示"。
2. **真正写成本价的不是"确认采购"，是"确认收货"**：`action=confirm`（RFQ→Purchase Order）现在只写
   `confirmedAt`、回填采购单位、自动生成草稿供应商账单，完全不碰任何成本字段。真正把成本写进
   `Product.standardPrice` 的是后面"确认收货"（`action=receive`，在 `lib/purchase/receive-purchase-order.ts`），
   用的是**移动加权平均**：`新成本=(原库存量×原成本+本次到货量×本次成本)/总量`，且**不含运费**，`Lot`
   批次成本也是收货时一次性记录、之后不再变。
3. **运费分摊逻辑已存在但是"现算不落库"**：`lib/purchase-landed-cost.ts` 已经有一个分摊函数，但按
   **行金额占比**分摊（不是按数量），且 schema 注释明确写着"不回写 Product 成本"——这是此前一次改造时
   刻意做的设计决定，客户这次的要求等于要推翻它。
4. 运费字段（`PurchaseOrder.freightAmount`）已存在，且只在 `DRAFT/SENT` 状态可编辑，`CONFIRMED` 之后后端
   会拒绝改——这意味着点"确认采购"那一刻运费金额已经是终值，可以放心拿它去算分摊。
5. Product 用 `type` 字段区分 `PRODUCT`(storable)/`CONSU`(consumable)/`SERVICE`，客户截图的
   "storable或consumable" 对应 `type !== 'SERVICE'`。
6. PO 状态机：`DRAFT/SENT/TO_APPROVE → CONFIRMED → RECEIVED → INVOICED → LOCKED`，`CANCELLED` 可从多个
   状态进入。现有"取消"校验依据的是一张"到货登记"台账（`GoodsReceipt`），而真正改库存的"确认收货"动作根本
   不写这张表——换句话说，一张已经走完"确认收货"（库存、批次成本都已经改过）的单子，理论上还能被取消却
   不会被拦下来。这是**预先存在的缺口，不是本次需求引入的**，本次只做一道防御（见下文"风险点"第3条），
   不在本次范围内彻底修。

## 核心冲突 + 处理方式（已跟你确认，按客户字面要求执行）

"确认采购"写入的成本（含运费、确认时点）和"确认收货"写入的成本（不含运费、加权平均、收货时点）口径不同，
会对同一批货写两次成本。按你"按客户要求去改"的拍板，两边都保留，不改收货环节的算法——这是预期行为，
写进风险点，不包装成"待你判断"的问题。

## 模块拆解

1. **Schema**：`PurchaseOrderLine` 新增 3 个字段（分摊运费、落地成本、回滚快照）
2. **分摊算法**：`lib/purchase-landed-cost.ts` 把"按金额占比"换成"按订购数量占比"，支持手动覆盖 + 服务类排除
3. **确认流程**：`app/api/purchase-orders/[id]/route.ts` 的 `CONFIRMED` 分支里，校验分摊合计、写落地成本到
   行、写成本价到 Product、整段包进事务（现有代码没用事务，这次因为要跨表写 Product 必须原子化）
4. **取消流程**：同文件 `CANCELLED` 分支，带竞态保护的回滚（只在"自确认后没被更晚的单子覆盖过"时才回滚）
5. **UI**：Cost 列改 info 图标；新增可编辑"分摊运费"列；分摊合计校验横幅（红/绿）；Confirm 按钮前置校验
6. **verify.sh**：新增确认/取消/校验三组探针

## Schema 设计

```prisma
model PurchaseOrderLine {
  ...
  /// 本行分摊运费（折合欧元）。null=未手动指定，确认时按订购数量比例自动算；
  /// 非 null=操作员手动覆盖过的值。仅 storable/consumable（Product.type != SERVICE）参与分摊，
  /// service 行恒为 0 且不计入分摊基数(20261017 客户需求：采购运费分摊进成本)
  allocatedFreightEur           Decimal? @db.Decimal(12, 2)
  /// 落地成本 = (本行税前小计Eur + 分摊运费) / 订购数量；确认时写入并同步推到 Product.standardPrice
  landedUnitCostEur             Decimal? @db.Decimal(12, 4)
  /// 确认瞬间该商品 Product.standardPrice 的快照，取消时用于回滚；
  /// 只有真正把成本推到 Product 的行才有值，service 行恒 null
  standardPriceBeforeConfirmEur Decimal? @db.Decimal(12, 4)
}
```

`PurchaseOrder` 表上那条"运费按行 subtotal 占比摊入...不回写 Product 成本"的注释要同步改掉，避免跟新行为对不上。

## 路由 / 函数清单

| 文件 | 改动 |
|---|---|
| `prisma/schema.prisma` | 加 3 字段 + 改 1 条过时注释，`prisma migrate dev` 生成迁移 |
| `lib/purchase-landed-cost.ts` | 分摊算法从"金额占比"改"数量占比"；加 `computeFreightAllocationForConfirm(freightAmountEur, lines)`：区分手动覆盖/自动行，自动行按订购数量比例分摊，整除不尽的余数由最后一行吸收；service 行强制 0 且不进分母 |
| `app/api/purchase-orders/[id]/route.ts` | `CONFIRMED` 分支：分摊合计校验（不等于 freightAmountEur 则 409，带具体差额）→ 写 `allocatedFreightEur`/`landedUnitCostEur`/`standardPriceBeforeConfirmEur` → 写 `Product.standardPrice`；全部包进 `$transaction`。`CANCELLED` 分支：仅当 `po.status==='CONFIRMED'`（未进入 RECEIVED）时按行回滚，且只在当前 `Product.standardPrice` 仍等于 `landedUnitCostEur`（没被更晚的单子覆盖）时才真正回滚，否则跳过+写审计日志 |
| `app/[locale]/classic/operator/purchases/[id]/page.tsx` | Cost 列单元格→ info 图标 + tooltip；新增"分摊运费"可编辑列（复用现有 `editLines`/`updateLine` 模式，`SERVICE` 类行禁用显示"—"）；表格上方加分摊校验横幅；Confirm 按钮点击前做客户端同款校验（服务端仍是最终把关） |
| `scripts/verify.sh` | 新增确认/取消/分摊校验三组探针（见附录 A） |

## 假设清单（我的技术判断，不再找你确认，写在这里留痕）

1. **public price = `Product.standardPrice`**（页面上标"成本价/参考成本"的那个字段），不是 `listPrice`（牌价/
   售价）——运费分摊讲的是成本，不是售价；Pricelist 的售价公式本身读 `standardPrice` 算出来，成本变了售价
   会自动联动，不是我去直接改售价字段。
2. **分摊基准统一按订购数量（`orderedQty`）比例**，不做"箱"的物理换算。截图例子单位全是 CASE，字面说
   "总箱数"，但系统商品单位可以 KG/个/箱混用，没法做真的箱数换算，所以退化成按数量比例——这跟 UoM 全为
   CASE 时的效果等价。
3. **RECEIVED 之后取消不回滚成本**：一旦"确认收货"跑过（库存、批次成本已经被加权平均混合），回滚
   `standardPrice` 既没意义也有风险，这次只处理"确认但未收货就取消"这一种场景。
4. **不修复"已收货单仍可被取消"的历史缺口**（见"现状排查"第 6 条），只在成本回滚这一步加防御，不动
   `goodsReceipt` 计数那道拦截逻辑本身。

## 风险点

1. 确认采购和确认收货两次写成本、口径不同，是预期行为（见"核心冲突"），不是本次要修的 bug。
2. 回滚竞态：两张不同的 PO 确认了同一个商品，后取消先确认的那张时，不会把后一张刚写的新成本覆盖掉——
   跳过并留日志，不强行回退。
3. 分摊合计校验是硬性拦截（409），不会静默放行也不会自动"抹平"差额（除非完全没手动改过，那种情况自动
   分摊本来就不会有余数）。

## 附录 A：技术验收标准（verify.sh，我自证，你不用看）

- `npx tsc --noEmit`、`npm run build`、`npx prisma migrate status` 全过
- 迁移探针：新 3 字段迁移成功应用到开发库
- 路由探针：对一张测试 PO 执行 `action=confirm`，断言涉及商品 `Product.standardPrice` 更新为预期落地成本
  （(税前小计+分摊运费)/订购数量）；再执行 `action=cancel`，断言 `standardPrice` 恢复为确认前快照
- 鉴权探针：`confirm`/`cancel` 分别用「无 token / 错 token / 低权限（无 purchase.order.approve）」请求，
  断言 401/401/403（复用现有权限位，不新增权限点）
- 校验探针：故意让分摊合计差 0.01，断言 `confirm` 返回 409 且错误信息带具体差额
- service 类型探针：单子里混一个 `SERVICE` 行，断言该行 `allocatedFreightEur` 恒为 0 且不占分摊基数
- 查询/性能：本次改动不涉及列表接口，不新增 N+1 风险

verify.sh 不过不写完成报告；无命令输出的条目标 ⚠️ 未验证，不标 ✅。

---

📋 计划已生成。三块内容，只有第 1 块需要你判断：

【需要你判断 — 场景清单】
用你的话描述做完之后是什么样，逐条标注来源：
- [客户说的] 采购单详情页，Cost 列旁边（或下面）新增一列"分摊运费"，默认按每行订购数量占比自动算出建议值，可以手动改成别的数
- [客户说的] 页面上能看到"分摊运费合计"和"运费总额"是否对得上的提示，对不上点不了"Confirm Purchase"
- [客户说的] 点 Confirm Purchase 后，这批商品的成本价变成这次算出来的落地成本（原单价+分摊运费）
- [客户说的] 如果这张单后来被取消（且还没走到"确认收货"），成本价恢复成确认前的值
- [你说的] Cost 列改成一个 info 图标，鼠标悬停才显示历史参考成本，不占着一整列空间常驻显示
- [我推断的] 只对非 SERVICE 类型的商品做分摊和成本联动，SERVICE 类型商品该列显示"—"，不参与分摊
- [我推断的] "public price" 落在成本价字段（`standardPrice`），不是售价/牌价字段（`listPrice`）；售价会因为
  Pricelist 公式读成本价而间接联动，不是我直接改售价
- [我推断的] 分摊基准按订购数量比例，不做"箱"的物理单位换算（截图例子单位全是 CASE，混合单位时按数量比例是
  最接近字面意思的实现）
- [我推断的] 一旦这张单已经走到"确认收货"，取消时不再回滚成本价（库存/批次成本那时已经被收货环节的加权
  平均混合过，回滚没意义还可能把后续更新的成本带错）

推断项最容易错，请重点看这几条，尤其是 public price 落在哪个字段这一条。

【我负责 — 你不用看】
技术验收标准与 verify.sh 见附录 A。性能、鉴权、类型、查询效率由我定标准、我自证、我贴证据。
（本次不涉及新建数据库/部署目标，沿用项目现有 Neon 开发库 + DigitalOcean 生产部署）

【一次性告知 — 不同意就说】
- 歧义清单：确认采购 vs 确认收货两处都会写成本价、口径不同，按你的决定两边都保留，不是 bug
- 假设清单：见上方"假设清单"4 条
- 已知缺口（不在本次范围）：已收货单理论上仍可能被取消却不报错——这是本次调研中发现的历史缺口，不是
  这次新功能引入的，这次只加了"RECEIVED 后不回滚成本"这一道防御，没有去补更大的那个缺口

回复"确认"后我不再就实现细节打断你。
