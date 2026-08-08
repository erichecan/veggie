# T1 权限反推报告

> 生成：`npx tsx scripts/rbac/derive-system-roles.ts` · 台账 T1
> 输入：242 个 API handler + 12 个页面探针
> 权限点：181 个 · 规则：214 条 API + 12 条页面

## 1. 推导结果

| 角色 | 权限点数 | 数据范围 |
|---|---:|---|
| BOSS | 163 | ALL |
| OPERATOR | 163 | ALL |
| FINANCE | 47 | ALL |
| WAREHOUSE | 27 | ALL |
| DISPATCH | 28 | ALL |
| SALES | 30 | ALL |
| EXTERNAL_SALES | 20 | OWN |
| SORTER | 7 | ALL |
| PICKER | 0 | ALL |
| DRIVER | 5 | ALL |
| RESTAURANT | 2 | OWN |
| OTHER | 0 | ALL |

## 1.2 有意新增的权限（不属于平迁范围）

| 角色 | 权限点 | 理由 |
|---|---|---|
| BOSS | system.rbac.read、system.rbac.manage | 权限配置页是本次新增的功能，改造前不存在，反推不出来。老板要能配权限。 |
| OPERATOR | system.rbac.read、system.rbac.manage | 运营是后台本身，日常的账号与角色维护由他们做。 |
| BOSS | purchase.order.approve、purchase.order.receive | 改造前有 purchase.order.update 即可审批/收货，拆细后要显式补回，否则审批断掉。 |
| OPERATOR | purchase.order.approve、purchase.order.receive | 同上。 |

## 1.5 无人拥有的权限点

17 个权限点没有任何预置角色拥有 —— 这通常是对的：
它们对应「改造前不存在的功能」（例如权限配置页自己的接口）。
要让某个岗位用上，得在配置页里显式勾给它。

```
sales.order.confirm
sales.order.cancel
sales.quotation.access
sales.daily_report.read
purchase.order.approve
purchase.order.receive
purchase.plan.read
stock.receipt.confirm
dispatch.console.access
finance.invoice.cancel
finance.vendor_bill.pay
master.customer.delete
master.supplier.update
master.supplier.delete
analytics.commission.read
system.gdpr.manage
system.settings.read
```

## 2. 冲突（route-map 粒度不足之处）

**无冲突。** 每个角色现在够得着的接口与页面，在新体系下都至少命中一个它拥有的权限点。
