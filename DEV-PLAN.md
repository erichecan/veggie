# DEV-PLAN：商品去重/合并（60 组重名 Product，132 条记录）

## 读取的文档

无独立 PRD。需求来自用户口述："库里有 60 组重名 Product，其中 8+ 组重名记录 type 还不一致
(CONSU/PRODUCT 混杂)，是 6/21 和 7/17 两批导入留下的重复数据"。已用只读诊断脚本对生产/本地共用的
Neon 开发库（`.env.local`）核实，结论与用户描述一致，见下方"现状核实"。

## 现状核实（只读诊断，脚本见 `scripts/diagnose-duplicate-products*-20260905.ts`）

- 商品总数 5480，重名分组 60 组，涉及 132 条 `Product` 记录。
- **引用面比预期小**：`PurchaseOrderLine`/`PurchaseRecord`/`PurchaseSuggestion`/`CreditNoteLine`/
  `StockTakeLine`/`OrderDiscrepancy`/`OdooPricelist.items`（JSON 松引用）**全部 0 命中**——这批重复
  商品几乎没有进入采购侧和定价流程。真正挂数据的只有 `OrderLine`（订单行）、`StockMove`（库存流水）、
  `qtyOnHand`（库存数字），个别有 `ProductSupplierInfo`。`Lot`/`ProductAlias`/`ProductSaleUom`/
  `CustomerSpecialPrice` 在这 132 条上全部 0 命中，但脚本仍会防御性处理（万一生产库跟本地有 drift）。
- 60 组呈现三种形态：
  1. **约 33 组·安全型**：6/21 批次那份 `status=ACTIVE` 且挂真实 `orderLines`/`stockMoves`，
     7/17 批次那份 `status=ARCHIVED` 且是空壳（0 引用）。
  2. **19 组·纯 7/17 批次内部重复**（如 "Reuseable" 一口气 5 份、"Broccoli 5KG CASE"、
     "Cabbage Primo 12 CASE"）：没有 6/21 对照，两份都 `ARCHIVED`，`orderLines` 都是 0，但
     `qtyOnHand` 数字不一致。
  3. **8 组·type 不一致**（CONSU/PRODUCT 混杂）：6/21 那份 `CONSU`/`ACTIVE`，7/17 那份
     `PRODUCT`/`ARCHIVED`；其中 2 组（GL Barley、GL White Back Black Fungus）库存和流水**实际挂在
     7/17 那份**上（500 件级别），其余 6 组两份都没有库存流水。

## 已与用户确认的合并政策（2026-09-05，T1 之后已修正一次）

1. **type 归属**：谁有 `StockMove` 就归谁的 type（8 组里有 2 组适用；其余 6 组两边流水都是 0，
   走下面统一的 winner 选择规则兜底）。
2. ~~qtyOnHand 冲突：以较新批次（7/17）那份的数字为准，另一份归零处理~~
   **已推翻（见下方"T1 执行后发现的关键事实"）**。修正为：**组内所有候选的 `qtyOnHand` 直接相加**
   作为最终库存（不区分谁是 7/17、谁是 6/21）。
3. **19 组纯 7/17 内部重复 + 38 组跨 id 都有真实订单的商品**：统一信任下方的确定性算法自动处理，
   不逐组人工复核（用户已确认，2026-09-05）。
4. **输家记录**：物理删除；执行前对受影响的 132 条 `Product` 行单独建表备份（不是本地 JSON，
   直接在生产库建 `product_dedup_backup_20260905` 表存档，同一事务内完成）。

## T1 执行后发现的关键事实（2026-09-05，推翻了原计划的风险评估前提）

T1 决策表最初是拿本地开发库（Neon，数据停在导入时刻）跑的分析结果，据此判断"约 33 组安全型
（6/21 有真实订单、7/17 是空壳）"。但直连生产库（167.99.86.19）复核后发现**完全不是这么回事**：
生产库带着这批重复商品已经**实际运营了两个多月**，**60 组里有 38 组（63%）两个重复 id 上都挂着
真实订单行**——不是一个在用一个废弃，而是业务员下单时系统交替选中了同名的两个不同 id，把同一款
商品的真实销售历史劈成了两条独立台账（例：`Cooking Wine 10L DRUM` 一个 id 2143 行订单、另一个
1334 行；`VIP 3 BOX` 一个 id 挂 20 张订单但库存显示 0，另一个 id 库存 545 但从没被下过单）。

**结论**：FK remap（把两条历史都改指向同一个幸存 id）不受影响仍然安全；受影响的只是 qtyOnHand
的合并算法——原"以 7/17 为准、另一份归零"的前提（假设一份是没人用过的空壳）在生产库大批不成立，
已改为"两份现有数字直接相加"（用户已确认，2026-09-05）。winner 选择算法（4 条优先级规则）本身
不受影响：cnt_ol>1（两边都有订单）时规则天然落到 stockMoves/status/externalId 兜底层，逻辑无需改。

## 合并算法（统一规则，覆盖三种形态，不需要为 8 组/19 组单独分叉代码路径）

对每个重名分组，按以下优先级选出 **winner**（其余为 loser）：

