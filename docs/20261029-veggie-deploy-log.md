# 2026-10-29 生产发布记录：退换货补全 + 新建「车辆检查」tab

- 代码提交：合并提交 `23b9955f`（含本轮 M1-M8 + 收尾全部 14 个 commit，自 `0792d515` 起），推送时撞上另一会话并发推送的 15 个不相关提交（客户/定价/权限改动），已用普通 merge 合并（非 rebase/force），`lib/rbac/parity-baseline.json` 一处冲突手工合并后跑 `scripts/rbac/verify-parity.ts` 核对，跟纯 `origin/main` 的既有缺口（15 处，均为更早的 ProductTemplate 合表重构遗留、与本轮无关）完全一致，确认未引入新drift。
- 迁移：`20261028000001_add_order_return_sales_note`、`20261028000002_bulletin_goods_return`、`20261028000003_add_invoice_supersession`、`20261028000004_add_invoice_supersession_column`，随 CI `prisma migrate deploy` 一并执行；并发合入的 `20261028190000_boss_goods_return_grant`、`20261028210000_product_show_in_portal` 也在同一次部署里一起跑。
- GitHub Actions `Deploy to droplet`：run `40817378085`，结果 `success`，耗时 6m56s。
- 容器核实：SSH 到 167.99.86.19，`ghcr.io/erichecan/veggie:23b9955fb6f5f3486024201c170ab085b5514ec1`，镜像 tag 与本次合并提交完整 hash 一致。
- 站点核实：`https://www.johnstonebros.ie/zh/enter` → 跟 307 走最终渲染出登录页（`<title>蔬菜批发管理系统</title>`）；未登录访问 `/classic/operator/inventory` → 跟跳转最终落到登录页 200，不是 500。

## 本次改动想达成什么

把"仓库次日验车"从「退换货」tab 的三栏看板拆出来，单独建一个「车辆检查」tab，只呈现待核实队列；同时补齐上一轮"退货/报废整合"走查后发现的 5 个流程缺口（司机报备照片/补报原因必填、仓库核实通过自动通知+跳转高亮、审核备注不互相覆盖、核销管理看得出退换货异常、手工登记路径也能转退款单）+ 发票换开新票（M8）。

## 技术观测（我负责）

- `tsc --noEmit` 清（含合并后 Prisma client 重新生成）；`npm run build` 全绿。
- `/code-review high` 9 条发现全部修复（commit `74bd0031` 5条 + `82dd196e` 4条）；`/security-review` 1 条发现已修复（commit `32b91852`）。详见 `DEV-REPORT.md`。
- 部署前容器镜像 tag 已核对 = 本次合并提交完整 hash，非仅看 workflow 绿。

## 定性观测（用户/客户负责）

- 待问：仓库角色登录 `/classic/operator/inventory`，确认顶部多了一个独立的「车辆检查」tab，跟原「退换货」tab 并存，不互相干扰。
- 待问：仓库核实一条记录后，运营/销售在「消息广场」能看到自动通知，点开能跳转并直接弹出对应记录详情（这条此前有 bug，本轮收尾修复）。
- 问谁：最早要求"迁移验车流程到独立 tab"的用户本人，部署后请其重新登录（权限位图随登录 token 签发）再实际走一遍。

## 状态

待观测——代码、路由、镜像 tag 均已验证部署生效，界面级"是不是你想要的"仍待用户本人用真实账号确认（本机 Chrome 缺失，未能截图）。
