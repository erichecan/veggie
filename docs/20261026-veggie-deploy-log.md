# 2026-10-26 生产发布记录：核销触发开票 + 对账单改按送货日期

- 代码提交：`8e9cc668`，已推送 `main`，无新增迁移。
- GitHub Actions `Deploy to droplet`：<https://github.com/erichecan/veggie/actions/runs/40434141053>，结果 `success`。
- 容器核实：SSH 到 167.99.86.19，`ghcr.io/erichecan/veggie:8e9cc668e721b5928400bbfcc3ad8e26420482b7`，`Up (healthy)`。
- 站点核实：`https://www.johnstonebros.ie/` → `200`；核销相关页 `/zh/classic/finance/ledger-check` → `307`（未登录重定向到登录页，鉴权行为正常，不是 500/404）。

## 本次改动想达成什么

开票时机从"订单标记完成"挪到"会计核销确认"之后，发票按核销时核对过的实际送达数量开，提成
冻结也挪到同一时点；对账单 (Statement) 的订单归属口径从 `confirmationDate` 改成 `deliveryDate`。
详见 `DEV-PLAN.md`/`DEV-REPORT.md`，任务台账 `docs/20261026-核销触发开票与对账单口径-tasks.md`。

## 技术观测（我负责）

- `tsc`/`build` 全绿；测试套件 1007 个（新增 3 个），1004 pass / 2 skip / 1 fail（唯一失败是本地库
  业务数据缺口，与本次改动无关）。
- `/code-review high` 4 个发现全部处理（3 修复 + 1 记录为非独立缺陷不处理），`/security-review` 零发现。
- 生产库部署前探针：可入账状态且 `deliveryDate` 为空的订单仅 89 条 `CONFIRMED`（刚确认还没排波次
  的正常中间态），波次↔`deliveryDate` 不变量成立，Statement 改按 `deliveryDate` 后不会漏算真实应收。
- 顺带发现并修复：`bulk-invoice` 与新增 `[id]/lines` 两条路由从创建起漏登记 `lib/rbac/route-map.ts`
  （新旧 token 一直 403，本次修复前功能从未可用，不是收紧），已补登记+刷新 parity-baseline 快照。

## 定性观测（用户/客户负责）

- 待问：会计下次在核销管理页「待核销」tab 点开一张单，核对/改送达数量后点「确认核销」，看发票是不是
  这时候才生成、金额是不是按改过的数量算——跟以前"标记完成就有发票"的习惯不一样，确认体感上能接受。
- 待问：财务对一个客户生成新对账单，确认里面的订单范围跟预期一致（按送货日期而不是确认日期）。
- 问谁：日常做核销确认的会计，或核对对账单的财务。

## 状态

待观测。
