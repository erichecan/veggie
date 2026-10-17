# 2026-10-17 生产发布记录：采购运费分摊进成本联动

- 代码提交：`55d7c9ae`（T1-T4 schema+算法+confirm/cancel 分支）、`30eb3258`（T5 UI）、
  `10293a7a`（T6 verify 脚本）、`3ec9e9c6`（code-review 9 条逐条修复）、
  `7ce7a3f7`（T7 DEV-REPORT.md），已推送 `main`，含 1 个迁移（纯新增 3 列，无破坏性变更）。
- GitHub Actions `Deploy to droplet`：<https://github.com/erichecan/veggie/actions/runs/39006747144>，结果 `success`。

## 背景

客户在 PO-00140 截图上手写批注五点要求：①总运费按各行订购数量占比分摊，service 类行排除在外；
②操作员可对单行分摊运费手动 +/- 调整；③分摊合计必须等于运费总额；④确认采购这一刻把分摊后的落地
成本推到 Product.standardPrice（"public price"）；⑤取消采购单时这次形成的成本也要撤销，恢复到之前的值。
需求原话逐字存档见 `docs/20261017-采购运费分摊成本联动-需求原话.md`。

## 改动内容

- `prisma/schema.prisma` + 迁移 `20261017003802_po_line_freight_allocation_cost`：
  `PurchaseOrderLine` 加 3 字段（`allocatedFreightEur`/`landedUnitCostEur`/`standardPriceBeforeConfirmEur`）。
- `lib/purchase-landed-cost.ts`：新增 `computeFreightAllocationForConfirm`（手动覆盖优先，剩余按
  未覆盖行数量占比分摊，尾差由最后一个自动行吸收）+ `computeLandedUnitCost`。
- `app/api/purchase-orders/[id]/route.ts`：confirm 分支校验分摊合计==运费总额（差额>0.01→409，
  任一行分摊为负→409），事务内写入分摊结果并推送 `Product.standardPrice`；cancel 分支按
  确认前快照回滚（仅当当前成本价仍等于确认时写入值才回滚，避免覆盖更晚的单）；reset_to_draft
  分支补上清空分摊快照字段。
- `app/[locale]/classic/operator/purchases/[id]/page.tsx`：Cost 列换成 ⓘ 悬停提示历史参考成本，
  新增可编辑「分摊运费」列（SERVICE 行禁用），分摊合计/运费总额校验横幅，Confirm/Approve 按钮前置
  客户端同款校验。
- `lib/purchase/receive-purchase-order.ts`：收货加权平均改用含运费的 `landedUnitCostEur`（原来用
  不含运费的 `unitCostEur`，会被"确认收货"这个正常下一步把 confirm 刚写入的含运费成本冲掉）。
- 新增 `scripts/verify-po-freight-allocation.{sh,py}`：本功能专属验收探针。

## 验证结果

- `npx tsc --noEmit` 零输出。
- `scripts/verify-po-freight-allocation.sh` 实跑全绿（鉴权 401/401、分摊不一致 409、confirm 写成本、
  cancel 回滚、SERVICE 行排除分摊）；唯一未验证项是低权限 confirm→403（当前 seed-rbac.json 没有
  "有 update 无 approve" 这种权限组合的角色，无法用真实账号跑）。
- 手工补测 confirm→receive 链路：confirm 后 `standardPrice`=5.0（含运费落地成本），receive 后仍是
  5.0（未修复前会被加权平均冲回不含运费的 2.x）——`/code-review high` 发现的最高严重性问题，已修复
  并复测通过。
- `/code-review high` 返回 9 条，7 条已修复、2 条记录为已知限制（详见 DEV-REPORT.md 存档栏）；
  `/security-review` 自查无新增漏洞（无原始 SQL、无新注入面、鉴权复用既有 withAuth+FINER_GATE）。
- 本机 Chrome 可执行文件缺失（已知环境问题，见记忆 `chrome-binary-missing-for-browser-mcp-20261014`），
  Cost 列图标位置/禁用态样式等纯 UI 视觉验收未做真实浏览器点击，接口层计算逻辑已验证一致。
- 部署后 SSH 核对容器镜像：`ghcr.io/erichecan/veggie:7ce7a3f7b4a0103a25c14d4d3c1ea40048dfcf0a`，
  与推送的 HEAD commit hash 完全一致。
- 生产探活：`https://www.johnstonebros.ie/` → HTTP 200；`/api/health` → HTTP 200；
  未登录访问 `/zh/login` → 307 正确跳转 `/zh/enter`（非 500/404）。

## 待观测

- 定性观测：请打开一张有运费的采购单（采购单详情页），确认 Cost 列的 ⓘ 悬停提示、分摊运费可编辑列、
  分摊合计/运费总额校验横幅的**长相和位置**符合预期（本次只验证了计算逻辑，没验证过视觉效果，见上方
  Chrome 环境限制）；另外请确认"确认采购后 standardPrice 立即变成含运费成本"这个效果是不是你/客户
  想要的那种"立即生效"，而不是"等到真正收货才生效"。状态：待你确认。
- 技术观测：无需额外观测窗口——verify 脚本+手工补测已覆盖 confirm/cancel/receive 全链路核心路径，
  发布即生效，生产探活已通过。状态：已达成（技术侧）。
