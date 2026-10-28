# DEV-PLAN：退货/报废流程整合（warehouse/returns ↔ operator/inventory，三条记账路径收编为一条）

## 读取了哪些文档

本次没有独立 PRD 文件，来源是你在对话中分批给出的现场反馈 + 你亲自登录生产环境后的发现，逐字存进
`docs/20261027-veggie-退货报废整合-需求原话.md`，不转述不润色。

历史背景文档（只读没改，决定了"哪些已经做完不用动、哪些是新坑"）：
- `docs/20260922-return-case-flow-tasks.md` —— 上一轮把 Trip/ReturnItem 三段流程（司机上报→仓库核实→
  销售/运营审核→disposition）从零建起来的任务台账，17/17 探针通过，`/code-review high` + `/security-review`
  都走过。结论：这条流程**代码层面是完整且正确的**，本次不重建它的状态机/API，只解决"没人用、够不着、
  跟另外两条野路子打架"的问题。
- 代码现状调研（grep + 直接读文件，均在本次会话完成）：
  `app/[locale]/classic/operator/inventory/page.tsx`（20260821 注释：退换货已从顶部导航迁入本页 tab，
  底层文件保留不动）、`app/[locale]/classic/operator/inventory/scrap/page.tsx`、
  `app/[locale]/classic/warehouse/page.tsx`、`lib/rbac/route-map.ts`、`prisma/seed-rbac.json`、
  `lib/scrap-reasons.ts`、`lib/types.ts`（ReturnItem/TripRestaurant）、`prisma/schema.prisma`
  （Order/Trip/OrderAuditLog）。
- 生产库只读查询（SSH，无写操作）：76 条 Trip 全部有 restaurants，但 ReturnItem 的 5 种状态计数全是 0 ——
  正式流程上线以来**从未被实际使用过一次**。

## 现状调研结论（决定了下面怎么改）

三条路径都能记录"客户退货/报废"同一件事，彼此不知道对方存在：

| 路径 | 入口 | 记账方式 | 挂没挂单据 | 现状 |
|---|---|---|---|---|
| ① Trip/ReturnItem 正式流程 | 司机上报→`warehouse/returns`核实→`operator/returns`(或 inventory 的「退换货」tab)审核 | 审核通过自动 `postStockMove` | ✅ 挂 Trip/订单 | 代码完整，生产 0 条记录 |
| ② 独立报废页 `operator/inventory/scrap` | 手填商品+数量+原因(含 `CUSTOMER_RETURN_EXPIRED/DAMAGED`) | 直接 POST `/api/scrap`→`postStockMove` | ❌ 无任何关联字段 | 入口本身也是孤儿路由，但有真实业务含义的原因枚举 |
| ③ 仓库"调整库存"弹窗 | `warehouse` 首页通用弹窗，占位文案示例"客户退货" | 直接 POST `/api/stock-moves` | ❌ 纯自由文本备注 | 任何理由都能填，无结构 |

权限层面的根因（`lib/rbac/route-map.ts:446,465`）：`/classic/warehouse/**` 需要 `page.warehouse.access`，
`/classic/operator/**` 需要 `page.operator.access`，两个页面权限点互不包含——纯仓库员工**物理上打不开**
`/classic/operator/inventory`，这才是"权限问题跳来跳去"的代码级原因，不是 UI 没做好。
同时确认 `prisma/seed-rbac.json` 里 WAREHOUSE 角色已经持有 `dispatch.trip.warehouse_verify`、
`stock.scrap.manage`、`stock.move.create` 这些**动作权限**——缺的只是页面门，不缺动作权限，改动范围因此
收得很小。

## 模块拆解

### M1 —— 退换货统一看板（核心）
把 `warehouse/returns`（核实）+ `operator/returns`（审核+disposition）两个页面的逻辑合并成
`operator/inventory` 的「退换货」tab 内一个三栏看板：待核实 / 待审核 / 已处理。
数据源同时查 Trip.restaurants[].returns（司机上报）和新增的 `OrderReturn` 表（手动登记，见 M3），
合并展示，标明来源，但审核/处置用同一套 UI 和同一个后端处置函数。

- 删除 `app/[locale]/classic/warehouse/returns/`、`app/[locale]/classic/operator/returns/`（独立孤儿路由，
  不是降级下线，是彻底删除——留着就是给第三条野路子留后门）。
