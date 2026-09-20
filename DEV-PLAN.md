# DEV-PLAN：打印单据评审后的 6 项改动

## 读取的文档

无独立产品文档。需求来自 20260920 对话中对打印模板评审页 6 个问题的逐条答复：

> 1. 销售单上的单号该印什么？沿用旧的发票号，和系统里已经有 14.8 万张发票记录，号码是 V59085 这种格式，保持一致。
> 2. 销售单的 PAYMENT 栏印出了 "password"。（第 3 张单）这是客户资料里的付款方式字段被填错了，不是模板的问题。请去修改了。
> 3. 财务的发票行是按「订单」记
> 4. 拣货单有两套。（第 1 张和第 17 张）保留一套按商品汇总
> 5. 签收单去掉
> 6. 老板销售报表去掉

配套背景：`docs/20260919-print-templates-preview-tasks.md`（评审页台账）

---

## 模块拆解

### M1 · 销售单单号改 Invoice No.（最复杂的一项）

**现状**：销售单表头第 2 格印 `Sale Order NO` + 订单号（如 MJ-260913-002）+ 条码。
涉及两套模板：`lib/print/trip-sales-template.ts:147`（批量打印）与
`app/[locale]/classic/print/[id]/page.tsx`（单订单打印，doc=sales）。

**要做的**：标签改 `Invoice No.`，号码改成 V 序列。

**必须先解决的问题 —— 谁在发号**：

| 事实 | 数值 | 含义 |
|---|---|---|
| V 序列总数 | 25,223 张 | |
| 号段范围 | V1 ~ V59085 | |
| **断号数量** | **33,862 个** | 号段跨度 59,085，实际只有 25,223 张 |
| 最新一张 | V59085（2026-07-13，客户 "TEST TEST"） | 像测试单 |
| 真实业务最后一张 | V59084（2026-07-10） | |
| 7-13 之后新增 | 1 张（就是那张 TEST TEST） | |

断号 33,862 个说明 **V 号不是这套系统发的，是 Odoo 发的**，我们只导入了其中一部分。
因此如果 Odoo 12 现在仍在开票，新系统从 V59086 往下发号 **必然与 Odoo 撞号**——
同一个号会出现在两张不同的发票上，会计对账时无法分辨。
`Invoice.name` 有 unique 约束，但那只拦得住本系统内部重复，拦不住 Odoo 那边。

**三个发号方案（需要你选）**：

- **方案 A（推荐）**：V 号从一个远离 Odoo 的安全区间起排，例如 **V90000**。
  格式仍是 V#####，与旧号一致；但号段不重叠，Odoo 继续开它的 V59086+ 也不会撞。
  代价：号段上看得出「这是新系统开的」。
- **方案 B**：从 V59086 接着排。号段连续好看，但只要 Odoo 还在开票就会撞号。
  仅在「Odoo 已经完全停止开票」时才安全。
- **方案 C**：系统不自动发号，留空白栏由财务手写/回填 Odoo 开出的号。改动最小，但客户
  拿到的单子上没有号，达不到「直接交给会计进账」的目的。

**发号时机（我的假设，见下方假设清单）**：第一次打印销售单时分配并固化到订单上，
之后重复打印号不变；一张订单一个号，不合并多单。

---

### M2 · 修 PAYMENT 栏印出 "password"

**你的判断需要更正**：这不是付款方式字段，是 **`Customer.phone`（电话）字段**。

销售单 PAYMENT 格印两行（`trip-sales-template.ts:160-163`）：
第一行付款方式，第二行**直接印客户电话**。818 Cake Studio D13 的付款方式是 COD、
电话字段被填成了 "password"，于是印成「— / password」。

**同类问题共 19 条**，而且大部分不是脏数据，是**没有合适字段可放、被迫塞进电话栏的送货指令**：

