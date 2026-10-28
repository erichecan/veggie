# 2026-10-27 生产发布记录：客户门户下单不传单位时落回基准单位

- 代码提交：`088ca0c8`，已推送 `main`，无新增迁移。
- GitHub Actions `Deploy to droplet`：run `40611862984`，结果 `success`。
- 容器核实：SSH 到 167.99.86.19，`ghcr.io/erichecan/veggie:088ca0c82a2096c7d66cff87fee0a6d8ffaa4b12`，`Up (healthy)`。
- 站点核实：`https://www.johnstonebros.ie/` → `200`。

## 本次改动想达成什么

报价单 `D-261026-002`（客户 test 2 自助下单）上 Mushroom 这行单位显示成「⚠ Unit(s)」警告，
商品本身明明配的是 CASE。根因：客户门户购物车里若有一行没带 `uomId`（典型是多单位功能
20261026 上线前就留在购物车里的旧行），`resolveOrderLines` 只按商品基准单位算了价，却从没
把这个基准单位的 `uomId`/`uomName` 回填到订单行上——行上单位字段直接落空，显示层把"沿用
基准单位"误判成"商品没配单位"。

## 技术观测（我负责）

- `tsc --noEmit` 全绿。
- 改动范围：`lib/server-pricing.ts` 单文件，`resolveOrderLines` 内没传 `uomId` 时落回
  `dbProduct.uomId` 及其真实单位名，taxRate 字段本来就是这个口径，单位字段是漏了。
- 生产库数据修正：直连生产库核实后，`D-261026-002` 的 Mushroom 行 + 另外 15 笔同样受影响的
  历史门户订单行，已按各自商品的基准单位批量回填（如 Mushroom 回填为 CASE）。

## 定性观测（用户/客户负责）

- 待问：打开报价单 `D-261026-002`，确认 Mushroom 这行"Unit of Measure"列现在显示 CASE，
  不再是 ⚠ 警告。
- 问谁：发现这个 bug 的用户本人。

## 状态

待观测。
