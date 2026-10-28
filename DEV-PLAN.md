# DEV-PLAN：退换货 5 步流程补全 + 新建「车辆检查」tab

> 上一轮「退货/报废整合」（20261027，7 个提交 `b8f42353`~`3e1e800a`）已全部合并并部署到生产
> （`git log origin/main..HEAD` 为空，确认已推送），状态机/仓库核实/销售审核/disposition 记账全部
> 完整且正确，**本轮不重建它**，只在它之上补齐用户走查后发现的缺口，并把"仓库次日验车"这一步
> 迁到一个新建的独立 tab。

## 读取了哪些文档

- 本次没有独立 PRD。来源是你口述的 5 步业务流程（多角色登录 → 司机报备退换货 → 次日仓库验车核实 →
  仓库确认后消息广场通知销售二次核实 → 销售确认后进会计核销管理，含历史订单换开新发票），
  以及你的明确指令："1,把环节 3 迁移到 inventory 下面的车辆检查 tab（新建）2,补齐上面的全部缺口
  3,开发完成后,提交并部署"。原话已存 `docs/20261028-veggie-退换货5步流程-需求原话.md`（见下方歧义清单第0条）。
- 上一轮遗留文档（只读，确认"已完成/不用动"的边界）：`DEV-REPORT.md`（上一轮完成报告）、
  `docs/20261027-veggie-退货报废整合-需求原话.md`、`docs/20260922-return-case-flow-tasks.md`。
- 本次代码调研（grep + 通读，均在本会话完成）：
  `app/api/order-returns/route.ts`、`[id]/warehouse-verify/route.ts`、`[id]/review/route.ts`，
  `app/api/trips/[id]/returns/route.ts`、`warehouse-verify/route.ts`，
  `lib/returns-engine.ts`、`lib/types.ts`（ReturnItem）、`lib/bulletin.ts`、`lib/bulletin-categories.ts`，
  `app/[locale]/classic/operator/inventory/page.tsx`、`_components/ReturnsBoard.tsx`、
  `OrderReturnDialog.tsx`、`components/warehouse/VerifyReturnDialog.tsx`、
  `_components/TripReturnReviewDialog.tsx`、
  `app/[locale]/classic/driver/trip/[id]/page.tsx`（司机端报备 UI）、
  `app/[locale]/classic/bulletin/_components/BulletinPostCard.tsx`，
  `lib/accounting/returns.ts`、`lib/rbac/page-guard.ts`、`lib/role-access.ts`、
  `lib/rbac/catalog.ts` / `prisma/seed-rbac.json`、`prisma/schema.prisma`
  （OrderReturn / BulletinPost / BulletinCategory / Invoice / InvoiceStatus）。
- 生产库只读核实（SSH）：`Trip` 表现有 78 条，全部在近 30 天内（`DRIVER_APP_ENABLED` 于 20260924
  开灯后司机端链路已经是活的，之前"Trip 恒死"的旧结论已过期并已更正到记忆库）；司机退货上报
  （`ReturnItem`）目前仅 1 条，`OrderReturn` 0 条——两条路径都还很新，本轮改动历史兼容风险低。

## 用户走查发现的 5 个缺口（逐条对应你的 5 步流程）

| 步骤 | 你说的现象 | 代码实证 |
|---|---|---|
| ① 多角色登录落地页 | 司机/销售/调度各自登录应该落到各自主页 | `lib/rbac/page-guard.ts:74 getDefaultLandingPath` 的兜底分支没有调用 `lib/role-access.ts:421 homeFor(roles[])`，多角色场景判断不完整 |
| ② 司机报备 | 照片应强制；补报几天前的退换货应有独立备注，不能跟普通原因混在一起 | `driver/trip/[id]/page.tsx:181 submitException()` 校验 `selected/reasonText/signature`，**没校验 `exceptionPhoto`**；"补报退换货"复用同一个 `reasonText` 字段，没有独立字段 |
| ③ 次日仓库验车 | 要在 inventory 页新建一个"车辆检查"tab | 现有"退换货"tab（`ReturnsBoard.tsx`）是销售审核也在用的三栏看板，不是你要的"验车"专用队列——需新建，旧 tab 不动 |
| ④ 仓库确认→消息广场→销售二次核实，三条备注独立 | 仓库确认后应自动发一条消息广场帖子；三条备注（司机/仓库/销售）应各自独立 | `BulletinPost` 目前只有 `MANUAL` 来源，没有任何代码会自动发帖；`order-returns/[id]/review/route.ts` 审核 reject 时把 `note` **覆盖写进 warehouseNote**（注释里写明是故意复用），approve 时 `note` **完全没有落库**——这是 OrderReturn 这条路径独有的 bug。Trip 路径（`ReturnItem`）本身已经是 `reason`/`warehouseNote`/`refundNote` 三个独立字段，不需要动 |
| ⑤ 会计核销管理显示异常+双重确认状态，支持换开新发票 | 核销列表要能看到"有退换货异常/仓库已确认/销售已确认"，未确认标红；历史订单要能换开新发票 | `lib/accounting/returns.ts:listReturns()` 只查 `Order.returnStatus`（纸面对账，跟退换货无关的字段），**完全不读 `OrderReturn`/`goodsReturnStatus`**；`Invoice`/`InvoiceStatus` 没有任何"换开/作废旧票"的概念 |