| 客户 | phone 字段内容 | 我的判断 |
|---|---|---|
| Dingding | `Dont Collet Any Money of This Order！！` | 真实业务指令 |
| V Food Shop / V Food Warehouse | `务必当场检查` | 真实业务指令 |
| Ocean Blue River Ltd D1 | `bring the key back to supermarket` | 真实业务指令 |
| Lams Chinese Takeaway | `back door` | 真实送货位置 |
| Slice & Spice | `Next to Surpervalu, Front door` | 真实送货位置 |
| JG-M1 / Joyous Garden / OG-Cashel / Orchid Garden | `ALL BEST` | 看不出含义 |
| 818 Cake Studio D13 | `password` | 看不出含义 |
| ABC Restaurant Ltd | `与韩国海军` | 看不出含义 |
| Dublin Christ Life Church | `Donation` | 看不出含义 |
| JUJUBE ASIAN LTD / Aromance catering | `Tide Wok` / `yummy yaki` | 像是店铺别名 |
| 其余 4 条 | 空白字符串 | 直接清空 |

直接清空会丢掉「别收这单的钱」「务必当场检查」这类真实指令，所以这一条我不自作主张，
需要你逐条给处置方式（清空 / 迁到送货备注 / 保留）。

**连带发现（同一块模板的另一个问题）**：付款方式只认 `cash/weekly/monthly`
（`trip-sales-template.ts:91`），而生产库有 **37 个 COD 客户**。COD = 货到付款，
恰恰是最该在单子上提醒司机收钱的，现在全部印成「—」。建议一并补上 COD 及
`30 Net Days` / `15 Days` / `bimonthly` 的显示。

---

### M3 · 发票打印页改「按订单记」

**现状**：`invoices/[id]/print/page.tsx:190-194` 裸调 `line.unitPrice.toFixed(2)` 等，
对生产数据直接抛 undefined → 500。

**关键事实 —— 库里是两种结构混存**：

| 来源 | 结构 | 数量 |
|---|---|---|
| Odoo 迁移脚本（一次性，`scripts/import-odoo-invoices-20260718.ts`） | `{amount, orderId, orderCode}`（按订单） | 14.8 万张历史 |
| **现在线上两条活的开票路径**（`api/invoices/route.ts` POST、`lib/invoice-from-order.ts`） | 商品明细（productName/qty/unitPrice/...） | 新开的发票 |

也就是说：**系统现在开出来的新发票是按商品明细记的**，只有 Odoo 导入的老发票是按订单记的。

因此「发票行按订单记」有两种做法，需要你确认是哪一种：

- **做法 1（推荐，改动小）**：只改显示——打印页和详情页**按数据实际结构自适应**，
  老发票按订单显示，新发票按商品明细显示。修好 500，不动开票流程。
- **做法 2（改动大）**：连开票逻辑一起改，以后新开的发票也按订单存。
  这会改变 `lib/invoice-from-order.ts` 的写入结构，并影响 `writebackInvoicedQty`
  （回写已开票数量依赖行级 `orderLineId`，改成订单级后只能整单回写，精度下降）。

**顺带**：`app/api/invoices/[id]/route.ts:20-32` 对 Odoo 结构的行做了两次数据库回查
（补 productSequence/uomSequence），参数全是 undefined，产出全 null —— 纯浪费，一并清掉。

**容易漏改的地方**：发票**详情页**（非打印页）`invoices/[id]/page.tsx:254-267` 每个字段
都有 `?? 0` 兜底，所以不崩，但会渲染成一排「空商品名 + €0.00」的垃圾行。必须一起改。

---

### M4 · 删除波次拣货单（旧版），保留按商品汇总那套

**要删**：`app/[locale]/classic/operator/waves/[id]/page.tsx` 的 `handlePrint()`（L71-135）
+ 「🖨 打印拣货单」按钮（L184）+ 已经没人读的 `printRef`（L42/L194）
+ 那套 `@media print` 老路径（L167-176、L196-203）。

**不能碰**：`Wave.zones` 数据结构 —— 它是分货页（sorting / sorter）的核心数据，
另有 4 个页面 + 8 处写入在用，和打印无关。

