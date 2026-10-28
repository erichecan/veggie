# 2026-10-28 生产发布记录：退货/报废流程整合

- 代码提交：`513eb181`（含本次整合全部 7 个 commit，自 `10ec5f66` 起），已推送 `main`。
- 迁移：`20261027230000_dispatch_goods_return_grant`（RBAC 权限发放）+ `OrderReturn` 表相关迁移，随 CI `prisma migrate deploy` 一并执行。
- GitHub Actions `Deploy to droplet`：run `40682219651`，结果 `success`。
- 容器核实：SSH 到 167.99.86.19，`ghcr.io/erichecan/veggie:513eb1814d72d28ecc9ad5f636d208df03b3c58b`，`Up (healthy)`。
- 站点核实：`https://www.johnstonebros.ie/` → `200`；`GET /api/order-returns`（无 token）→ `401`（新路由已注册，非 404）；`/classic/operator/daily-sales`、`/classic/operator/inventory`（未登录）→ `307` 跳登录，符合预期。
- ⚠️ 未能用真实账号登录核实界面：本地测试账号（用户名 `operator3`，域 `demo.local`）在生产库不存在（`401 邮箱或密码错误`，符合预期——生产库是真实客户/员工数据，没有 demo 测试账号）。界面级验证需要用户本人用真实账号登录核实。

## 本次改动想达成什么

仓库核实（warehouse/returns）+ 销售审核（operator/returns）+ 日销售中心手动登记（daily-sales 新 tab）三条独立记账路径收编为一条：统一看板、统一 OrderReturn 表、统一 Order 角标回写。此前这三条路径各管一摊，审核逻辑/数据存放分散。

## 技术观测（我负责）

- `tsc --noEmit` 清；`npm run build` 全绿；`verify-order-returns.py` 29/29；`verify-return-flow.py` 16/17（1 项既有非回归，见 commit `2dfb17e0`）。
- `/code-review high` 10 条发现 6 条已修复、2 条记为既有限制；`/security-review` 零高置信发现。详见 `DEV-REPORT.md`。
- 部署前容器镜像 tag 已核对 = 本次提交 hash，非仅看 workflow 绿。

## 定性观测（用户/客户负责）

- 待问：登录 `www.johnstonebros.ie`，用有权限的真实账号（运营/销售角色）打开日销售管理中心，确认平级多了一个「退货登记」tab，点进去能按订单号搜到已送达订单并登记退货。
- 待问：仓库和运营角色分别登录 `/classic/operator/inventory` 「退换货」tab，确认三栏看板（待核实/待审核/已处理）能看到数据并各自只能操作自己权限内的那一栏。
- 问谁：最早反馈"退货登记 tab 没实现"的用户本人，部署后请其重新登录（权限位图随登录 token 签发，老会话不会自动更新）再看一次。

## 状态

待观测——代码与路由已验证部署生效，界面级"是不是你想要的"仍待用户本人用真实账号确认。
