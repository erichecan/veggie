# 开发完成报告 — 下单与配送增强

> 完成日期：2026-06-16
> 需求来源：[docs/20260616-下单与配送增强-需求与设计.md](docs/20260616-下单与配送增强-需求与设计.md)

## 本次开发了什么

围绕「下单提醒」和「报价单 → 销售单 → 配送调度 → 拣货」主流程做了 6 项增强。盘点后发现其中 4 项已在既有代码实现，本次**新开发 2 项**（下单重复商品提醒、销售单打印状态追踪），并对其余 4 项做了端到端验证；过程中顺带修复 1 个会让报价单页崩溃的既有空值 bug。

## 测试账号

| 角色 | 登录方式 | 账号 |
|------|----------|------|
| 运营 OPERATOR | 登录页「演示账号」一键登录「运营」 | operator@veggie.com（演示） |

## 功能完成情况

| # | 需求 | 状态 | 说明 |
|---|------|------|------|
| 1 | 下单低库存提醒 | ✅ 验证通过 | place-order 选品 toast +顶部红色 banner（基于 ATP 可承诺量） |
| 2 | 下单重复商品提醒 | ✅ 新开发 | place-order 顶部紫色 banner + 重复行左紫边框/🔁 角标；报价单 CSV 导入预览也有同款重复提示（按餐馆+商品+规格判重） |
| 3 | 批量确认转销售单 | ✅ 验证通过 | 确认后从报价单列表（PENDING）移除，进入销售单列表（CONFIRMED+） |
| 4 | 待分配订单池 | ✅ 验证通过 | 配送调度中心「批次管理」左侧「📥 待分配」竖条，含刚确认未入批的销售单 |
| 5 | 销售单打印状态 | ✅ 新开发 | 销售单列表新增「打印状态」列（未打印/已打印✓+时间+打印人+次数）+ 行内「🖨 打印…」下拉（送货单/销售单）；新增鉴权 API `POST /api/orders/[id]/mark-printed` |
| 6 | 拖拽分配+托盘+拣货单 | ✅ 验证通过 | 拖拽分配（assign）、托盘编排器（PalletEditor 商品池）、拣货单（PickSheetModal 按托盘①②分组显示每盘货品+客户+拣货勾选+签名行） |

## 可以访问的页面

| 页面 | 地址 | 涉及需求 |
|------|------|---------|
| 代客下单 | /classic/operator/place-order | 1、2 |
| 报价单列表（含 CSV 导入） | /classic/operator/quotations | 2、3 |
| 销售单列表 | /classic/operator/orders | 3、5 |
| 配送调度中心 | /classic/operator/dispatch-console | 4、6 |
| 单订单打印（送货单/销售单） | /classic/print/[id]?doc=delivery\|sales | 5 |

## 验证结果

| 用户流程 | 验证方式 | 结果 |
|----------|----------|------|
| 低库存提醒 | place-order 选无库存商品 | ✅ toast「可承诺量 0」+ 红色 banner |
| 重复商品提醒（下单） | place-order 加 2 次同商品 | ✅ banner「Aji Chicken Powder ×2」+ 2 行高亮 |
| 重复商品提醒（导入） | 报价单导入含重复行的 CSV | ✅ banner「Restaurant A / 洋葱 ×2」 |
| 批量确认转销售单 | 确认 EVT-SO-000124 | ✅ 报价单列表移除、销售单列表出现 |
| 打印追踪 | 调 mark-printed（送货单→销售单） | ✅ count 1→2、type 更新、记录打印人「运营主管」+时间 |
| 打印鉴权 | 错误 token / 无效 type | ✅ 401 / 400 |
| 待分配池 | 调度台批次管理 | ✅ 待分配竖条含刚确认订单 |
| 拖拽分配 | assign EVT-SO-000124 → AFZAAL | ✅ 待分配 41→40、已入批 0→1 |
| 拣货单 | 编排 2 托盘后打印 | ✅ 按托盘①②分组显示 8 SKU/71 件 + 客户 + 勾选框 |

## 数据库变更

`Order` 表新增 5 字段（迁移 `20260616120000_order_print_tracking`）：`printedAt`、`printedById`、`printedByName`、`printType`、`printCount`。
> 注：因历史迁移在 shadow database 上无法干净重放（既有问题，P3006），本次用 `prisma db push` 同步实际库 + 补迁移文件并 `migrate resolve --applied`，保持迁移历史一致。

## 顺带修复的既有问题

- **报价单页崩溃**：`quotations/page.tsx` 的 `orderDriverMap` 在 `r.orderIds` 为 undefined 时 `forEach` 崩溃，导致整页进入错误边界。已加空值防御（`r.orderIds?.forEach`）。
- **构建被弃用脚本阻断**：`prisma/legacy-seeds/`（2026-06-13 已弃用归档，无活跃引用）的旧脚本 import 路径错误，导致 `next build` 类型检查失败。已在 `tsconfig.json` 的 `exclude` 中排除该归档目录。

## 已知问题 / 说明

- 打印状态只保留「最近一次」（时间/打印人/类型）+ 累计次数，不保留完整打印历史（按 YAGNI 未建历史表）。
- 送货单与销售单复用同一单订单打印模板 `print/[id]`，通过 `?doc=` 区分标题（Delivery NO / Sale Order NO）；如需两种单据差异化排版可后续扩展。
