# 打印单据评审后 6 项改动 · 执行台账

计划见根目录 `DEV-PLAN.md`。用户 20260920 确认，发票号选 **方案 B（从 V59086 接着排）**。

> ⚠️ 方案 B 的前提未被验证：用户未回答「Odoo 是否仍在开票」。
> 若 Odoo 仍在发 V 号，本方案会撞号。缓解措施：发号走事务 + `Invoice.name` 唯一约束，
> 撞号即报错不静默；号段起点做成常量，改起点只需改一行。

## 交付单元

- [x] **T1 删除客户签收单 POD**
      验收命令：`grep -r generateTripReceiptHtml app lib components tests | wc -l` = 0；
      `npx tsc --noEmit`；路由 `/classic/print/trip/*/receipt` 返回 404
      ⛔ 不得触碰 `lib/trip-signature.ts` 与 signature-correction 链路（司机端签字写入）
      ⛔ 不得删 `lib/print/trip-loader.ts`（3 个 PDF 路由在用）
      证据：全仓 generateTripReceiptHtml 引用 0 处；receipt 路由目录已删；tsc 0 错；
      print-gift-mark 测试 10/10 通过；反向断言 trip-loader(9 处调用)/trip-signature 均完好
      依赖：无

- [x] **T2 删除老板销售报表三个打印按钮**
      验收命令：`grep -n openPrintWindow app/\[locale\]/classic/boss/sales-report/page.tsx` = 0；
      反向断言 `lib/print-export.ts` 仍被 ChatEntryView 引用
      证据：页面内 openPrintWindow 引用 0 处，删掉 4620 字节；
      ChatEntryView.tsx:5/81/106 仍在用 print-export，未误删；exportCsv/filtered/预览表保留
      依赖：无

- [x] **T3 删除波次拣货单（旧版）**
      验收命令：`grep -n handlePrint app/\[locale\]/classic/operator/waves/\[id\]/page.tsx` = 0；
      反向断言 sorting/sorter 页面仍可编译（Wave.zones 未动）
      证据：删掉 5381 字节（handlePrint + 按钮 + @media print 老路径 + printRef）；
      tsc 0 错、eslint 0 error；Wave.zones 在 sorting/sorter 3 个文件中仍在用
      依赖：无

- [x] **T4 修 PAYMENT 栏：数据 + 模板**
      T4a 备份 19 条 phone 原值到文件（不可逆操作前置条件）
      T4b 按性质分类迁移：送货指令→externalNote，模糊值→notes，无意义→清空
      T4c 模板改造：PAYMENT 栏不再印电话；补上 COD / 30 Net Days / 15 Days / bimonthly 显示
      验收命令：生产库断言 `Customer.phone` 不再有「完全不含数字」的记录；备份文件可还原
      证据：
      - 备份 `backups/phone-backup-20260920.csv`（19 条，含 phone/externalNote/notes 原值）
      - 生产执行：对外备注 6 · 内部备注 8 · 清空 1 · 空白清理 4 · 计划外 0；幂等复跑 0 条
      - 独立查库复核：脏值 0 条；6 条送货指令完整落在 externalNote；
        Orchid Garden-M7 原有「雅丽阁」被保留为追加而非覆盖
      - 模板：新增 `paymentTermPrintLabel`（lib/payment-terms.ts），销售单与单订单模板共用；
        PAYMENT 栏不再印 phone（连带去掉 `?? order.internalNote` 这个会把**内部备注**
        印给客户的回退）；渲染实测 COD 客户印出「货到付款 COD」红字，password 残留 0
      依赖：无

- [x] **T5 发票打印页 + 详情页支持两种行结构**
      验收命令：Odoo 结构发票打印页 200 且无「页面出现错误」；商品明细结构同样 200；
      详情页两种结构都不出现「空商品名 + €0.00」行
      证据：
      - 新增 `lib/types.ts` 的 `InvoiceOrderLine` + `isInvoiceOrderLine` 判型，
        `Invoice.lines` 改成联合类型 —— 借编译器把所有要改的地方逼出来（10 处）
      - 新增 `lib/invoice-lines-view.ts` 归一两种结构，打印页与详情页共用，避免两边各写一套
      - 实测真实 Odoo 历史发票 V59085（原来崩 500 的那张）：打印页正常渲染，
        表头「销售订单/金额」，印出 D154665 €26.95，汇总 €33.16 正确
      - 实测商品明细结构（样例发票）：保持七列，数据完整，无报错
      - 详情页同一张 V59085：原来的「空商品名 + €0.00」行已变成正确的订单号与金额
      - `GET /api/invoices/[id]`：按订单记的发票跳过两次无效的 sequence 回查
      依赖：无

- [x] **T6 销售单号改 Invoice No. + V 序列发号**
      验收命令：同一订单重复打印号不变（幂等）；并发 20 单无重号；号 ≥ V59086
      证据：
      - schema 加 `Order.invoiceNo`（UNIQUE）+ 手写迁移 20260920000001_order_invoice_no
      - `lib/invoice-number.ts`：号池 = Invoice.name ∪ Order.invoiceNo，发号避开两者
      - ⚠️ 并发实测踩了两个坑并修掉：
        (1) Prisma 7 走 driver adapter 时唯一约束冲突包成 DriverAdapterError，
            外层 code 不是 P2002 —— 只判 P2002 会把可重试冲突当致命错误抛出；
        (2) 纯乐观重试在 20 路并发下被打爆 → 改用 pg_advisory_xact_lock 串行化发号
      - 测试结果：幂等 3 次一致 ✓ / 号段 ≥V59086 ✓ / 20 路并发 20 个不同号 ✓ /
        与 Invoice 表零冲突 ✓ / 批量调用号不变 ✓
      - 端到端：不带 doc=sales 不发号、带了才发、重复调用号不变（API 实测）
      - 纸面实测：7 张单全部印「Invoice No.」+ V59162~V59168，「Sale Order NO」残留 0
      - 只有销售单发号，拣货单/送货单/汇总单不消耗号段
      依赖：T5（共用发票号查询逻辑）

## 周期记录

6/6 全部完成（20260920）。

### 整体验收
- `npx tsc --noEmit`：0 错
- `npx eslint`（全部改动文件）：0 error
- `npx tsx --test tests/*.test.ts`：920 个用例，917 通过，1 失败
  —— 该失败（pricing-override「不传覆盖时使用客户档案默认价格表」）**改动前同样失败**，
  已用 git stash 回到原始代码复验确认，非本次引入

### 尚未做的事（需要用户决定）
1. **代码还没提交、没部署**。生产上目前只有 T4 的数据修复（那是直接改库）。
   模板与发票号改动要等 git push 走 Actions 才会上线。
2. **迁移还没在生产应用**：`prisma/migrations/20260920000001_order_invoice_no`
   会在部署时由 migrate deploy 执行。
3. **Odoo 是否仍在开票仍未确认** —— 方案 B 的前提。若 Odoo 在发 V 号，
   把 `lib/invoice-number.ts` 的 SERIES_START 挪到 90000 即可。
