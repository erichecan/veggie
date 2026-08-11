# 迁移链没有基线 —— 无法从空库建库 · 20260811

> 台账 Z6。这条对**私有化部署到客户服务器**有直接影响，不是纯技术洁癖。

## 事实

**`prisma migrate deploy` 无法从空库建起这个数据库。**

实测：新建空库 → `migrate deploy` → 第一个迁移 `20260419_decimal_partner_indexes`
即失败。Prisma 报的是：

```
ERROR: current transaction is aborted, commands ignored until end of transaction block
```

这条错误**掩盖了真正的原因**。用 psql 直接跑同一个文件才能看到首个真错：

```
ERROR: relation "ProductTemplate" does not exist
```

## 根因：缺一个初始迁移

核心表**没有任何迁移创建过**：

| 表 | 被 CREATE TABLE 的迁移数 |
|---|---:|
| ProductTemplate | 0 |
| Product | 0 |
| Customer | 0 |
| Order | 0 |
| User | 0 |

69 个迁移里只有 18 个含 `CREATE TABLE`，且全是 20260419 之后**新增**的表。
链条的第一个迁移上来就 `ALTER TABLE "ProductTemplate"`，显然假定表已经存在 ——
项目早期用 `db push` 建的库，此后才开始写迁移，但**从未补上基线**。

结论：**迁移链只支持增量演进，不支持重建。** 这不是某个迁移写错了。

## 影响

- ⚠️ **私有化部署**：客户服务器若需从零起步，`migrate deploy` 会直接卡住
- ⚠️ **灾难恢复**：没有备份可用时，无法靠迁移链重建结构
- ⚠️ **新人上手 / CI 起测试库**：同上
- ✅ **日常增量部署不受影响**：droplet 上的库是搬过去的存量库，`migrate deploy` 只跑新迁移，一直是正常的

## 当前可行路径（已验证）

`scripts/db/bootstrap-fresh.ts` 固化了这条路，**已在空库上端到端跑通**：

```bash
npx tsx --env-file=.env.test scripts/db/bootstrap-fresh.ts --with-events --with-stock
```

1. `prisma db push` —— 直接把 schema 同步成表结构，绕开无基线的迁移链
2. **补 RBAC 数据迁移** —— 角色与权限点写在数据迁移里，`db push` 会跳过。
   不补的后果不是「权限没配」，而是全零位图让**所有带鉴权 API 一律 403**（见台账 Z7）
3. 基础种子 → 4. 事件种子 → 5. 期初库存

实测产出：53 张表 · 19 个角色 · 1677 个有库存商品 · 210 订单 / 113 发票 /
229 凭证 / 73 对账单，`db:validate` **11 项不变量全绿**。

## 要不要修（建议：暂不修，但要知情）

标准修法是 **baseline / squash**：

1. `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`
   生成一个 `0_init` 迁移
2. 把它放在迁移目录最前面
3. **对已有的库（droplet 生产库）执行 `prisma migrate resolve --applied 0_init`**，
   否则下次 `migrate deploy` 会在已有表上跑 CREATE TABLE 而炸掉
4. 归档原来的 69 个迁移

⛔ **第 3 步是生产影响操作**，必须与部署同步进行 —— 如果只把 `0_init` 合进主干
而没有先在生产库 resolve，**下一次 push main 会直接把生产部署搞挂**。

因此本次**不擅自执行**。当前 `bootstrap-fresh.ts` 已经覆盖了所有从零建库的实际
需求（私有化部署、灾备演练、CI），修基线的收益主要是「让 `migrate deploy` 语义
完整」，可以等一个能同时协调生产库的窗口再做。

## 给部署文档的一句话

> 从零部署本系统时，**不要**用 `prisma migrate deploy` 建库，
> 用 `scripts/db/bootstrap-fresh.ts`。`migrate deploy` 只适用于已有库的增量升级。