- `warehouse/layout.tsx` 导航去掉"退换货核实"条目。
- 把原来两个页面里的核实逻辑、审核逻辑搬进 `operator/inventory/page.tsx` 的「退换货」tab 组件。

### M2 —— 权限开口子
不改 WAREHOUSE 角色现有动作权限，只给 `/classic/operator/inventory/**` 这一条子路径单独开第二个页面
权限点，复用代码里已有的先例写法（`route-map.ts:450-451,464` 财务摸发票/订单的做法）：

```ts
{ pattern: '/classic/operator/inventory/**', permission: ['page.operator.access', 'page.warehouse.access'] },
```

这条要写在 `/classic/operator/**` 通配规则（第 465 行）之前，否则永远匹配不到。

### M3 —— 手动登记入口（日销售中心「退货登记」tab）
新建 `app/[locale]/classic/operator/daily-sales/_components/ReturnRegistration.tsx`，作为
`daily-sales/page.tsx` 现有三个 tab（打印中心/缺货处理/销售统计）的平级第四个 tab，不嵌进"缺货处理"——
缺货处理是发货前事件、退货是发货后事件，语义不同，混在一起以后排查会分不清是哪种原因（这是我的判断，
已在对话里跟你说明过）。

按订单号/客户搜到订单行 → 填商品+数量+原因+actionType(退货/换货) → 提交，创建一条 `OrderReturn` 记录
（新表，见下面 schema），状态机复用 M1 看板同一套核实/审核/disposition 逻辑，不另起状态机。
之所以不像最初考虑的那样"借用一个空 Trip 占位"：Trip 语义上是"司机的一次配送行程"，强塞一条没有司机的
占位记录会污染司机相关的统计（司机日销售、loss-dashboard 等按 Trip 聚合的地方），新建一张直接挂
`orderId` 的小表反而更干净，还顺带解决了①现有机制"退货记录只能靠 restaurantId+productId 反查订单，
匹配不精确"的老问题（新表直接存 orderId，不用反查）。

### M4 —— 收编②③两条野路子
- ②`operator/inventory/scrap` 页面：UI 层去掉下拉框里 `CUSTOMER_RETURN_EXPIRED`/`CUSTOMER_RETURN_DAMAGED`
  两个选项（新增一个 `MANUAL_SCRAP_REASONS` 子集常量，只排除这两项，不改 `SCRAP_REASONS` 本身——
  `lib/scrap-reasons.ts` 顶部注释写明这套原因是"仓库报废和客退处置共用"，`app/api/trips/[id]/returns/route.ts:368`
  审核通过 disposition=SCRAP 时仍要用这两个原因给 StockMove 打标，删常量会连带打断正式流程，只能砍
  手动页面的下拉选项）。
- ③`warehouse/page.tsx` 调整库存弹窗：占位文案去掉"客户退货"示例（`如：损耗处理、盘点调整、客户退货`
  改成`如：损耗处理、盘点调整`），引导用户改走 M1/M3 的正式入口，不删弹窗本身（盘点误差等场景仍然需要
  通用调整）。

### M5 —— Order 侧只读同步 + 审计
- `Order` 新增只读字段 `goodsReturnStatus`（String? 可空），值域 `'PENDING' | 'APPROVED' | 'REJECTED'`，
  故意不叫 `returnStatus`/不复用 `OrderReturnStatus` 枚举——现有 `returnStatus` 字段语义是"核销/对账确认"，
  20261021 刚修过一次把 `RETURNED` 误读成"有退货"的坑（`docs` 已有记录），这次新字段必须一眼就能跟它
  分清楚。
- 审核/处置通过时回写这个字段 + 在 `OrderAuditLog` 插一条 `action: 'goods_return_disposed'` 记录
  （`OrderAuditLog.action` 本来就是自由字符串，不用改表结构）。
- 销售单/日销售中心列表页给这个字段加一个小角标（有退货/处理中/已拒绝），只读展示，不可在订单页直接改。

## schema 设计