1. 唯一一个候选 `orderLines > 0` → 该候选为 winner（覆盖形态 1 的 33 组）。
2. 否则，唯一一个候选 `stockMoves > 0` → 该候选为 winner（覆盖 8 组里 GL Barley / GL White Back
   Black Fungus 这 2 组——同时满足用户确认的"政策 1"，因为 winner 的 type 就是 winner 自己的 type，
   不需要额外分叉）。
3. 否则，唯一一个候选 `status === ACTIVE` → 该候选为 winner（覆盖 8 组里剩余 6 组：两边流水都是 0，
   6/21 的 CONSU/ACTIVE 那份胜出，type 保持 CONSU——业务上合理，这几条本来就没有真实库存记录）。
4. 否则（两边条件全平局，覆盖形态 2 的 19 组），取 `externalId` 数值较小的候选为 winner。

winner 确定后：
- **最终 type / status**：直接取 winner 自身字段（见上，规则 1-3 已经让"谁有数据谁定 type"这条政策
  自然成立，不需要独立判断）；`status` 额外做一次修正——若 loser 里有任何一个 `status===ACTIVE`
  而 winner 是 `ARCHIVED`，winner 改为 `ACTIVE`（避免把仍在用的商品误归档掉）。
- **最终 qtyOnHand**：
  - 若组内只有一个候选 `qtyOnHand ≠ 0` → winner 最终值取该数字（不管是不是 winner 自己的）。
  - 若组内 ≥2 个候选 `qtyOnHand ≠ 0`（真正冲突）→ 按政策 2，取 `createdAt` 日期为 `2026-07-17`
    的那个候选的数值；若冲突双方都不是 7/17（理论上不应发生，防御性判断），停止并人工确认。
  - 否则（全 0）→ 0。
- **FK remap**（把所有 loser id 出现的地方改指向 winner id）：`OrderLine.productId`、
  `StockMove.productId`、`ProductSupplierInfo.productId`（注意 `@@unique([productId,supplierId])`，
  remap 撞唯一键时保留 winner 侧已有的一条、丢弃 loser 侧重复的一条）、`Lot.productId`、
  `ProductAlias.productId`、`ProductSaleUom.productId`（同样处理 `@@unique([productId,uomId])`
  冲突）、`CustomerSpecialPrice.productId`（无 FK 约束，直接 UPDATE）。
- **删除 loser**：FK 全部 remap 完成后物理删除 loser 的 `Product` 行。

## 执行步骤

- **T1（只读）**：写"合并决策表"生成脚本，对 60 组分别打印 winner/loser id、最终 type/status/qty、
  以及触发的规则编号(1-4)，不写库。
- **T2（人工核对）**：把 T1 结果贴给用户过一遍，重点看 8 个 type 组 + qty 冲突的 10-15 组是否符合预期，
  19 组自动规则的结果也抽查几条。**此步骤是硬性停顿点，不确认不进入 T3。**
- **T3（备份）**：本地库执行前，对生产库 `Product` 表做一次 `pg_dump`/JSON 导出全量备份，落盘存档。
- **T4（本地库试跑）**：在本地 Neon 开发库（`.env.local`，与生产结构一致）完整跑一遍 FK remap +
  Product 更新 + 删除 loser，验证：重跑诊断脚本确认 0 重名分组；各引用表记录数前后一致（loser 侧的
  行数应等量转移到 winner）；`npx tsc`/`npm run build` 通过；抽查几张受影响的历史订单详情页/库存流水
  页面显示正常。
- **T5（生产落地，不可逆操作，执行前必须停下汇报并等待用户明确同意）**：生产库先跑一次 T1 的
  只读决策表脚本核实规模与本地库一致，再执行 T3 备份，再执行 FK remap + 删除。
- **T6（验证）**：生产库重跑诊断脚本确认 0 重名分组；核对总 `qtyOnHand` 变化清单（哪些组的库存因
  qty 冲突被清零，列一份人工可读的清单留档）；`/api/health`、商品列表页、下单选品页抽查正常。

## 风险点

- **qty 冲突"以 7/17 为准"可能清零掉 6/21 以来真实发生过的库存变动**（如果 6/21 那份的非零库存其实
  是最新盘点结果、7/17 只是导入时的陈旧快照）。T2 人工核对阶段务必把这批清单单独列出来重点看一遍。
- **物理删除不可逆**：T3 备份是唯一的回退手段，T5 前必须确认备份文件可读、字段完整。
- **`ProductSupplierInfo`/`ProductSaleUom` 唯一键冲突**丢弃 loser 侧重复行时会丢失该行独有的非唯一键
  字段（如报价/换算系数），脚本需要打印被丢弃的具体内容供人工复核，不能静默丢弃。

## 停下确认

📋 计划已生成。请确认：
1. 上面的合并算法（含 4 条 winner 优先级规则、qty 冲突处理、`ACTIVE` 状态修正规则）是否符合预期？
2. 是否先做 T1（只读决策表），出结果后再一起看，还是希望现在就有不清楚的地方先问？

回复"确认，开始开发"后我从 T1 开始执行；T3（生产备份）和 T5（生产落地）会再单独停下等你明确同意。
