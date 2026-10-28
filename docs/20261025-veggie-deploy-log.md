# 2026-10-25 生产发布记录：商品库存预警（Low Stock Alert）

- 代码提交：`3c809434`，已推送 `main`，无新增迁移。
- GitHub Actions `Deploy to droplet`：<https://github.com/erichecan/veggie/actions/runs/40217178410>，结果 `success`。
- 容器核实：SSH 到 167.99.86.19，`ghcr.io/erichecan/veggie:3c809434eb9100c9f3ece168be20d5760a1d7b81`，`Up (healthy)`。

## 本次改动想达成什么

客户要求商品可以逐个设置库存预警值，设置后库存达到预警线时在商品列表页和库存管理页都能看到提醒；
`Product.safetyStockMin` 字段早就存在但一直没接 UI，这次接上，同时把两处判断口径统一成同一句
`lib/stock-alert.ts::lowStockSqlCondition()`，并顺手修了库存管理页原来 `IS NOT NULL` 形同虚设的判断条件。

## 技术观测（我负责）

- `tsc`/`build`/`migrate status` 全绿；路由/鉴权探针、业务不变量脚本（三商品交叉比对）全通过，详见
  `DEV-REPORT.md`。
- 生产容器镜像 tag 与本次 commit hash 一致，`curl https://www.johnstonebros.ie/` → `200`。
- 现网所有商品该字段当前值都是默认 0（没人设置过），**上线当天不会立刻跳出任何告警**——这是预期
  行为，不是功能没生效；客户第一次去商品编辑页填一个预警值之后才会看到提醒出现。

## 定性观测（用户/客户负责）

- 待问客户：挑 1-2 个经常缺货的商品，去编辑页填一个预警值，确认商品列表和库存管理页看到的提醒
  跟预期一致（样子对不对、位置顺不顺手）。
- 问谁：客户本人或日常维护商品信息的操作员。

## 状态

待观测。