## 模块拆解

1. **M1 车辆检查 tab（新建）**——`inventory/page.tsx` 的 `TabKey` 加 `'inspection'`，新组件
   `_components/VehicleInspectionBoard.tsx`：只保留"待核实"这一个队列（Trip 侧复用
   `flattenPending`+`VerifyReturnDialog`，OrderReturn 侧复用 `OrderReturnDialog` 的
   `WAREHOUSE_PENDING` 分支），抽一个共享 helper（如 `buildWarehousePendingRows(trips, orderReturns)`）
   给新 tab 和旧 `ReturnsBoard.tsx` 的"待核实"列共用，避免复制 ~25 行拼装逻辑。旧"退换货"tab
   结构不变（仍是三栏，继续服务销售审核+已处理历史）。
2. **M2 登录落地页**——`getDefaultLandingPath` 兜底分支改为调用 `homeFor(roles)`。
3. **M3 司机报备强化**——① `submitException()` 加 `exceptionPhoto` 必填校验（无照片 toast 报错并
   阻止提交）；② 给"补报退换货"场景加独立的 `lateReportNote` 字段（UI 新增一个文本框，跟
   `reasonText` 分开展示、分开提交），`ReturnItem`（TS 接口，JSON 存储，免迁移）加
   `lateReportNote?: string`，仓库/销售侧的详情展示补一行显示它。
4. **M4 消息广场自动通知**——`BulletinCategory` 加 `GOODS_RETURN`；`BulletinPost` 加
   `linkUrl String?`（镜像 `Banner.linkUrl` 的现成写法）；`lib/bulletin.ts` 新增
   `createAutoGoodsReturnPost(tx, {restaurantName, productName, quantity, linkUrl})`（不走权限点，
   直接复用该文件"管理动作按角色判断、不接正式权限点体系"的既有约定）；在两条仓库核实成功路径
   （`order-returns/[id]/warehouse-verify`、`trips/[id]/returns/warehouse-verify`）verify 分支
   的事务里调用它，`linkUrl` 指向 `退换货` tab 并带 `?highlight=<id>&source=order_return|trip`；
   `ReturnsBoard.tsx` 读取这两个 query 参数，挂载时自动 `openCard` 对应记录；
   `BulletinPostCard.tsx` 渲染 `linkUrl`（有则整条可点击跳转）。
5. **M5 OrderReturn 三条备注独立**——`OrderReturn` 加 `salesNote String?`；
   `order-returns/[id]/review/route.ts` 的 reject/approve 两个分支都改成写 `salesNote`（不再碰
   `warehouseNote`）；`OrderReturnDialog.tsx` 第 185-187 行的 REJECTED 展示改读
   `item.salesNote ?? item.warehouseNote`（兼容迁移前的历史记录），APPROVED 状态补一行同样的展示。
6. **M6 核销管理接入退换货标记**——新增 `lib/accounting/goods-return-flags.ts` 导出
   `getGoodsReturnFlags(orderIds)`：按 `orderId` 精确查 `OrderReturn`（覆盖包括 WAREHOUSE_PENDING/
   PENDING_REVIEW 的全部状态），Trip 路径只能退回到 `Order.goodsReturnStatus`/`goodsReturnedAt`
   这两个"终态徽章"字段兜底（已知局限：Trip 路径的退换货如果还停在待核实/待审核，这里看不到——
   写进风险点，不做全表扫 Trip 的复杂方案）。`listReturns()` 合并这个结果到 `ReturnRow`，前端加
   异常徽章 + 仓库确认/销售确认两个子状态，未确认标红"待确认"。
7. **M7 退货→欠款单（Credit Note）扩展**——`generate-from-returns/route.ts` 加
   `orderReturnIds?: string[]` 入参，复用现有"按客户分组→建 CreditNote→标记 SETTLED"逻辑，
   不新开一个平行路由。
