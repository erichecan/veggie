# 开发完成报告

## 本次开发了什么

给 North Fresh 建了一套数据分析中心：老板日报一屏、客户分析（含流失预警）、毛利分析、应收账龄、采购运营分析（含缺货×采购联动）、物流分析、内控审计共 7 个新页面，并补齐了三个支撑数据缺口——批次真实成本、盘点流程、每日经营快照。业务员规范化核实后发现已在 7 月 2 日的迁移里解决，无需重做。

## 可以访问的页面

| 页面 | 地址 | 说明 |
|------|------|------|
| 老板日报一屏 | `/classic/boss` | 昨日 5 卡 + 今日实时 4 卡 + 30 天趋势图 + 4 个红灯区列表 |
| 客户分析 | `/classic/boss/analytics/customers` | ABC 分层 + 流失预警名单，支持日期范围切换 |
| 毛利分析 | `/classic/boss/analytics/margin` | 按商品/分类/客户/业务员四个维度切换，含成本覆盖率提示 |
| 应收账龄 | `/classic/boss/analytics/ar-aging` | 5 桶账龄分布图 + 按客户明细表 |
| 采购运营分析 | `/classic/boss/analytics/procurement` | 供应商满足率 / 进价趋势 / 周转损耗 / 缺货×采购联动 四个 tab |
| 物流分析 | `/classic/boss/analytics/logistics` | 司机日装载、交账差异、出发记录 |
| 内控审计 | `/classic/boss/analytics/internal-control` | 改价明细、按操作员汇总、创建→确认耗时 |
| 库存盘点 | `/classic/warehouse/stock-take` | 按分类建单 → 录入实盘 → 完成生成库存调整 |

## 功能完成情况

| 功能 | 状态 | 说明 |
|------|------|------|
| 指标口径 SSOT（`lib/analytics/metrics.ts`） | ✅ 完成 | 三时点口径（销售/物流/财务）+ 状态集合 + 账龄分桶定义，各 API 统一引用 |
| Lot 批次成本 + 收货写入 | ✅ 完成 | `goods-receipts` 收货时按 PO 行 `unitCost` 写入 `Lot.unitCost` |
| 历史批次成本回填脚本 | ✅ 完成 | `scripts/backfill-lot-cost.ts`；当前库无历史空缺批次，dry-run 0/0（新装批次未来会自动积累覆盖率） |
| 每日经营快照（`DailyBusinessSnapshot`） | ✅ 完成 | 惰性生成 + 幂等（已用真实数据验证重复调用补 0 天）+ 手动重算 API |
| 库存盘点全流程 | ✅ 完成 | 建单→录入→完成→生成 `ADJUSTMENT` StockMove→同步 `qtyOnHand`，端到端用真实数据验证通过（详见验证结果） |
| 老板日报一屏 | ✅ 完成 | 昨日快照 + 今日实时 + 待配送/波次/缺货待处理 + 流失预警/负库存/超期未确认/应收 四个红灯区 |
| 客户分析（ABC + 流失预警） | ✅ 完成 | 分类真实聚合，非"未分类"占位（沿用用户此前反馈的修复方式） |
| 毛利分析 | ✅ 完成 | 手工核对一个商品数字与数据库原始聚合完全一致（见验证结果） |
| 应收账龄 | ✅ 完成 | `dueDate` 为 String 列，已做安全 parse，无法解析归"未知"桶单独展示 |
| 采购运营 + 缺货×采购联动 | ✅ 完成 | 缺货商品是否已有采购建议/在途 PO 一目了然，标出"采购盲区" |
| 物流分析 | ✅ 完成 | 复用 `Trip.cashCollected/onlineCollected/totalPayment`，口径与既有司机交账页一致 |
| 内控审计 | ✅ 完成 | 基于既有 `OrderAuditLog.totalBefore/totalAfter`，无需新增审计埋点 |
| API 鉴权 | ✅ 完成 | 全部 `withAuth` + 角色白名单，见下方验证结果 |
| 权限矩阵补充 | ✅ 完成 | `lib/permissions.ts` 新增 `analytics`/`stock_take` subject |

## 三个数据缺口的最终处理（对照最初计划）

| 缺口 | 计划时的判断 | 开发时重新核实 | 最终处理 |
|------|-------------|---------------|---------|
| 业务员规范化 | 需要做 | 核实发现 7/2 迁移已把 `Order.salesman` 自由文本换成 `salesUserId` 关联 User | 无需重做，`按业务员`分组直接用 `salesUserId` |
| 真实成本 | 只有静态 standardPrice | `PurchaseOrderLine.unitCost` 已有真实进价，只缺批次级落地 | 加 `Lot.unitCost` + 收货写入 + 回填脚本 + `v_lot_daily_cost` 视图 |
| 盘点流程 | 完全缺失 | 确认缺失 | 新增 `StockTake`/`StockTakeLine` + 仓库盘点页，已端到端验证 |

## 验证结果

