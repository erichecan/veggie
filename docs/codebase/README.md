# North Fresh · 项目理解文档（codebase）

> 这套文档基于对 `app/`、`lib/`、`prisma/` 的真实代码静态分析产出，作为设计种子数据与后续开发的长期基础。
> 结论均标注文件路径+行号；不确定处标「待确认」。更新于 2026-06-13。

## 一句话

**North Fresh** 是面向爱尔兰中餐馆的蔬菜/食材 **B2B 配送系统**（Next.js App Router + Prisma + PostgreSQL）。当前由**运营代客下单**，未来上 C 端（customer-portal 已有雏形）。业务主线：**报价 → 确认（确认即扣库存）→ 拣货波次 → 分货 → 装车配送 → 签收完成 → 开票过账（生成应收凭证）→ 收款核销 → 对账单**；并行有**采购链**（采购单 → 收货入库 → 供应商账单）和**会计链**（科目 + 凭证，仅销售发票过账自动记账）。9 个角色（OPERATOR/BOSS/FINANCE/DRIVER/SORTER/WAREHOUSE/RESTAURANT + 隐式的 SALES/PICKER）各有工作台，鉴权走 JWT + 轻量 RBAC 矩阵。

## 关键特征（设计种子必知）

- **确认订单会扣库存**（CONFIRMED 时 `qtyOnHand -= qty` + StockMove(OUT)），下单 PENDING 不扣 —— 见 [03 §5](03-business-rules.md)。
- **发票过账自动生成凭证**（Dr 应收/Cr 收入+销项税）；但**采购账单、收款不自动记账，司机佣金不自动计算**（缺口见 [03 §12](03-business-rules.md)）。
- **报表无毛利、无账龄分桶**；三大透视报表绑定 `veggie_*_report` 视图 —— 见 [04](04-features-and-reports.md)。
- **现有种子按表灌数、绕过业务逻辑、整链空白**，导致割裂 —— 见 [05](05-data-sources-and-seed-state.md)。

## 文档索引

| 文档 | 内容 |
|---|---|
| [00-overview](00-overview.md) | 技术栈、认证鉴权、目录结构、多租户、整体架构 |
| [01-data-model](01-data-model.md) | 38 表按域分组 + 字段/关联 + 枚举 + 报表 VIEW SQL |
| [02-roles-and-workflows](02-roles-and-workflows.md) | 9 角色工作台 + 订单/采购/会计状态机 + 跨角色交接点 |
| [03-business-rules](03-business-rules.md) | 定价/税/佣金/库存/账龄/毛利/对账/审批 真实逻辑 + 代码缺口 |
| [04-features-and-reports](04-features-and-reports.md) | 功能模块清单 + 透视报表引擎 + BOSS 报表页 |
| [05-data-sources-and-seed-state](05-data-sources-and-seed-state.md) | 各表数据来源 + 种子割裂根因 |

## 相关（种子数据设计）
- [../20260612-seed-data-design.md](../20260612-seed-data-design.md)
- [../20260612-seed-data-refactor-plan.md](../20260612-seed-data-refactor-plan.md)
