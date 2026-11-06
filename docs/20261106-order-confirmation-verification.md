# 订单确认隔离验证结果

## 执行范围

使用本机独立 PostgreSQL 16 容器 veggie-confirm-audit-pg，端口 127.0.0.1:55439，数据库 confirmation_audit。由当前 Prisma schema 建表，并补入 active-wave 部分唯一索引。所有客户、用户、商品、订单均为合成数据；未访问生产库。

脚本直接调用真实 API route handlers（含其 withAuth），使用真实 Prisma 和 PostgreSQL。未启动 Next HTTP 服务，不覆盖中间件、浏览器交互、多实例缓存或线上历史数据。故障由测试库临时 trigger 触发；并发由 Promise.all 发起，其中订单更新增加 pg_sleep 扩大重叠窗口。结果是可复现的后端集成证据，不代表生产频率或所有并发排列。

三个入口：单单 PUT /api/orders/[id]、批量 POST /api/orders/bulk、直接创建已确认单 POST /api/orders。

## 观察结果

| 场景 | 实际结果 | 结论 |
| --- | --- | --- |
| 单单确认，无司机 | 200；CONFIRMED；无波次；一张送货单 | 符合当前规则 |
| 单单确认，预安排司机 | 200；WAVE_ASSIGNED；一个波次；一条托盘商品明细；一张送货单 | 正常路径通过 |
| 批量确认，预安排司机 | 修复前 200 但无送货单；修复后有且仅有一张 | 本轮已小范围修复 |
| 再次批量确认 | 400，提示无待处理订单；原波次与送货单数量不变 | 不重复写入，但响应语义与单单重复不同 |
| 直接创建已确认单，预安排司机 | 201；CONFIRMED；保留司机意向但没有波次；一张送货单 | 入口派车行为仍不一致 |
| 重复单单确认 | 两次 200；波次、托盘、送货单各一份；确认审计两条 | 核心关联未重复，确认日志不是幂等 |
| 目标波次已拣货锁定 | 409；订单恢复 PENDING；无新增归属/送货单；基础单位需求为 0 | 该失败分支恢复正确 |
| 派车后写 OrderAuditLog 注入失败 | 500；订单仍 WAVE_ASSIGNED，波次和托盘已保存；无送货单 | 没有整体回滚 |
| 单单送货单插入注入失败 | 200；订单与派车成功，但无送货单 | 存在成功响应下的联动遗漏 |
| 三单批量，第二次建波次注入失败 | 500；一单已派车，一单回退 PENDING，另一单已 CONFIRMED 但未派车；没有逐单结果反馈 | 批量存在半完成及未处理单提前确认 |
| 两次单单并发确认 | 两次 200；一个波次、一条托盘明细、一张送货单；两条确认审计 | 本轮核心关联未重复；非完整并发正确性证明 |
| 单单与批量并发确认 | 两次 200；核心关联各一份；两条确认审计 | 同上 |
| 创建订单，OrderLine 插入注入失败 | 500；订单总数与故障前相同 | 创建事务在该写入点回滚正确 |
| 直接创建，顺序重用同一幂等键 | 两次 201，返回相同订单 ID | 同进程顺序重试通过 |
| 直接创建，并发重用同一幂等键 | 多轮出现两种结果：201/201 且不同订单 ID；201/500（code 唯一冲突） | 并发幂等未保证，不是可接受的稳定重试契约 |

数量验证：合成商品基础单位 KG，每 CASE = 10 KG，订单 2 CASE。三个正常入口的基础单位待出库需求均为 20 KG；本轮所有确认场景在手量保持 1000，没有发生确认即出库。此项不覆盖实际出发后的库存处理。

## 本轮调整及前后对比

只调整 app/api/orders/bulk/route.ts：成功处理确认单时 upsert 送货单，复用订单客户和交货日期。修复前正常批量确认缺失送货单，修复后为一张；重复批量提交和单单/批量并发未观察到重复送货单。

这项修复不宣称解决整段确认事务、直接创建时的司机绑定或并发创建幂等。批量送货单写入本身若失败，仍不具备整单事务回滚保证。

当前三个正常入口的送货单行为在样本中从 2/3 具备变为 3/3 具备；实际波次绑定仍只有单单和批量两个入口具备。没有生产观察窗口与操作次数，因此不能给出线上遗漏率下降结论。

## 下一小步建议

优先解决确认操作的事务边界：先将单单确认的状态、派车归属与必要单据作为一个业务动作提交，再让批量逐单复用，并明确返回成功、失败、未处理列表。直接创建确认单随后接入同一业务动作。当前仍需要 Prisma transaction client 能贯穿 wave 与 pallet 的读写，不能继续依赖 catch 后逐字段恢复来宣称原子性。

并发创建幂等单独处理：将幂等键结果持久化并建立数据库唯一约束；现有进程内 Map 无法保证并发与多实例。该项属于后续独立变更。

## 复现与证据

启动专用本地 PostgreSQL 容器后执行（示例密码仅用于合成本地库）：

```sh
docker --host=unix:///var/run/docker.sock run -d --name veggie-confirm-audit-pg -e POSTGRES_PASSWORD=audit_local_only -e POSTGRES_DB=confirmation_audit -p 127.0.0.1:55439:5432 postgres:16
DATABASE_URL=postgresql://postgres:audit_local_only@127.0.0.1:55439/confirmation_audit DATABASE_DRIVER=pg npx prisma db push
DATABASE_URL=postgresql://postgres:audit_local_only@127.0.0.1:55439/confirmation_audit DATABASE_DRIVER=pg npx tsx scripts/audit/order-confirmation-baseline.ts
```

脚本严格检查 host、port、数据库名，清除邮件发送 key，临时故障 trigger 在 finally 清除。每轮创建独立合成记录，不删除历史测试数据。报告写入后退出；脚本断言验证已支持的行为，已知不满足的故障场景保留为观察结果，不伪称全部通过。

- 调整前快照：20261106-order-confirmation-results-before.json。
- 最后一次调整后快照：20261106-order-confirmation-results.json。
- 并发创建的三轮独立观察：20261106-order-confirmation-concurrency.json。
- 验证脚本：scripts/audit/order-confirmation-baseline.ts。

本轮业务代码修复与测试脚本仅保留在本地，未提交、未部署；本次 GitHub 提交范围为文档与合成验证快照。测试脚本路径为本地工作区路径，并非本次提交中的文件。
