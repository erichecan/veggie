# DEV-REPORT：订单调整行体系（折扣/差价/配送费/赠品）

对应 `DEV-PLAN.md` + 台账 `docs/20260913-order-adjustments-tasks.md`（U1-U9 全部完成）。

## 背景

排查"拣货单商品分表看 Product.type 还是销售单位"问题时，在生产库里发现四个"假商品"
（`price difference`/`Small Offer Set`/`Discount`/`Deliver Service`），一查发现系统对
差价调整、促销赠品、折扣、配送费这四类需求**完全没有正式承接点**，业务只能新建虚构商品
塞进订单行将就实现，污染了提成、毛利统计和拣货单分表。

## 做了什么

**1. 拣货单分表 bug 修复**：`belongsToConsumableTable` 此前靠 `Product.type==='CONSU'`
硬编码把商品塞进"零散货"表，即便实际按整箱整袋规格下单也不例外。改成只看这一单实际用的
销售单位（`Uom.goodsType`），与 Storable 商品走同一套判定。生产库实测影响 21 个商品，见
`docs/20260913-consu-missing-uom-checklist.md`（其中 9 个真实商品需要运营去补配销售单位）。

**2. 新增 `OrderAdjustment` 模型**：折扣（DISCOUNT）、配送费（DELIVERY_FEE）、差价修正
（PRICE_CORRECTION）、其他（OTHER）四种类型，金额可正可负。`Order.totalAmount` 语义
不变（仍是税前商品合计），"客户实际应付总额" = `totalAmount + Σ调整金额`，统一由
`lib/order-adjustments.ts:getOrderPayableTotal()` 计算。

**3. 新增 `OrderLine.isGift` 字段**：赠品用真实商品行 + 单价归零表达，而不是发明一个
"套装商品"目录——赠品仍照常扣库存、照常出现在拣货单（物理上真的发货了），只是不计入
销售额/毛利/提成。

**4. 权限点 `sales.order.manage_adjustment`**：按"谁有 sales.order.update 就给谁"默认
发放（与既有"手动改价"权限点同一理由）。

**5. 发票/司机对账/打印单据接入调整行**：发票生成时把调整行追加成独立发票行；司机上门
收现总额（Trip.totalPayment）叠加调整合计；打印汇总单每单金额一列同步叠加——这三处是
真正"客户应付金额"的场景，其余统计报表（销售分析/毛利报表）明确不受影响。

**6. 存量四个假商品已在生产库下架**（`Product.active=false`），防止业务继续用旧方式下单，
历史订单数据不迁移、不追溯。

## 页面/接口

新增：
- `GET/POST /api/orders/[id]/adjustments`、`DELETE /api/orders/[id]/adjustments/[adjustmentId]`

改动：
- `PUT /api/orders/[id]`、`POST /api/orders/[id]/lines`：接入 `isGift` 写入通道
- `lib/invoice-from-order.ts`、`lib/trip-from-wave.ts`、`lib/print/{dispatch-loader,trip-loader}.ts`：接入调整合计
- `lib/commission.ts`、`lib/analytics/driver-commission.ts`、`app/api/analytics/{sales-overview,margin}/route.ts`、`lib/analytics/snapshot.ts`、`lib/analytics-chat/domains/sales.ts`：排除赠品行

前端：销售单详情页（`orders/[id]`）商品行加"Gift"勾选列 + 新增"Adjustments"调整行面板
（增/删/列表，联动 Amount Due）。**报价单页、新建下单页暂未接入同款 UI**（后端接口已可用，
留作后续，见"已知不可用功能"）。

## 功能完成度

| 功能 | 状态 |
|---|---|
| 拣货单分表按销售单位判断 | ✅ |
| OrderAdjustment 模型 + 权限点 | ✅ |
| 调整行 API（增/删/列表） | ✅ |
| 赠品标记（isGift）写入+校验 | ✅ |
| 提成/毛利/销售额统计排除赠品行 | ✅ |
| 发票/司机对账/打印单据接入调整行 | ✅ |
| 销售单详情页 UI（勾选+调整面板） | ✅ |
| 报价单/新建下单页 UI | ⚠️ 未做 |
| 存量假商品下架 | ✅（生产库已执行） |
| 历史假商品订单数据迁移 | ⚠️ 明确不做（DEV-PLAN 既定方案） |

## 验证结果

| 验证项 | 方式 | 结果 |
|---|---|---|
| `npm run build` | 本地构建 | ✅ 无报错 |
| `npm run dev` 启动 | 本地 | ✅ 正常启动，日志无 error/warn |
| 未登录访问受保护接口 | curl GET /api/orders/:id/adjustments | ✅ 401 |
| 错误密码登录 | curl POST /api/auth/login | ✅ 返回提示，不崩溃 |
| 访问不存在的订单 | curl GET /api/orders/nonexistent-id/adjustments | ✅ 404 |
| 新增调整行（折扣/配送费） | curl POST | ✅ 201，金额正负均正常 |
| 非法类型/零金额 | curl POST | ✅ 400 |
| 删除调整行 / 重复删除 | curl DELETE ×2 | ✅ 200 → 404 |
| `getOrderPayableTotal` 加减一致性 | 脚本核算 | ✅ 382+5=387 |
| 拣货单/发票/司机对账口径 | 单测（8 例，4 文件） | ✅ 全过 |
| 前端 UI 增删调整行 | Playwright 实测（本地 BOSS 测试账号） | ✅ Amount Due 382→388.50 |
| 前端 Gift 勾选即时归零锁价 | Playwright 实测 | ✅ |
| Discard 后无脏数据落库 | 复核 DB | ✅ 调整行/isGift 均已还原 |
| 权限点默认发放 | `tests/role-access.test.ts` 33/33 | ✅ |
| 角色可达性零意外扩权 | `tests/role-reachability.test.ts` + `rbac-route-map.test.ts` | ✅（新增 3 个 handler 已按项目机制显式登记） |
| 全量测试套件 | `node --test tests/*.test.ts` | ✅ 905 例，901 通过、2 跳过、2 失败（均为既存的 ABCT 客户测试数据缺口，与本次改动无关） |
| 生产库假商品下架 | SSH + psql 核实 | ✅ 4 个商品 active 均已改为 false |

## 已知不可用功能 / 遗留问题

1. **报价单页（quotations/[id]）、新建下单页（place-order）未接入赠品勾选/调整面板 UI**——
   后端接口对 PENDING 状态订单本身可用，只是前端界面还没加，需要客户确认是否需要提前到
   报价阶段就能用这两个功能。
2. **68 个 Consumable 商品完全没配置销售单位（goodsType）**，其中 9 个是真实商品，见
   `docs/20260913-consu-missing-uom-checklist.md`——需要运营去 Settings→计量单位 补配。
3. **历史 106 笔用假商品记录的订单不会被迁移**，历史报表数字维持现状，不追溯修正（DEV-PLAN
   既定方案，非本次遗漏）。
4. **赠品可以被"手动改价成 0"绕过而不走 Gift 勾选**——效果一样能免单，但不会被统计口径
   排除在外，commission/analytics 会把它当正常低价单算。这不是代码能堵死的漏洞，只能靠
   培训/流程约束："免单一律用赠品勾选，不要手动改价成 0"。
5. **会计口径决定沿用 DEV-PLAN 默认方案**：配送费/折扣不计入销售额与毛利统计、提成基数
   不扣折扣、四种调整类型共用一个权限点——如果客户后续有不同要求（比如运费要单独算一笔
   "其他收入"科目，或折扣需要经理审批），需要另开需求评估。
