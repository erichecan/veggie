# 打印：按商品 sequence 排序 + 提高每页行数 —— 设计与台账

> 客户提出两条：①打印时按 sequence 排序 ②一页尽可能多打印行数，至少 20 行。
> 决策日期：2026-08-18

---

## 一、生产实测到的事实（2026-08-18，只读查询）

### 1.1 ⛔ 根因不是"排序规则选错了"，是行序号根本没值

```
多行订单总数        132,847
其中行序号全一样    102,898  (77.5%)
```

现在订单/发票 PDF 是按 `OrderLine.sequence` 排的（`app/api/orders/[id]/pdf/route.ts:14`），
而 **77.5% 的多行订单里这个字段所有行都是同一个值**（客户给的 D154111 整单都是 10）。
排序键全等 = 没有排序，最终顺序由数据库返回顺序决定，同一张单两次打印都可能不同。

客户看到的"乱序"是这么来的，不是因为选了错的排序字段。

### 1.2 商品 sequence 的覆盖率

```
Product ↔ ProductTemplate 配对   5,477
两份 sequence 不一致                  1   ← 可忽略，两份是同步的
Product.sequence 为空             3,759  (69%)
ProductTemplate.sequence 为空     3,758  (69%)

订单行总数                    1,337,596
其中拿不到商品 sequence         245,649  (18.4%)
```

商品主数据有 69% 没有 sequence（有值的那 1,718 个正是 Odoo 导入的那批），
但**实际被下单的行里只有 18.4% 缺**——常卖的商品基本都有。

⚠️ 结论：光"按 sequence 排"不够。那 18.4% 的行 sequence 为 NULL，必须给它们一个
**稳定且可预期**的次级顺序，否则单内仍然会乱，客户会说"还是没排好"。

### 1.3 `Product.sequence` 与 `ProductTemplate.sequence` 是两份

商品列表页显示与编辑的是 **Template** 那份；日报打印排序用的是 **Product** 那份
（`lib/print/day-wise-report-loader.ts:57`）。实测只有 1 行不一致，暂不构成问题，
但属于双存储，记入待办（见第五节 D-2）。**本次统一取 Template 那份**——
它才是人在商品页上编辑的那个值，客户调顺序时改的也是它。

### 1.4 每页行数实测（用真实长度的商品名）

| 行数 | 页数 | 说明 |
|---|---|---|
| 10 | 1 | 客户第一张截图那种，占半页 |
| 20 | 2 | **第 19 行就溢出** |
| 40 | 2 | 第 1 页约 19 行 |
| 60 | 3 | 约 20 行/页 |

同时发现两个没人报过的毛病：
- **页脚压在正文上**：第 1 页底部 "Tel:… | Page 1/1 | Printed:…" 与最后一行商品重叠
- **页码是写死的**：两页的单子页脚也印 "Page 1/1"

---

## 二、已拍板的决策

| # | 决策 | 选择 |
|---|---|---|
| P-1 | sequence 指哪个 | **商品的 sequence**（商品列表里那列，Odoo 目录/拣货顺序），取 `ProductTemplate.sequence` |
| P-2 | 覆盖范围 | **所有单据打印** |
| P-3 | 每页行数 | 压行高，目标 **26–30 行/页**，并修掉页脚压行与假页码 |

### 由实测事实追加的两条设计决定

| # | 决定 | 理由 |
|---|---|---|
| P-4 | 排序规则统一为 **`sequence 升序（NULL 排最后） → 商品名 A→Z`** | 18.4% 的行没有 sequence，不给次级键的话这些行的顺序仍然随机。商品名是人眼可预期的，比"数据库返回顺序"强 |
| P-5 | **不改 `OrderLine.sequence` 的写入逻辑** | 打印改按商品 sequence 后就不再依赖它。修它属于另一件事（且要动下单/导入多条路径），记入待办 D-1 |

---

## 三、改动面盘点

| 打印入口 | 模板 | 行排序现状 | 本次改动 |
|---|---|---|---|
| 销售单 / 发票 / 采购单 PDF | `lib/order-pdf.ts` | 传入顺序（= OrderLine.sequence，77.5% 无效） | 排序 + 密度 |
| 发票页面打印 | `operator/invoices/[id]/print/page.tsx` | JSON 行原序 | 排序 + 密度 |
| 单据打印页 | `print/[id]/page.tsx` | 传入顺序 | 排序 + 密度 |
| 批量打印 | `print/batch/page.tsx` | 同上 | 排序 + 密度 |
| 配送四单 | `lib/print/dispatch-print-html.ts` | 见实现 | 排序 + 密度 |
| 行程送货单 | `lib/print/trip-delivery-template.ts` | 见实现 | 排序 + 密度 |
| 行程销售单 | `lib/print/trip-sales-template.ts` | 见实现 | 排序 + 密度 |
| 行程收据 | `lib/print/trip-receipt-template.ts` | 见实现 | 排序 + 密度 |
| 行程汇总 | `lib/print/trip-summary-template.ts` | 商品名 A→Z | 排序 + 密度 |
| 行程拣货单 | `lib/print/trip-picking-template.ts` | 商品名 A→Z，**分大货/散货两组** | ⚠️ 只改组内顺序，**保留分组**——这是仓库作业习惯，不动 |
| 日销售报表 | `lib/print/day-wise-report-template.ts` | 已有「按 sequence 排序」勾选项 | 口径对齐（默认值待定，见 T7） |
| 价格表打印 | `print/pricelist/page.tsx` | 已按 sequence | 只做密度 |

