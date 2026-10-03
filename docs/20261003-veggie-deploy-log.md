# veggie 部署效果闭环日志 · 2026-10-03

## 生产数据清理：删除测试报价单(5条)+测试采购单(15条，含8张草稿供应商账单)

**本次改动想达成什么**

[用户原话] 用户发来生产环境截图，标注"这几个测试订单需要删除"（报价单列表，Cancelled 筛选，5 条）、
"这几个采购单需要删除"（采购单/询价单列表，截图可见的 15 条）。经追问确认范围："截图里出现的这些
是测试数据，你看第一列的编号就行"——即按截图里的单号精确匹配删除，不是"加个删除按钮"的功能请求。

**执行前核实（不是直接信截图，逐条查生产库）**

- 5 条报价单（JI-261003-001/JI-261001-003/002/001/JI-260930-002）：生产库查实均为 CANCELLED 状态，
  客户为 TEST-001(×4)/DaShangHai-81(×1)，与截图完全一致。CANCELLED 状态从未扣库存或已在取消时
  恢复库存，删除无库存副作用。
- 15 条采购单：生产库查实其中 13 条的 supplierId 查无对应 Customer 记录（孤儿引用，即截图里显示
  一串乱码而非供应商名的那些），另 2 条(PO-00031 Badosa Fruits S.L / PO-00038 CAF Trading Company
  Limited)能解析出真实供应商名——这两条结构上不像测试数据，但用户已明确"截图里出现的都删"，
  且进一步核实这 2 条关联的 VendorBill 金额本身就有明显错误（PO-00038 对应 VB-00029 金额 4.60，
  应为 460.00），佐证其同样是测试过程中产生的脏数据。
- 8 条关联 VendorBill 全部 DRAFT 状态，0 笔 VendorPayment，0 笔 JournalEntry——没有任何金额已经
  过账或付款，删除不影响真实财务记录。15 条采购单的 GoodsReceipt 均为 0 条（即便部分单据状态显示
  "已收货"也没有真实收货单据，说明这些状态本身就是测试时手工点出来的，不对应真实入库）。
- createdBy 核实为真实员工账号（Jiang/johnstoneveg@gmail.com、Xiaohui、运营主管/operator@veggie.com），
  确认是业务员工在正式环境里测试采购单功能时产生的，不是攻击或误导入。

**执行方式**

删除前完整备份涉及表的全部字段（JSON 格式）：
`docs/20261003-veggie-deleted-test-quotations-backup.json`、`...-quotation-lines-backup.json`、
`...-purchase-orders-backup.json`、`...-purchase-order-lines-backup.json`、`...-vendor-bills-backup.json`。

单条事务执行（SSH 到 droplet，`sudo -u postgres psql`）：先删 `VendorBill`（避免外键冲突），
再删 `PurchaseOrder`（级联 `PurchaseOrderLine`/`GoodsReceipt`），最后删 `Order`（级联
`OrderLine`/`OrderAdjustment`/`OrderDiscrepancy`/`OrderAuditLog`/`DeliverySlip`）。

**技术观测（我负责）**

| 项 | 结果 |
|---|---|
| 删除事务 | ✅ `DELETE 8`(VendorBill) / `DELETE 15`(PurchaseOrder) / `DELETE 5`(Order)，COMMIT 成功 |
| 删后核验 | ✅ 两张表按原单号/编号再查，`count(*) = 0` |
| 备份文件 | ✅ 5 个 JSON 文件已存档在 docs/，删除前的完整字段快照，可用于恢复或审计回查 |
| 远程临时文件清理 | ✅ droplet `/tmp` 下的 SQL 脚本与 JSON 备份已清除，不残留生产主机本地 |

**定性观测（用户/客户负责）**

请在生产上分别打开 报价单列表(Cancelled 筛选) 和 采购单/询价单列表，确认这 5 条报价单、15 条采购单
已经看不到了，且其余正常单据未受影响。

**状态**：技术侧已达成（删除前核实+事务执行+删后核验+备份存档）；定性侧待用户在生产上过一遍确认
