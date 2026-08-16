# Neon 演示数据脱敏改造 —— 任务台账

> 目标：把 Neon 库（08-05 冻结生产副本）改造成可公开展示的演示数据集，
> 供 1688 招商宣传使用。已与客户签保密协议，**演示站不得出现任何真实客户身份信息**。
>
> 载体：现存的 Cloud Run 服务 `veggie`（europe-west1，跑 8-02 镜像）+ Neon 库。
> 20260816 实测：页面 200、登录 401、`/api/customers` 匿名 401 —— 这套环境活着且鉴权正常，
> 旧镜像与 Neon 旧 schema 自洽（本地代码已领先 13 个迁移，与本任务无关）。

## 用户已拍板的决策（20260816）

| 决策点 | 选择 |
|---|---|
| 动手前先备份 | dump 到本机 + 顺便配 DO Spaces 补容灾缺口 |
| 演示站品牌名 | 用通用假名，由我拟 |
| 商品名称 | **保留真实品名**（洋葱/土豆/包菜是行业通用词，不构成身份泄露）；供应商信息与成本价仍要换 |

## 不可妥协的前提

⛔ **T1 完成前不得对 Neon 做任何写操作。**
生产备份 12 份 975MB 全在 droplet 的 `/dev/vda1`，与 PostgreSQL 同盘；`BACKUP_DRIVER=local`，
DO Spaces 至今未配。Neon 是**目前唯一一份不在那块盘上的数据副本**
（依据 `docs/20260805-disaster-recovery-plan.md:138`，20260816 复查仍成立）。

⛔ **不做「每表留 50 条」**。该库有 39 个外键：`OrderLine` 只留 50 行会让 149,876 个订单
几乎全部变空单，订单的 `customerId` 也大概率指向已删客户。改为**按引用闭包抽样**。

⛔ **「微调」不等于脱敏**。客户名/联系人/电话/邮箱/地址/税号/信用额度/提成率必须整体替换，
不是改几个字。员工真实姓名邮箱同样要换。

## 任务

- [x] **T1 全量 dump Neon 到本机** —— 20260816 完成
      实测：`~/veggie-neon-backup-20260816/veggie-neon-20260816.dump`，82MB，48 张表；
      `OrderLine` 解出 1,337,606 行 vs 源库精确 `count(*)` 1,337,571（差 35 行为 COPY 语句开销）。
      端点坑已证实：必须去掉 `-pooler` 用直连端点，pooler 不支持 pg_dump。
      ⛔ 该目录在仓库外，含全量真实 PII，**绝不入库**。
      验收：dump 文件存在且 `pg_restore -l` 能列出 48 张表；行数抽样比对
      （`OrderLine` 1337046、`Order` 149876、`Customer` 1605）与源库一致
      产出：`~/veggie-neon-backup-20260816/`（放仓库外，绝不入库）
      依赖：无 —— ⚠️ 必须用**直连端点**（去掉 `-pooler`），pooler 不支持 pg_dump

- [x] **T2 盘点 PII 字段** —— 20260816 完成，见下方「PII 字段矩阵」
      验收：产出字段清单，覆盖 `Customer`/`User`/`ProductSupplierInfo`/`Order`(备注)/
      `DeliverySlip`/`Invoice` 等所有含真实身份信息的列；每列标注处理方式（替换/扰动/保留/清空）
      产出：本文件追加一节「PII 字段矩阵」
      依赖：T1

- [x] **T3 设计并验证闭包抽样** —— 20260816 完成，用户选定近 1 个月窗口

      **锚点定义**：时间窗内有订单的客户按订单数降序，取第 11–60 名（跳过前 10 大客户，
      避免单个客户吃掉大部分数据量），共 50 个客户 → 连带其订单 → 订单行 → 发票/贷记单/送货单。

      **dry-run 报数（20260816 实测，纯 SELECT 未写库）**：

      | 时间窗 | 订单 | 订单行 | 发票 |
      |---|---|---|---|
      | 近 1 个月（≥06-21） | 544 | 4,181 | 468 |
      | 近 2 个月（≥05-21） | 1,289 | 10,976 | 1,216 |
      | 近 3 个月（≥04-21） | 2,052 | 17,306 | 1,996 |

      对比原始：149,876 单 / 1,337,571 行 —— 3 个月方案约占 1.4%。

      ⚠️ **结构坑（抽样脚本必须处理）**：
      - `Order.restaurantId` → `Customer` **没有外键约束**，删客户不会被数据库拦住，
        悬空引用不会报错只会在页面上显示空白 —— 必须自己写校验。
      - 三个数组/JSON 列内嵌引用：`Invoice.saleOrderIds`、`PickingWave.orderIds`、
        `Trip.restaurants`（可能内嵌餐厅名）、`Order.items`（腐化双存的明细快照）。
      - `DailyBusinessSnapshot`(146 行) 是聚合的真实营业额，抽样后必然与新数据对不上 → 清空重算。

      产出：`scripts/demo/build-demo-subset.sql`（待写）
      依赖：T1 ✅