8. **M8 历史订单换开新发票**——`Invoice` 加 `supersedesInvoiceId String? @unique` 自关联，
   `InvoiceStatus` 加 `SUPERSEDED`；新路由 `app/api/invoices/[id]/reissue/route.ts`：复制旧票
   `lines`(Json)+金额到一张新 `DRAFT` 发票，旧票标记 `SUPERSEDED`（`ar-summary` 现有
   `status in [DRAFT,POSTED]` 的过滤天然把它排除出应收汇总，不用改别处）；新票内容如需改行项，
   走现有 `PATCH /api/invoices/[id]` 编辑 DRAFT 的既有能力，不在 reissue 里重做一套编辑表单。
   路由需登记进 `lib/rbac/route-map.ts`（权限点复用现成的 `finance.invoice.create`+
   `finance.invoice.update`，两点已同授予同一批角色，不用新增 RBAC 授权）。

## Schema 设计（新增迁移）

```prisma
model OrderReturn {
  // ...现有字段不变
  salesNote String?   // 新增：销售审核备注，跟 warehouseNote 彻底独立
}

enum BulletinCategory {
  SHORTAGE
  ARRIVAL
  PRICE_CHANGE
  GOODS_RETURN   // 新增
  OTHER
}

model BulletinPost {
  // ...现有字段不变
  linkUrl String?   // 新增：自动发帖时指向退换货 tab 的具体记录
}

enum InvoiceStatus {
  DRAFT
  POSTED
  PAID
  CANCELLED
  SUPERSEDED   // 新增：被换开新票取代，排除出应收汇总
}

model Invoice {
  // ...现有字段不变
  supersedesInvoiceId String?  @unique
  supersedesInvoice   Invoice? @relation("InvoiceSupersession", fields: [supersedesInvoiceId], references: [id])
  supersededByInvoice Invoice? @relation("InvoiceSupersession")
}
```
（`ReturnItem.lateReportNote` 是 TS 接口字段，存在 `Trip.restaurants[].returns[]` 的 JSON 里，不涉及迁移。）

## 路由清单

| 路由 | 变化 |
|---|---|
| `GET/POST /api/order-returns` | 不变 |
| `PUT /api/order-returns/[id]/warehouse-verify` | 改：verify 成功分支里追加自动发帖 |
| `PUT /api/order-returns/[id]/review` | 改：approve/reject 都写 `salesNote`，不再覆盖 `warehouseNote` |
| `PUT /api/trips/[id]/returns/warehouse-verify` | 改：verify 成功分支里追加自动发帖 |
| `PUT /api/trips/[id]/returns`（review） | 不变（`refundNote` 已独立） |
| `POST /api/credit-notes/generate-from-returns` | 改：body 加 `orderReturnIds?` |
| `POST /api/invoices/[id]/reissue` | **新增**，需登记 `lib/rbac/route-map.ts` |
| `GET /api/accounting/returns`（或等价列表接口） | 改：返回体加退换货标记字段 |
| 司机端提交（`driver/trip/[id]` 页内 fetch，走现有 Trip returns 接口） | body 加 `lateReportNote?`，服务端按字段原样落 JSON，无需改路由签名（已是自由字段透传） |

## 风险点

1. **Trip 路径在核销列表里的覆盖局限**：`Order.goodsReturnStatus` 只在终态（APPROVED/REJECTED）写入，
   WAREHOUSE_PENDING/PENDING_REVIEW 阶段的 Trip 退货在核销列表看不到"待确认"状态——这是现有架构
   （`returns-engine.ts` 的 `GoodsReturnOrderSync` 接口只接受终态两个值）决定的既有限制，本轮不新建
   一套 Trip 全表实时扫描去补这个边界情况（过度设计），按 CLAUDE.md 判断权属于我自己拍板。
2. **发票换开的资金前提**：`reissue` 只允许旧票 `amountPaid=0 且 amountCredited=0` 时执行——已有
   收款/核销记录的发票如果也要换开，涉及把历史资金记录迁到新票还是留在旧票的二次设计，本轮不做，
   超出此范围会报错提示改走现有 Credit Note 流程。这是我的假设，写进假设清单。
3. **历史兼容**：`OrderReturn`/`BulletinPost.linkUrl`/`Invoice` 新字段全部可空，`InvoiceStatus`/
   `BulletinCategory` 加枚举值不影响现有行；生产 `OrderReturn` 当前 0 条、`BulletinPost` 现有行
   `linkUrl` 为空走不影响旧逻辑的展示分支——迁移风险低。
3. **TS 穷尽性检查**：新增 `InvoiceStatus.SUPERSEDED` 后要 `grep` 现有 switch/if 链判断是否有
   "未覆盖新值就默认当某种已知状态处理"的隐患（例如发票列表的状态徽章渲染），执行阶段用
   `tsc --noEmit` + 人工过一遍，不能只信编译器穷尽性检查（大部分现有代码是 if 链不是
   exhaustive switch，编译器未必会报错）。