---

## 四、实施台账

> 一周期一条：做 → 验证 → 提交 → 回写状态。
> 验收一律要**实际渲染出 PDF/页面数行数、核对顺序**，不能只看代码改完了。

- [x] **T1 共用排序工具** `bea744a`
      验收：单元测试覆盖 —— 有 sequence 按升序；NULL 排最后；NULL 之间按商品名 A→Z；
            sequence 相同的按商品名；空数组/缺字段不炸
      产出：`lib/print/line-sort.ts`（纯函数，不依赖 Prisma）+ `tests/print-line-sort.test.ts`
      依赖：无

- [x] **T2 商品 sequence 取数** `bea744a`
      验收：对同一批 productId，返回的 sequence 与商品页显示的一致；
            商品不存在/已删时不报错（视为 NULL）
      产出：`lib/print/product-sequence.ts`（按 productId 批量查 Template.sequence，一次查询）
      依赖：无

- [x] **T3 销售单/发票/采购单 PDF（客户直接看到的，优先）** `bea744a`
      验收：拿 D154111 的行渲染，顺序 = sequence 升序 + NULL 在后按名称；
            与改动前的顺序做 diff 并人工确认合理
      产出：`lib/order-pdf.ts`、`app/api/orders/[id]/pdf/route.ts`、
            `app/api/orders/[id]/send-email/route.ts`、采购单两处
      依赖：T1 T2

- [x] **T4 密度改造** `1d67521` `e2092e4`
      验收：用真实长度商品名实测 —— 20 行必须 1 页；30 行 ≤ 2 页；
            页脚不与正文重叠；页码显示真实页数（不再是写死的 1/1）
      产出：`lib/order-pdf.ts` 的 CSS + 页脚、`scripts/print/measure-lines-per-page.ts`
      依赖：T3
      实测（真实长度商品名，4/6 需折两行）：
      | 行数 | 改造前 | 改造后 | 每页行数 |
      |---|---|---|---|
      | 10 | 1 页 | 1 页 | 10 |
      | 20 | **2 页** | **1 页** | 20 |
      | 30 | 2 页 | 2 页 | 26 / 4 |
      | 40 | 2 页 | 2 页 | 28 / 12 |
      | 60 | 3 页 | 3 页 | 32 / 27 / 1 |
      首页容量 26–32 行，客户要的「至少 20 行」达成。
      改造过程中踩到并写进注释的两个坑：页面 padding-bottom 只在文档末尾生效
      （所以 fixed 页脚必然压正文）；把页脚用负 bottom 塞进 @page 边距会让 Chrome
      多开一整页空白。最终形态：@page 管每页边距 + 页脚做成与汇总绑定的尾块。
      ⚠️ 遗留：25 行那一档仍会把「汇总+页脚」挤到第 2 页（首页塞满 25 行）。
      优先塞行是客户的明确要求，故接受。

- [ ] **T5 发票页面打印 + 单据打印页 + 批量打印**
      验收：三个页面各渲染一次，顺序与 T3 一致；每页行数达标
      产出：`operator/invoices/[id]/print/page.tsx`、`print/[id]/page.tsx`、`print/batch/page.tsx`
      依赖：T1 T2 T4

- [ ] **T6 配送四单 + 行程五单**
      验收：逐个渲染核对；**拣货单的大货/散货分组必须保持**，只有组内顺序变
      产出：`lib/print/dispatch-print-html.ts`、`trip-*.ts` 五个模板及其 loader
      依赖：T1 T2 T4

- [ ] **T7 日报口径对齐**
      验收：勾选项行为不变；与其它单据的排序规则一致（NULL 处理相同）
      产出：`lib/print/day-wise-report-template.ts`
      依赖：T1
      ❓待定：其它单据都默认按 sequence 了，日报的勾选项是否也改成默认勾上？
          默认值一改，所有人下次打开看到的顺序就变了 —— 需要问客户

- [ ] **T8 回归 + 报告**
      验收：每个打印入口出一份样张，列表记录「行数 / 页数 / 首行末行」；
            `npm run build`、`npm run lint`、全量单测通过
      依赖：T1–T7

---

## 五、后续待办（本次不做）

- [ ] **D-1 `OrderLine.sequence` 写入缺陷**：77.5% 的多行订单行序号全等，说明某些
      创建路径（批量导入 / 复制订单 / 合并）没有给行分配递增序号。打印改按商品
      sequence 后不再受影响，但**订单详情页、编辑页、拣货界面仍按行序显示**，
      那里的顺序同样是随机的。要修得动下单与导入多条路径，单独立项。
- [ ] **D-2 `Product.sequence` 与 `ProductTemplate.sequence` 双存储**：实测只差 1 行，
      暂不痛，但两处都能写就迟早分叉。归入数据所有权审计的既有清单。
- [ ] **D-3 商品主数据 69% 没有 sequence**：这是数据活不是代码活。客户若希望打印
      完全按目录顺序，需要在商品页把常用商品的 sequence 补齐；否则那部分会落在
      末尾按名称排。**这一条要明确告诉客户**，不然改完仍会觉得"没按我要的排"。
