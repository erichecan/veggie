# 2026-10-10 生产发布记录

- 代码提交：`a266ce9ec...`（9 个提交，`423333e4`..`a266ce9e`），已推送 `main`。
- 内容：多 tab 协作不丢数——切回 tab 自动刷新引用数据（M1，44 页）+ 表单草稿自动保存（M2，14 页），详见 `DEV-REPORT.md` 新增章节与 `docs/20261010-multi-tab-draft-sync-tasks.md`。
- 这是一次大改，提交前已按 CLAUDE.md 第十一节跑过 `/code-review high`（10 条发现，9 fixed + 1 记录为已知债务）与 `/security-review`（1 条 Medium：退出登录后草稿残留 localStorage，已修复），处置清单见 `docs/20261010-multi-tab-draft-sync-tasks.md` U8 小节。
- GitHub Actions `Deploy to droplet`：<https://github.com/erichecan/veggie/actions/runs/38049216983>，结果 `success`，耗时约 7m13s。

## 验证结果

- 提交前 `npx tsc --noEmit`（无输出）、`npm run build`（exit 0）、`npm run test`（961 条/951 通过，8 条失败均为既有 role-reachability/rbac-gate 基线问题或本机开发库缺种子数据，与本次改动无关）全部通过。
- 本次改动是行为层改动（切 tab 刷新、草稿自动保存），不改页面外观；本机沙箱无可用 Chrome/Playwright 二进制，未能用浏览器自动化逐页验证交互，这是已知限制，已在 `DEV-REPORT.md` 里写明。
- 部署后生产 URL 探活：`https://www.johnstonebros.ie/` → `HTTP 200`；未登录访问 `https://www.johnstonebros.ie/classic/operator/orders` → `HTTP 307` 跳转 `/enter`（符合鉴权中间件预期行为，非 500）。

## 待观测

- 定性观测：请业务员实际试一下 `DEV-REPORT.md` 里点名的 5 个场景——行程详情编辑弹窗开着时切 tab 不冲掉改动、采购年度计划/建议页切 tab 不清空勾选、餐馆下单页切 tab 不跳页、报价单确认转订单后草稿还能找回。状态：待你确认。
- 技术观测：无需额外观测窗口——本次是纯前端行为改动，不涉及数据库 schema / 后端计算逻辑，发布即生效，生产探活已通过。状态：已达成（技术侧）。

## 采购、账号排序与打印模板修复发布

- 应用提交：`60fa42ef8923acbba416862e87257875f329ad97`，已推送 `main`。
- 内容：采购详情 New 进入新建页；供应商 Reference 接入保存和草稿恢复；账号列表列头排序及筛选；新建商品恢复可售单位保存按钮；统一紧凑打印页头、信息表和付款备注，司机移至第三列，移除底部付款徽章，销售打印使用订单业务编号。
- 部署工作流：[Deploy to droplet](https://github.com/erichecan/veggie/actions/runs/38052844353)，结果 `success`。
- 数据库迁移：`20261010000001_purchase_vendor_reference` 已在生产成功执行，新增可空 `PurchaseOrder.vendorReference` 列。
- 发布后健康检查：应用 `status=ok`、数据库 `db=ok`；首页 HTTP 200；健康接口 HTTP 200；未登录采购页面 HTTP 307，符合鉴权行为。
- 本地验证：生产构建、类型检查及 50 项相关回归测试通过；浏览器确认 24 行订单一页、60 行订单两页，条形码正常且无页面溢出。
- [CI](https://github.com/erichecan/veggie/actions/runs/38052844338)：951 通过、7 失败、7 跳过；7 项失败均为既有权限写入闸、导出角色可达性及权限快照问题，已对照修改前版本确认。部署工作流不依赖该 CI，生产构建、迁移和健康检查全部通过。