| 验证项 | 方式 | 结果 |
|--------|------|------|
| `npx tsc --noEmit` | 全项目类型检查 | ✅ 0 错误 |
| `npm run build` | 生产构建 | ✅ 成功，18 个新路由全部注册（10 API + 8 页面） |
| 快照幂等性 | 真实数据连续调用 `ensureSnapshots()` | ✅ 首次补 19 天，第二次补 0 天 |
| 快照重算 API | `POST /api/analytics/snapshots {days:3}` 连续两次 | ✅ 均返回 `recomputed:3`（强制重算按设计不跳过） |
| 毛利手工核对 | 抽查商品 "BAG Onion SP. 20kg"：API `revenue=6636.86, cost=4313.01, GP=2323.85, margin=35.0%` vs 数据库原始 SQL 聚合 | ✅ 完全一致 |
| 应收账龄总额对账 | API `totalDue` vs `Invoice.aggregate(amountDue)` | ✅ 一致（当前库无未清发票，两边均为 0） |
| 盘点全流程 | 建单(Egg 分类 5 商品)→录入 2 行实盘→完成 | ✅ `qtyOnHand` 精确变为 450/60，`StockMove(ADJUSTMENT)` 正确生成，diff 计算正确 |
| 盘点状态守卫 | 对已 DONE 的盘点单再次 `complete`/`save_counts` | ✅ 均返回 409，不可重复操作/修改 |
| 未登录访问 `/api/analytics/overview` | curl 无 token | ✅ 401 |
| 错误 token 访问 | curl 携带无效 JWT | ✅ 401 |
| 低权限角色越权 | RESTAURANT 访问 `ar-aging`/`internal-control`/`stock-takes` | ✅ 均 403 |
| 全部 9 个新 GET 端点 | BOSS token 逐一 curl | ✅ 全部 200 |
| 8 个新页面浏览器渲染 | Chrome 预览逐页截图 + snapshot | ✅ 全部正常渲染，无控制台报错，无服务端报错 |
| 分类聚合正确性 | 毛利页"按分类"切换 | ✅ 显示真实分类名（Vegetable/Dry Food/JP-Frozen 等），非"未分类"占位 |
| 权限一致性 bug 修复 | 发现仓库盘点页 API 允许 BOSS 但 layout 前端角色守卫遗漏 BOSS，导致跳转登录页 | ✅ 已修复（`warehouse/layout.tsx` 加入 BOSS） |

## 已知问题（如实列出，未隐瞒）

1. **⚠ 库存数据健康度问题（预先存在，非本次改动引入）**：跑 `npm run db:validate` 发现 895/1718 个商品的 `Product.qtyOnHand` 与 `ΣStockMove` 不守恒，另有 53 行已完成订单 `deliveredQty ≠ orderedQty`，3 个商品负库存。这是历史遗留的数据一致性问题（此前记忆已记录 `db:validate` 校验发现类似问题），与本次新增的分析中心代码无关（本次盘点测试新增的 2 条 StockMove 与 `qtyOnHand` 同事务写入，完全守恒）。**影响**：老板一屏的"负库存商品"红灯区和毛利/周转分析会如实反映这些历史脏数据，属于设计预期（暴露问题而非掩盖），但建议后续单独排查这批历史 StockMove 缺失的根因。
2. **成本覆盖率当前为 0%**：现有 `Lot` 均无历史 `unitCost`（历史批次的采购来源无法追溯到 PO 行，回填脚本 dry-run 匹配 0 条）。新收货会自动写入成本，覆盖率会随业务运转逐步上升；在此之前毛利分析全部使用 `Product.standardPrice` 兜底，页面已用黄条明确提示，不会误导用户当作精确毛利使用。
3. **物流分析的"出发准时率"未做**：DEV-PLAN 原计划里没有可靠的 SLA 基准数据（系统没有"计划出发时间"字段），改为展示原始出发记录供人工判断，未编造一个没有数据支撑的准时率阈值。
4. **供应商满足率示例数据为空**：测试所用日期范围内没有已确认的采购单（PO 全部还是草稿/待发状态），空状态展示正确，但功能本身未能用真实非空数据跑通"到货满足率 < 90% 标红"这条具体分支，建议后续用有确认 PO 的日期范围复核一次。

## Phase 4 之外未做的事（原计划范围内，供后续参考）

- 未新建独立的"业务员业绩/提成"报表页面（已具备 `salesUserId` 数据基础，毛利分析里已有"按业务员"分组，若需要专门的提成计算报表可另起一期）。
- 未清理旧的 `/classic/boss/purchase-analysis`（旧版采购分析）、`/classic/boss/sales-analysis`，两者仍保留在导航栏并标注"(旧)"，新旧并存过渡，未做删除决定（属于产品决策，未擅自下线）。

## Git 状态说明

会话中途有一次自动提交（`0b61575`，Phase 1：schema/快照/盘点/成本回填），我没有主动执行过 `git commit`。**Phase 2-4（老板一屏改造、6 个分析页面、boss/warehouse layout 权限修复）目前是未提交的工作区改动**，按规则未经你明确要求不会自动提交或推送。如需提交/推送到生产，请明确说一声。

## 测试账号

沿用现有种子账号，未新增：

| 角色 | 邮箱 | 密码 |
|------|------|------|
| 老板（BOSS，全部页面可见） | boss@veggie.com | Demo1234! |
| 运营（OPERATOR，销售/缺货/物流可见） | operator@veggie.com | Demo1234! |
| 餐厅（RESTAURANT，用于验证 403） | restaurant1@veggie.com | Demo1234! |

## 下一步建议

1. 排查 `db:validate` 报出的库存不守恒历史数据（895 个商品），这会持续影响老板一屏红灯区和毛利/周转报表的可信度。
2. 找一段有已确认采购单（PO status=CONFIRMED/RECEIVED）的日期区间，复核"到货满足率"计算分支。
3. 视业务需要决定是否下线旧版 `sales-analysis`/`purchase-analysis` 页面，减少导航栏冗余。
4. 若要在生产环境验证快照 SQL 性能（当前全部走索引字段 GROUP BY，未做压测），建议先在生产影子环境跑一次 `ensureSnapshots()` 观察耗时。
