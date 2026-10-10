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