**顺带发现**：`waves/[id]` 这整个页面**没有任何入口链接指向它**
（列表页 `waves/page.tsx` 已是 deprecated 重定向壳，layout 里的导航项是注释掉的）。
现在只能靠手敲 URL 进入。是否整页删除请你定——整页删会同时失去缺货预警面板的唯一 UI。

---

### M5 · 删除客户签收单 POD

**整删**：`lib/print/trip-receipt-template.ts`（268 行）、
`app/[locale]/classic/print/trip/[id]/receipt/page.tsx`、`tests/trip-receipt-template.test.ts`

**删片段**：`_TripPrintClient.tsx`（类型联合 + 渲染器注册）、`trips/page.tsx`（按钮 L361-368）、
`tests/print-gift-mark.test.ts`（其中一个 test）、`lib/print/doc-badge.ts`（receipt 徽章）

**⛔ 绝不能碰**：`lib/trip-signature.ts` + `/api/trips/*/signature-correction`
+ 权限点 `dispatch.trip.correct_signature` —— 那是**司机端签字写入**链路，与打印无关。
我的理解是你要去掉的是「签收单这张纸」，不是「司机签字这个功能」。

---

### M6 · 删除老板销售报表的三个打印按钮

**删**：`boss/sales-report/page.tsx` 的 `printSaleSummary()` / `printMultiLine()` /
`printOrders()` 三个函数 + 对应的三个按钮 + `openPrintWindow` 的 import。

**保留**：同页的「导出 CSV」、日期筛选、业务员多选、客户/商品筛选、预览表格。

**⛔ 不能删** `lib/print-export.ts` —— AI 问数的结果打印
（`boss/analytics/chat/_components/ChatEntryView.tsx:81,106`）还在用它。

---

## 风险点

1. **发票号撞号**（M1）：Odoo 若仍在开票，方案 B 必撞。这是本批改动里唯一会影响
   客户对外账目的风险，必须先定方案。
2. **生产数据修改不可逆**（M2）：19 条 phone 记录，清空前必须先备份原值
   （改密码/密钥前先留存原值的老教训同样适用于此）。
3. **删除功能不可逆**（M4/M5/M6）：代码在 git 里可恢复，但如果一线员工实际还在用
   签收单纸质流程，删掉会直接影响当天配送。M5 的签收单虽然数据源
   （Trip 表）自 2026-07-04 起就没有新记录，但纸质流程可能仍在用打印出来的空白表。
4. **发票结构两种混存**（M3）：一刀切改成按订单，会让新开的发票丢失商品明细显示。

---

## 附录 A：技术验收标准与 verify.sh

改动完成后，`scripts/verify.sh` 需新增/保持以下断言，退出码即结论：

```bash
# 基础门槛（已有）
npx tsc --noEmit
npm run build
npx prisma migrate status

# M1 发票号
#  - 同一订单重复打印，两次拿到的号必须相同（幂等）
#  - 并发打印 20 张订单，不得出现重复号（唯一约束 + 事务）
#  - 号段不得落进 Odoo 已用区间（按所选方案断言下界）

# M2 数据修复
#  - 断言：Customer.phone 中不再存在「完全不含数字」的记录（迁移后）
#  - 断言：备份表/文件中 19 条原值可完整还原

# M3 发票打印
#  - 对 Odoo 结构（{amount,orderId,orderCode}）的发票，打印页返回 200 且不含 "页面出现错误"
#  - 对商品明细结构的发票，打印页同样 200
#  - 发票详情页两种结构均不出现「€0.00 空行」

# M4/M5/M6 删除类
#  - grep 断言：被删的导出符号（generateTripReceiptHtml 等）全仓零引用
#  - 路由探针：/classic/print/trip/*/receipt 返回 404
#  - 反向断言：lib/print-export.ts、lib/print/line-sort.ts、lib/print/trip-loader.ts
#    仍被引用（防误删共享代码）
#  - 反向断言：Wave.zones 的分货页功能不受影响（sorting 页面 200）
```

铁律：verify.sh 不过不许写完成报告；无命令输出的条目一律标 ⚠️ 未验证。