- [x] **T4 执行抽样删除** —— 20260816 COMMIT，用户选定「近 1 个月」窗口（win=2026-06-21）
      实测结果：Customer 1605→**59**（50 锚点 + 9 采购侧供应商）、Order 149876→**544**、
      OrderLine 1337571→**4181**、Invoice→**468**、CreditNote→**19**、DeliverySlip→**20**、
      PickingWave→**12**、Trip→**1**；ProductTemplate 5482 与 User 51 全保留。
      4 项悬空自检全 0。
      踩到的坑：发票/贷记单只按 customerId 删会把这批客户**全部历史**发票留下
      （实测 24,755 张 vs 544 单），必须同时卡时间窗。
      产出：`scripts/demo/build-demo-subset.sql`

- [x] **T5 脱敏改写** —— 20260816 COMMIT，7 项自检全 0，独立复核无中文/非 ASCII 残留
      产出：`scripts/demo/anonymize.sql`
      三个非做不可的修正（每个都是实测撞出来的，不是预想）：
      1. **人名必须按「原名字符串」映射，不能按 userId** —— DriverSlot 70 条只对应 13 个 user
         （同一人同档期多个 slot），按 userId 映射会撞 `(timeOfDay,batchNum,driverName)` 唯一约束；
         且其中 **5 条 slot 的 userId 是空的**，按 userId 根本覆盖不到，真名会留在库里。
      2. **jsonb 里的 `Trip.restaurants[].restaurantName` 要用 INNER JOIN** —— 用
         「匹配不到就保持原样」的 LEFT JOIN 会把指向已删客户的真名留下（实测残留 1 条）。
      3. `externalId`/`email` 等派生值要用**全局序号**，按 isCustomer 分区的序号会让
         客户与供应商各出一个 rn=1，撞 `Customer_externalId_key`。
      ⚠️ **金额未做扰动**（见下方「未决」）。

- [x] **T6 演示站逐页验证** —— 20260816 完成，并因此抓出 6 处脚本自检漏掉的泄露
      实测：`operator@demo.local` 登录成功；`/api/orders` `/api/customers`
      `/api/product-templates` `/api/invoices` 全 200，数字与库一致（544/59/5482/468）；
      订单列表、客户列表、运营控制台三页浏览器实看，无 500、无空页。

      ⚠️ **只跑脚本自检会漏掉东西 —— 这次 7 项自检全绿，但页面上仍印着真名：**
      1. `OdooPricelist.name`（95 条）**就是按真实餐厅命名的**（MUSASHI、MOMOYA ASIAN、
         LEMON TREE、Wings…），在客户列表的「价格表」列直接显示。
      2. 同一批名字还冗余进了 `OrderLine.priceSourceDetail`（140 行 / 21 个不同值）。
      3. `GoodsReceipt.receivedBy`(23)、`StockTake.createdBy`(2)、
         `PickingWave.pickLockedBy`(1) 存的是员工真名。

      **补救手段（比逐列盘点可靠得多，建议以后照做）**：从 T1 的 dump 里提取全部
      1,580 个真实客户名/员工名装进临时表，对全库 **635 个文本列 + 2 个 jsonb 列**
      做精确比对反查。最终结果：**零残留**。
      修复时用 dump 重建 `id → 原名` 映射，把残留值精确映射到已生成的假名，
      而不是粗暴替换成占位符。

