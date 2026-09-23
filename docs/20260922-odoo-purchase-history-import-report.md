# 历史采购单全量导入 — 完成报告

## 触发
用户发现 Odoo（Purchase Analysis）能查到 Liroy B.V. / sop international LTD 2026年1月至今的供货数据，但生产环境（veggie）查不到，要求排查并把**全部供应商**的历史采购数据补进来。

## 根因
生产库自 2026-06/07 那轮 Odoo 数据迁移只导入了：销售单（sale_order）、客户发票（account_invoice）、供应商/客户主档（res_partner）。**从未导入过采购单交易记录**（purchase.order / purchase.order.line）。生产库 `PurchaseOrder` 表当时只有 42 条，最早 2026-05-01，且其中 26 条还是 `[DEMO] 演示种子数据`（真实的只有 16 条）——不是 bug，是这块数据本来就没导过。

## 数据来源
没有重新联系 Odoo 服务器或申请新 API Key。直接从归档的完整 Odoo12 pg_dump
（`_archive/odoo12-full-dump-20260716.sql`，当初下载后没删）里用
`scripts/odoo-migration/extract-purchase-from-full-dump.py` 抠出两张表的 COPY 块，
导出为 `purchase_order.csv`（15,510 行）/ `purchase_order_line.csv`（58,255 行，未提交
git，属受保护 PII，仅本机/服务器临时使用后已清理）。

## 处理过程
1. **供应商覆盖率缺口**：dry-run 发现 844/15,510 张单（5.4%）的供应商在 veggie 里没有对应
   `Customer(isVendor=true)` 记录。逐个查证后（`scripts/backfill-missing-purchase-suppliers-20260922.ts`）：
   - 3 家（Begleys/C.A.F. Trading Ltd/Fresh Point）在 veggie 里已有孤儿客户记录，翻转 `isVendor=true`
   - 6 家（Carnival Asia Food/Hansung/Just Parckaging/Ruskim/Lin Kee Ltd/Freshchoi）Odoo 里存在但
     veggie 从未导入（多数是 Odoo 里已归档的供应商，2026-07-14 那次"只导有效供应商"漏掉的），新建档案
   - 1 家「Test-Vendor」（externalId=1476, 17 单）明显是 Odoo 测试记录，判定为垃圾数据，不补
   - 剩余覆盖不到的订单降到 17 单（0.1%），全部是 Test-Vendor
2. **CSV 解析 bug**（实测踩坑，已修）：朴素按 `\n` 切分行的写法会把跨行的带引号字段（供应商备注/
   PO 备注等）拆成两条脏数据，purchase_order.csv 里 43 处、purchase_order_line.csv 里 73 处受影响。
   改成按引号配对累积物理行再解析（同 20260717 销售单导入脚本的处理方式）后，数字从"待导入 15,510
   单/跳过 844"变成准确的"待导入 15,449 单/跳过 17"。
3. **本地 dry-run 不可信**：本地开发库供应商主档跟生产库不同步（本地只有 12 个 isVendor 客户，
   生产库 203 个），dry-run 改为直接对生产库跑（只读 SELECT，未写入），确认安全后才 `--apply`。

## 结果
- 新建采购单 **15,432** 张，行明细 **58,165** 行
- 生产库 `PurchaseOrder` 表：42 → **15,474** 条；`PurchaseOrderLine`：77 → **58,242** 行
- Liroy B.V. + sop international LTD：现在能查到 **199 张历史采购单**，2022-03-01 ~ 2026-07-08，
  合计 €2,853,981.89（与 Odoo Purchase Analysis 页面口径一致，覆盖用户截图里 2026 年 1 月至今的数据）
- 61 行（0.1%）因商品在生产库里找不到对应 `externalId` 被跳过——核对是 2026-09-05 商品去重合并
  （60组重名商品合并）后这批商品的 externalId 不再指向现存记录，与本次导入无关，是已知的独立历史清理动作的自然结果
- 状态映射：`purchase`/`done` → LOCKED（历史已完成单据锁定不可误改）15,409 单，`draft` → DRAFT 15 单，`cancel` → CANCELLED 8 单
- 币种：15,418 单 EUR，14 单 GBP（供应商国家码 GB，判断为英镑；Odoo 没导出汇率表，`exchangeRatePending=true`，未编造汇率）
- 不涉及 GoodsReceipt/StockMove/VendorBill，不影响当前库存——纯历史记录导入

## 未处理（本次范围外，供参考）
- 生产库现有 26 条 `[DEMO] 演示种子数据` 采购单未清理，与真实数据混在一起（这是既有状态，非本次引入）
- 17 单「Test-Vendor」历史采购单永久跳过（判定为 Odoo 测试数据）

脚本：`scripts/import-odoo-purchase-orders-20260922.ts`、`scripts/backfill-missing-purchase-suppliers-20260922.ts`、
`scripts/odoo-migration/extract-purchase-from-full-dump.py`（均可安全重跑，按采购单号/`externalId` 幂等）。