```prisma
enum GoodsReturnStatus {
  WAREHOUSE_PENDING
  PENDING_REVIEW
  APPROVED
  REJECTED
  SETTLED
}

enum GoodsReturnDisposition {
  SELLABLE
  SCRAP
}

/// 日销售中心"退货登记"手动入口专用。司机现场上报的退货仍走 Trip.restaurants[].returns
/// (ReturnItem)，两套互不迁移、互不冲突；M1 统一看板会同时查两边、共用同一套核实/审核/处置函数。
/// 与 Trip 版本相比直接挂 orderId，不用再按 restaurantId+productId 反查订单。
model OrderReturn {
  id                      String                   @id @default(cuid())
  orderId                 String
  order                   Order                    @relation(fields: [orderId], references: [id])
  productId               String
  productName             String
  quantity                Decimal                  @db.Decimal(12, 3)
  reason                  String?
  actionType              String                   @default("return") // return | exchange
  exchangeOrderId         String?
  status                  GoodsReturnStatus         @default(WAREHOUSE_PENDING)
  disposition             GoodsReturnDisposition?
  scrapLotId              String?
  warehouseVerifiedById   String?
  warehouseVerifiedByName String?
  warehouseVerifiedAt     DateTime?
  warehouseNote           String?
  approvedById            String?
  approvedByName          String?
  approvedAt              DateTime?
  settledAt               DateTime?
  registeredById          String
  registeredByName        String?
  createdAt               DateTime                 @default(now())

  @@index([orderId])
  @@index([status])
}
```

`Order` 表新增：

```prisma
/// 只读镶嵌角标，源头永远是 ReturnItem/OrderReturn，不在订单页直接改。
/// 故意不叫 returnStatus / 不复用 OrderReturnStatus：那个字段是核销对账语义，
/// 20261021 刚修过一次混淆的坑，这里必须用不同的名字和值域避免重蹈覆辙。
goodsReturnStatus String?   // 'PENDING' | 'APPROVED' | 'REJECTED'，null = 无退货
goodsReturnedAt   DateTime?
```

后端共用逻辑：把 `app/api/trips/[id]/returns/route.ts` 里"审核通过→disposition→postStockMove→回写
Order"这段逻辑抽成 `lib/returns-engine.ts` 的一个纯函数，Trip 版和新 `OrderReturn` 版的审核接口都调它，
不重复实现 StockMove 记账和 Order 回写两次。

## 路由清单

新增：
- `POST /api/order-returns` —— 登记（日销售中心调用），权限 `goods_return.register`
- `GET /api/order-returns` —— 列表（M1 看板调用），权限 `goods_return.warehouse_verify` 或 `goods_return.review`
- `PUT /api/order-returns/[id]/warehouse-verify` —— 核实，权限 `goods_return.warehouse_verify`
- `PUT /api/order-returns/[id]/review` —— 审核+disposition，权限 `goods_return.review`

删除：
- `/classic/warehouse/returns`（页面+路由）
- `/classic/operator/returns`（页面+路由，逻辑已搬进 inventory 的 tab）

修改：
- `lib/rbac/route-map.ts`：新增 `/classic/operator/inventory/**` 页面权限行（M2），新增上述 4 条 API 权限行
- `prisma/seed-rbac.json`：WAREHOUSE 角色追加 `goods_return.warehouse_verify`；OPERATOR/SALES（现有持有
  `dispatch.trip.read_returns` 的角色）追加 `goods_return.register` + `goods_return.review`
- `lib/rbac/catalog.ts`：补上这 3 个新权限点的中英文标签，供权限配置页展示

## 风险点

1. **历史数据迁移**：生产 0 条 ReturnItem 记录，不存在"旧数据要不要搬进 OrderReturn"的问题——这次是
   少有的、完全不用考虑历史数据迁移的大改，直接按新模型建表即可。
2. **②③路径的既有用户习惯**：如果仓库/销售已经习惯用"调整库存"或"报废管理"记客退，上线后短期内可能
   还有人走旧路径——这次只是去掉 UI 上的诱导文案和选项，没有在后端拦截（后端仍接受调用），防止真有
   仓库盘点场景被误拦；但如果一段时间后发现野路子记录仍在增长，需要再回来加后端硬拦截。
3. **loss-dashboard / 司金分析等聚合口径**：`OrderReturn` 走 SCRAP 处置时需要确认 `lib/analytics/loss-dashboard.ts`
   同时统计 Trip 版和 OrderReturn 版的 StockMove，否则报表会漏掉手动登记产生的报废量。