- [ ] **T8 演示站品牌字样（新发现，需用户决策）**
      ⛔ 品牌**硬编码在代码里，不在数据库** —— 改库解决不了：
      | 位置 | 内容 |
      |---|---|
      | `app/[locale]/classic/print/[id]/page.tsx:112,221` | 发票/订单 PDF 抬头、真实电话、邮箱、网址、**VAT IE9739451J** |
      | `app/[locale]/classic/print/pricelist/page.tsx:81-98` | 价格表打印抬头同上 |
      | `app/[locale]/classic/print/day-wise-report/page.tsx:26` | 日报公司名 |
      | `app/[locale]/classic/operator/place-order/page.tsx:133,241` | 下单页 logo 与页脚 |
      | `lib/email.ts:11,186,189` | 邮件发件人与正文 |
      | `lib/seed-pricelists.ts:88` | 种子里一条名为 "Johnstone" 的价格表 |

      难点：演示站跑的是 **8-02 的镜像**，而当前代码已领先 13 个迁移，
      直接部署 main 会与 Neon 的旧 schema 不兼容（登录必 500，已实测）。
      要改就得从 8-02 那个 commit 拉分支、只替换品牌串、单独部署。

- [ ] **T7 DO Spaces 异地备份**
      验收：生产 `BACKUP_DRIVER=s3`，跑一次备份并确认对象出现在桶里
      依赖：⛔ 需用户提供 DO Spaces key（项目中没有配置）—— 不阻塞 T1–T6

## PII 字段矩阵（T2 产出，20260816 实查 Neon）

### 最容易漏的两点

1. **客户名在 7 个地方冗余存了快照**，不是只有 `Customer.name`。只改主表的话，
   发票 PDF、送货单、贷记单上仍会印真名：
   `Order.restaurantName`、`Invoice.customerName`、`CreditNote.customerName`、
   `DeliverySlip.customerName`，员工名同理散在 `Order.createdByName`/`printedByName`、
   `Trip.driverName`、`DriverSlot.driverName`、`ActionLog.userName`。
2. **`Customer.latitude` / `longitude` 是真实经纬度** —— 能直接在地图上定位到客户店址，
   比名字更硬的身份信息。必须清空或整体平移。

### 处理表

| 表.列 | 内容 | 处理 |
|---|---|---|
| `Customer.name` | 真实商户名（`isCustomer`/`isVendor` 两类共用此表，**供应商名也在这里**） | 整体替换 |
| `Customer.address` / `street` / `street2` / `city` / `state` / `zip` | 真实地址 | 替换为虚构都柏林地址 |
| `Customer.latitude` / `longitude` | 真实坐标 | 清空或统一平移 |
| `Customer.phone` / `email` / `vatNumber` | 联系方式 / 税号 | 替换（VAT 保持 `IE` 格式） |
| `Customer.creditLimit` / `commissionRate` / `commissionFixed` | 商业条款 | 扰动 |
| `Customer.notes` / `externalNote` | 自由文本 | 清空 |
| `Customer.externalId` | Odoo 原始 id，可与客户旧系统关联 | 重新编号 |
| `User.name` / `email` | 51 个真实员工 | 替换 |
| `Order.restaurantName` / `createdByName` / `printedByName` | 姓名快照 | 跟随主表同步改 |
| `Order.internalNote` / `externalNote` / `deliveryNote` | 自由文本（填充率极低：58/8/1） | 清空 |
| `Invoice.customerName`、`CreditNote.customerName` / `notes`、`DeliverySlip.customerName` | 姓名快照 | 同步改 / 清空 |
| `Trip.driverName` / `settlementNote`、`DriverSlot.driverName` | 司机姓名 | 同步改 / 清空 |
| `ProductSupplierInfo.productName` | 可能含供应商品牌 | 替换 |
| `PurchaseOrder.notes` / `sourceDocumentName`、`VendorBill.notes` | 自由文本 | 清空 |
| `ActionLog`（含 `userEmail`/`userName`/`detail`/`ipAddress`）、`Notification` | 操作日志，最易藏 PII 且演示价值低 | **整表清空** |
| `Account.name` / `nameZh` | 会计科目名，行业通用 | 保留 |
| `ProductTemplate.name` / `Product.name` | 商品名 | **保留**（用户决策：行业通用词） |

### 金额扰动的约束

⛔ 不能随手改金额 —— `OrderLine` 小计、`Order` 总额、`Invoice` 金额三者必须恒等，
乱改会让演示站的账对不上（比不脱敏更显眼）。做法：给每个商品分配一个固定系数
（如 0.87–1.13），改 `unitPrice` 后**重算整条派生链**。
因此顺序必须是**先抽样（T4）后脱敏（T5）** —— 全量 133 万行重算不现实，
抽样后只剩几千行才可行。

## 进度

（每完成一条回写 `- [x] Tn ... [commit]`）
