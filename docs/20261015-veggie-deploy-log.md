# 2026-10-15 生产发布记录

- 代码提交：`eae2da56`（采购分析明细/分层明细加规格描述和单价列）+ `6e23ac34`（商品详情页接预测量/成本历史/BBD，采购单可编辑预计到货并回写到货日期），已推送 `main`。
- 新迁移 `20261015000002_purchasing_report_product_spec`：给 `veggie_purchasing_report` 视图加 `product_spec`/`description` 两列（取自 `PurchaseOrderLine` 行快照，非新数据）。
- GitHub Actions `Deploy to droplet`：<https://github.com/erichecan/veggie/actions/runs/38836601836>，结果 `success`。

## 验证结果

- 提交前 `npx tsc --noEmit`（无输出）、`npm run build`（exit 0）、`eslint` 针对改动文件全绿。
- curl 对 `/api/reports/purchasing`（PO级汇总/按产品展开/四级分组）、新接口 `/api/products/[id]/purchase-receipt-history`、`PUT /api/purchase-orders/[id]`（Expected Arrival 单独编辑）、Confirm Receipt 回写 `firstArrivedAt`/`lastArrivedAt` 做了真实数据验证，含401鉴权探针。
- 本机 Chrome 可执行文件缺失（已知环境问题），未做浏览器真实点击验证；本地开发库数据极少（仅2张测试采购单且都没填规格描述），没法用真实业务数据做视觉检验。
- 部署后 SSH 核对容器镜像：`ghcr.io/erichecan/veggie:6e23ac34c47af7d46b091b84e35a7180885a4009`，与推送的 HEAD commit hash 完全一致，容器状态 `Up (healthy)`。
- 生产探活：`https://www.johnstonebros.ie/api/health` → HTTP 200。

## CI 既有失败（与本次改动无关，未处理）

- `CI` workflow：<https://github.com/erichecan/veggie/actions/runs/38836601833>，"测试（含权限守卫）"+"权限可达性快照" 两步失败，7 条 not ok。
- 核对：这组失败在上一个提交 `7f39349a`（本次改动之前）就已经是红的，且与 20261014 发布记录里"全量测试 985 条，失败 7 条，均为既有 RBAC 快照/写入闸/导出可达性基线问题"完全对应（同一批 7 条 not ok 编号）——确认是既有基线漂移，不是本次两个提交引入的。`Deploy to droplet` 不依赖该 CI 结果，本次生产构建、迁移、健康检查均已通过。
- 未处理：不在本次任务范围内，留给后续单独任务处理基线漂移（`/api/auth/register`、`/api/cron/ledger-check` 未登记进可达性快照）。

## 待观测

- 定性观测：请业务员实际点开采购分析「明细」「分层明细」两个 tab，看商品名是否带规格/描述、展开/分隔线是否符合预期；商品详情页 Forecast Qty / Cost 历史 / BBD 展示是否正常；采购单详情页 Expected Arrival 编辑和 Arrived Date 展示是否符合预期。状态：待你确认。
- 技术观测：无需额外观测窗口——视图加列和白名单字段编辑都是只读/新增性质，不改变既有写路径的默认行为，发布即生效，生产探活已通过。状态：已达成（技术侧）。

---

# 2026-10-15（第二次发布）库存总览页三个 KPI 卡片接上真实跳转

- 代码提交：`fd6b095e`（库存总览页三个 KPI 卡片 + 低库存关注项接上真实跳转），已推送 `main`，无 schema 变更。
- GitHub Actions `Deploy to droplet`：<https://github.com/erichecan/veggie/actions/runs/38838337866>，结果 `success`。

## 改动内容

- Expiring Lots 卡片 → 批次台账页（Lots）新增 `EXPIRING` 模式，`?expiring=1` 跳转进去自动展示「7 天内到期（含已过期）」的跨商品批次清单，口径与总览 KPI 对齐（`EXPIRING_DAYS=7`）。
- This Month's Loss Rate 卡片 → 库存流水页（Moves）带 `?type=SCRAP&from=本月1日&to=今天` 预筛选。
- Pending Stock Takes 卡片 → 盘点列表页（Stock Take）新增状态筛选 UI，`?status=DRAFT` 预筛选；后端 `/api/stock-takes` 本来就原生支持 `status` 参数，未改后端。
- 低库存关注项（NEEDS ATTENTION 列表）的 `actionHref` 从指回总览页本身改成商品详情页 `/classic/operator/products/[id]`。
- Total Stock Value 卡片不加点击跳转（已跟用户确认，无单独维度可下钻）。

## 验证结果

- `npx tsc --noEmit`（无输出）、`npm run build`（exit 0）、`eslint` 针对改动文件全绿（1 条无关预存在 warning，在未改动的 TRACE 模式 effect 里，已核对非本次引入）。
- 本地 dev server（3001）curl 真实数据验证：`/api/stock-takes?status=DRAFT` 只返回 DRAFT 单、`?status=DONE` 只返回 DONE 单；`/api/analytics/inventory-overview` 返回的低库存条目 `actionHref` 确认已变成商品详情页路径；`/api/stock-moves?type=SCRAP&from=...&to=...` 返回 200 非报错；`/api/lots/expiring` 未带 token 返回 401（之前判断该路由"无鉴权"是误判，实际由 middleware 路由表守护，已带 token 验证可正常取数）。
- 本机 Chrome 可执行文件缺失（已知环境问题），**未做浏览器真实点击/视觉验证**，只做到接口层面确认参数生效，如实披露此限制。
- 部署后 SSH 核对容器镜像：`ghcr.io/erichecan/veggie:fd6b095edd78e8085a9994f35f86f54d5f226649`，与推送的 HEAD commit hash 完全一致，容器状态 `Up (healthy)`。
- 生产探活：`https://www.johnstonebros.ie/api/health` → HTTP 200。

## 已知口径限制（已告知用户，非隐瞒）

- 本月损耗率卡片的 SQL 口径同时统计 SCRAP 和盘点负调整两类流水，但点击跳转只能预筛 `type=SCRAP` 一种——因为 `/api/stock-moves` 的 `type` 参数是单值精确匹配，不支持多值 OR；盘点负调整那部分流水不在跳转后的默认视图里，需要另外手动筛"调整"类型查看。

## CI 既有失败（与本次改动无关，复核同一批编号）

- `CI` workflow：<https://github.com/erichecan/veggie/actions/runs/38838337814>，"测试（含权限守卫）"+"权限可达性快照" 两步失败，7 条 not ok（90/147/530/533/566/608/609），与前次发布记录里的同一批编号完全对应，确认是既有基线漂移，非本次引入。`Deploy to droplet` 不依赖该 CI 结果。

## 待观测

- 定性观测：请实际点一下库存总览页三个 KPI 卡片，看跳转目标和自动筛选条件是否符合预期（尤其是损耗率卡片只筛到 SCRAP、不含盘点调整这一点，是否需要后续再扩展）；再点一下「NEEDS ATTENTION」里的低库存条目，确认跳到的商品详情页是想要的落点。状态：待你确认。
- 技术观测：无需额外观测窗口，纯前端跳转链接 + 后端已有参数的接入，不改变既有数据写路径，发布即生效，生产探活已通过。状态：已达成（技术侧）。
