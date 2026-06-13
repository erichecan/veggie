# 已弃用的旧种子脚本（DEPRECATED）

> 归档于 2026-06-13。这些脚本是「按表灌数据」模式，各自独立 `create`，绕过真实业务逻辑，
> 导致数据割裂、不守恒（如 `seed-transactions.ts` 设了 `amountPaid` 却不建 `Payment` 行，
> 被 `npm run db:validate` 当场判为脏数据）。

## 已被取代

全部由**事件驱动种子**取代：`prisma/seed-events/`（`npm run db:seed:events`）。
它按时间线重放真实业务事件，数据天然因果相连、守恒可断言。

| 旧脚本 | 取代它的 |
|---|---|
| `seed-orders-stock.ts` | `seed-events/events/sales.ts`（下单/确认扣库存）+ `purchase.ts`（进货入库） |
| `seed-trips.ts` / `seed-waves.ts` | `seed-events/events/sales.ts`（波次/行程） |
| `seed-returns.ts` | `seed-events/events/scenarios.ts`（退货信用票） |
| `seed-transactions.ts` | `seed-events/events/billing.ts`（开票/收款/对账）+ 全链 |

## 注意

- **`prisma/seed.ts`（主数据）未弃用**，仍是 `npm run db:seed` 的入口，事件种子依赖它。
- 这些文件仅作历史参考，不应再运行。它们产生的脏数据（标记 `seed-tx` / `TST-*`）已在 2026-06-13 从开发库清除。
- 确认不再需要后可整个删除本目录。
