# T1 权限反推报告

> 生成：`npx tsx scripts/rbac/derive-system-roles.ts` · 台账 T1
> 输入：235 个 API handler + 12 个页面探针
> 权限点：181 个 · 规则：212 条 API + 12 条页面

## 1. 推导结果

| 角色 | 权限点数 | 数据范围 |
|---|---:|---|
| BOSS | 178 | ALL |
| OPERATOR | 178 | ALL |
| FINANCE | 66 | ALL |
| WAREHOUSE | 46 | ALL |
| DISPATCH | 47 | ALL |
| SALES | 49 | ALL |
| EXTERNAL_SALES | 39 | OWN |
| SORTER | 26 | ALL |
| PICKER | 19 | ALL |
| DRIVER | 24 | ALL |
| RESTAURANT | 21 | OWN |
| OTHER | 19 | ALL |

## 2. 冲突（route-map 粒度不足之处）

**无冲突。** 每个角色现在够得着的接口与页面，在新体系下都至少命中一个它拥有的权限点。