4. **消息广场自动发帖的触达范围**：现有 `BulletinPost` 无受众过滤，所有内部角色都能看到自动发的
   退换货通知——沿用现状，不新增"只给销售看"的定向推送（过度设计）。

## Appendix A：验收脚本

新建 `scripts/verify-return-gaps.sh`（沿用本项目"每个专题一个 verify 脚本"的既有命名习惯，对齐
`verify-return-flow.sh`），至少包含：

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== tsc =="
npx tsc --noEmit

echo "== build =="
npm run build

echo "== migrate status =="
npx prisma migrate status

echo "== 路由探针：reissue 鉴权 =="
# 无 token → 401；低权限 token(RESTAURANT) → 403；finance 权限 token → 200/409(按前提条件)
# 参照 api-auth-templates skill 的标准 curl 写法，具体 token 由脚本内生成/读取 .env.test

echo "== DB 字段探针 =="
# 断言 OrderReturn.salesNote / BulletinPost.linkUrl / Invoice.supersedesInvoiceId 列存在
# 断言 BulletinCategory 含 GOODS_RETURN、InvoiceStatus 含 SUPERSEDED

echo "== 业务探针 =="
# 1) 构造一条 OrderReturn WAREHOUSE_PENDING → PUT warehouse-verify → 断言 BulletinPost 新增一条
#    category=GOODS_RETURN source=AUTO，且 linkUrl 非空
# 2) 该记录 → PUT review(reject, note=X) → 断言 salesNote=X 且 warehouseNote 未被覆盖
# 3) 构造一张 POSTED 发票（amountPaid=0）→ POST reissue → 断言旧票 status=SUPERSEDED、
#    新票 status=DRAFT 且 lines 内容一致；ar-summary 总额不因换开产生双计
```

退出码即结论；无命令输出的条目标 ⚠️ 未验证，不写 ✅。

---

📋 计划已生成。三块内容，只有第 1 块需要你判断：

【需要你判断 — 场景清单】
- [你说的] 司机/销售/调度各角色登录后应落到各自主页，不能落错
- [你说的] 司机报备退换货必须带照片，不能不传；补报几天前的退换货要有独立备注，不能跟普通退货原因混一起
- [你说的] 仓库次日验车这一步要搬到 inventory 页下新建的"车辆检查"tab，跟现有"退换货"tab 并存、互不影响
- [你说的] 仓库确认后消息广场要自动出现一条，销售能点进去二次核实；司机/仓库/销售三条备注要彻底独立，不能互相覆盖
- [你说的] 会计核销管理列表要能看到这单有没有退换货异常、仓库/销售各自有没有确认，没确认要标红；历史订单要能换开一张新发票取代旧的
- [我推断的] "车辆检查"tab 只做"待核实"这一个队列（不像"退换货"tab 那样三栏），因为验车是仓库一次性动作，确认完就转到销售审核（在旧 tab 里走），不需要在新 tab 里也看"已处理"历史
- [我推断的] 消息广场自动发帖面向全体内部角色可见（现有广场本身就没有受众过滤），不单独做"只推给销售"的定向通知
- [我推断的] 发票换开只允许旧票还没有收款/核销记录时执行；已经有资金记录的发票换开，引导走现有 Credit Note 流程而不是本次新建的 reissue
推断项最容易错，请重点看这 3 条。

【我负责 — 你不用看】
技术验收标准与 verify.sh 见本文件 Appendix A。性能、鉴权、类型、查询效率由我定标准、我自证、我贴证据。
技术栈/数据库托管方式不变（仍是现有 Next.js+Prisma+PostgreSQL，droplet 自动部署，不涉及新增云资源）。

【一次性告知 — 不同意就说】
歧义清单：
0. 你的原话我会原文存进 `docs/20261028-veggie-退换货5步流程-需求原话.md`，不转述。
1. "三条备注独立"目前只有 OrderReturn 这条手动登记路径有 bug（Trip/司机上报路径的
   `reason`/`warehouseNote`/`refundNote` 已经是三个独立字段，本来就没问题）——本轮只修
   OrderReturn 这一条。
2. 核销管理列表对"Trip 路径且还卡在待核实/待审核阶段"的退换货看不到标记（见风险点 1），
   按保守方案不做全表扫描兜底。

假设清单：
1. 发票换开（reissue）限定旧票 `amountPaid=0 且 amountCredited=0` 才能执行（风险点 2）。
2. "车辆检查"tab 只保留待核实队列，不重复旧 tab 的"待审核/已处理"两栏。
3. 消息广场自动发帖不做角色定向推送，复用现状的"全员可见"。

回复"确认"后我不再就实现细节打断你。