4. **`returns-engine.ts` 抽取的回归风险**：Trip 版审核逻辑是生产已验证过的（17/17 探针），抽取成共用函数
   时必须保证 Trip 版的现有测试/探针全部不变地继续通过，不能因为"顺手"改了它的行为。

## 附录A：技术验收标准（`scripts/verify.sh` / `scripts/verify-returns-consolidation.*`）

- `npx tsc --noEmit`、`npm run build`、`npx prisma migrate status` 全绿
- 路由探针：`/classic/operator/inventory`（含 `?tab=returns`）对 WAREHOUSE-only 和 OPERATOR-only 两种
  权限的账号分别请求，断言都不是 403；`/classic/warehouse/returns`、`/classic/operator/returns` 两个
  旧路由断言 404（确认真的删掉了，不是只摘导航）
- 鉴权探针：`POST/PUT /api/order-returns*` 分别用「无 token / 错 token / 低权限(DRIVER)」请求，断言
  401/401/403
- 状态机探针（仿 `scripts/verify-return-flow.py` 的模式，新开一份针对 `OrderReturn` 的版本）：
  WAREHOUSE_PENDING→PENDING_REVIEW→APPROVED(disposition=SELLABLE，断言 StockMove RETURN 生成且
  Product.qtyOnHand 回补)→另开一条 REJECTED 路径
  →另开一条 APPROVED(disposition=SCRAP，断言 StockMove SCRAP 生成)
  全部用完即用 try/finally 删除自己建的测试数据，不留脏数据
- 回归探针：原 Trip/ReturnItem 的 17 条既有探针（`scripts/verify-return-flow.py`）全部仍通过，证明抽取
  `returns-engine.ts` 没有改坏老流程
- Order 回写探针：审核通过后断言 `Order.goodsReturnStatus` 与 `OrderAuditLog` 新记录都正确写入
- 查询探针：`GET /api/order-returns` 开 Prisma query log，断言查询数不随 Trip/OrderReturn 数据量线性增长

铁律：以上脚本不全绿不写完成报告；没有命令输出的条目标 ⚠️ 未验证，不标 ✅。

---

📋 计划已生成。三块内容，只有第 1 块需要你判断：

【需要你判断 — 场景清单】
用你的话描述做完之后是什么样，逐条标注来源：
- [你说的] 仓库和运营两边的人不用再因为权限问题在两个页面之间跳来跳去，核实+审核在同一个「退换货」看板里完成
- [你说的] 日销售中心多一个平级的"退货登记"tab，跟缺货处理分开，可以按订单号手动登记退货
- [你说的] 这三个按钮点完之后，订单上要能看到退货状态和完整操作记录
- [我推断的] `warehouse/returns` 和 `operator/returns` 两个旧页面直接删除，不是像 20260821 那样"降级但保留文件"——因为留着就是给第三条野路子留后门，跟你"整合"的本意相反
- [我推断的] 报废管理页(`operator/inventory/scrap`)和仓库调整库存弹窗不删除、不拦截后端调用，只去掉 UI 上诱导填"客户退货"的选项/文案——彻底禁止的话，万一真的有特殊场景（比如没有司机参与、也不走订单登记的纯仓库内部报废）会没有出口
- [我推断的] 日销售中心新增的"退货登记"走一张新表 `OrderReturn`，不复用 Trip 占位行程的方案——这个我自己推翻过一次（一开始想借用空 Trip），最终决定是因为 Trip 语义上代表真实配送行程，硬塞会污染司机统计

推断项最容易错，请重点看这几条，尤其是"旧页面要不要彻底删除"和"报废/调整弹窗要不要留后门"这两条——这两条如果判断反了，返工成本比其他模块都大。

【我负责 — 你不用看】
技术验收标准与 verify 脚本见附录A。权限点设计、schema 字段命名、后端函数怎么抽取由我定标准、我自证、我贴证据。
技术栈沿用现有 Next.js/Prisma/PostgreSQL，不涉及新选型；不部署 GCP 专有服务，符合项目 CLAUDE.md 部署铁律。

【一次性告知 — 不同意就说】
歧义清单：无——这次三点方向都是你明确拍板的，没有需要我按保守解释兜底的歧义点。
假设清单：`OrderReturn.quantity` 精度跟 `ReturnItem` 一样不设上限校验（现有 Trip 版本也没做数量上限校验，沿用同一宽松度，不额外加限制）。

回复"确认"后我不再就实现细节打断你。
