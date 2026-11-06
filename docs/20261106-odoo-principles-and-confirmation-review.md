# 学习 Odoo 设计原则：订单确认一致性与回滚检查

日期：2026-11-06。用途：记录学习结论、隔离验证结果和晚间生产库检查步骤，作为后续渐进调整的依据。

## 1. 学习哪些原则

本次参考 Odoo 开源仓库 18.0 分支，而非把 Odoo 描述为没有缺陷的系统。以下源码链接指向可更新分支，并非固定提交快照。

| 原则 | Odoo 源码中的例子 | 本项目的应用方向 |
| --- | --- | --- |
| 同一个业务动作统一入口 | sale.order.action_confirm 支持记录集合，检查确认条件后统一触发扩展入口 | 单单、批量、直接创建确认单应复用同一确认业务动作 |
| 联动使用固定扩展点 | sale_stock 扩展 _action_confirm，触发订单行的库存规则 | 派车、库存需求、必要送货单应明确挂接到确认流程 |
| 数据事务覆盖业务动作 | 常规请求通过事务包装执行，service.model.retrying 在成功后提交，对特定并发错误重试 | 必须一起成功的数据应在同一事务内写入，不能将手动恢复几个字段视作完整回滚 |
| 从业务事实派生展示 | 已交付数量由完成的库存移动计算，并换算单位、扣除退货 | 配送进度、司机归属与统计应明确事实来源，避免多个副本分别更新 |
| 并发约束落到数据库 | ORM、数据库约束与特定错误重试共同工作 | 一个司机一个运行行程、订单归属与创建幂等，需要对应锁或唯一约束 |

Odoo 的 HTTP 分发、认证、ORM、事务等基础设施提供支持；业务联动规则主要由模型层统一方法及模块扩展实现。增加通用中间件本身不能解决遗漏派车。

源码参考：

- [销售确认及扩展入口](https://github.com/odoo/odoo/blob/18.0/addons/sale/models/sale_order.py)
- [销售与库存联动](https://github.com/odoo/odoo/blob/18.0/addons/sale_stock/models/sale_order.py)
- [库存规则、单位换算与已交付数量](https://github.com/odoo/odoo/blob/18.0/addons/sale_stock/models/sale_order_line.py)
- [请求事务包装](https://github.com/odoo/odoo/blob/18.0/odoo/http.py)
- [数据库提交及特定并发异常重试](https://github.com/odoo/odoo/blob/18.0/odoo/service/model.py)

## 2. 为什么近期需要反复修正

一部分是需求调整，例如允许月结实收为 0；另一部分是结构性遗漏，例如不同确认入口分别更新订单状态、派车归属及送货单。

报价阶段 Order.driverSlotId 表示司机意向；实际配送归属以 PickingWave.orderIds 及托盘为依据。此前确认只更新状态，未将意向落实到波次，造成订单显示有司机而配送中心显示待分配。已部署提交 3a5a6032 补上单单与批量确认的同步，但这不等于三个入口已统一，也不等于整段确认具有原子性。

## 3. 隔离验证已证实什么

使用专用本地 PostgreSQL 16、合成数据和真实 API handler；没有连接生产库。覆盖正常、失败、重复、并发。未覆盖浏览器、HTTP 中间件、生产历史数据和多实例。

| 观察 | 验证结果 |
| --- | --- |
| 单单确认遇到锁定波次 | 返回 409，恢复 PENDING；该分支恢复有效 |
| 创建订单时订单行写入失败 | 返回 500，订单总数不增加；该事务内写入回滚有效 |
| 派车成功后审计写入失败 | 返回 500，但订单已派车、波次和托盘仍存在；未整体回滚 |
| 单单送货单写入失败 | 返回 200，但无送货单；联动失败被记录日志后继续 |
| 批量中间一单失败 | 存在已派车、回退报价、尚未处理但已确认的订单；没有逐单反馈 |
| 直接创建已确认单且预选司机 | 司机意向保留，但未落实到实际波次 |
| 顺序重复单单确认 | 核心关联未重复，但产生两条确认审计 |
| 单单/批量并发确认 | 样本中核心关联未重复，确认审计重复；不能外推所有并发场景 |
| 创建时并发使用同一幂等键 | 多轮曾出现两个不同订单，也曾一成功一报错；并发幂等不可靠 |

商品单位样本：1 CASE = 10 KG，销售 2 CASE，待出库需求为 20 KG；确认阶段在手库存保持不变。

详细报告：[订单确认隔离验证结果](20261106-order-confirmation-verification.md)。初始评估：[检查基线](20261106-order-confirmation-baseline.md)。调整前后 JSON 快照及并发观察也保存在本目录。

## 4. 当前部署与本地改动的区别

- 已部署：3a5a6032，销售统计调整、报价确认同步预安排司机。
- 隔离测试后的小范围修复：批量确认使用 upsert 补建送货单，已在本地复测；**尚未提交或部署到生产**。
- 本次 GitHub 提交只提交文档和合成验证快照，不包含该业务代码修复。故晚上生产库中仍可能存在批量确认无送货单的记录。
- 测试脚本 scripts/audit/order-confirmation-baseline.ts 当前仅在本地工作区；含故障注入，只用于上述专用隔离库，不用于生产复查。

## 5. 晚间连接生产库后的检查

先记录生产运行的提交或镜像 SHA、数据库名称、检查时间及选择的订单时间范围。以实际部署版本和库中数据为准，不能把本地测试结果当作线上问题发生次数。

使用只读会话或只读事务，设置超时；以下查询只是读取，退出时 ROLLBACK。选择较小的业务窗口（例如当天和最近一次已部署修复之后），避免第一次就全库扫描。不要在生产执行 db push、故障 trigger、pg_sleep 并发试验或测试种子脚本。

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT current_database(), current_user, now();

-- 线索 A：有司机意向的确认单，未进入任何实际波次。
-- 将时间范围替换成此次要检查的窗口，默认示例仅最近两天。
SELECT o.id, o.code, o.status, o."driverSlotId", o."deliveryDate", o."confirmationDate"
FROM "Order" o
WHERE o.status IN ('CONFIRMED', 'WAVE_ASSIGNED')
  AND o."confirmationDate" >= now() - interval '2 days'
  AND o."driverSlotId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "PickingWave" w WHERE o.id = ANY(w."orderIds")
  )
ORDER BY o."confirmationDate" DESC LIMIT 100;

-- 线索 B：近期确认单没有送货单。
SELECT o.id, o.code, o.status, o."confirmationDate"
FROM "Order" o
WHERE o.status IN ('CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED')
  AND o."confirmationDate" >= now() - interval '2 days'
  AND NOT EXISTS (SELECT 1 FROM "DeliverySlip" d WHERE d."orderId" = o.id)
ORDER BY o."confirmationDate" DESC LIMIT 100;

-- 线索 C：近期确认单属于多个波次。
SELECT o.id, o.code, count(*) AS wave_count, array_agg(w.id) AS wave_ids
FROM "Order" o JOIN "PickingWave" w ON o.id = ANY(w."orderIds")
WHERE o."confirmationDate" >= now() - interval '2 days'
GROUP BY o.id, o.code HAVING count(*) > 1 LIMIT 100;

ROLLBACK;
```

以上结果是候选线索，不直接等同于可自动修复的脏数据：司机意向可能已被调度取消、订单可能来自历史导入；需逐单结合审计和波次记录解释。查询若命中超时，应缩小窗口，不取消超时后盲目重跑全库。

对每个候选订单，按以下顺序记录：

1. 确认入口与时间：单单、批量还是直接创建；依据审计日志、请求日志和操作记录，不根据状态猜测入口。
2. 对照订单状态和司机意向、实际 wave.orderIds、托盘 items、送货单。
3. 查看确认时是否有 409/500，以及其后的订单与派车数据是否保留。仅有数据库当前快照，无法证明当时发生过回滚失败。
4. 对重复创建候选，结合请求幂等键、时间、客户、行明细和操作人核对；同客户同金额不自动判定重复。
5. 记录受影响数量与检查总量、业务窗口、证据、待解释原因。生产数据修复应另做具体清单，避免直接批量补绑司机或删除订单。

## 6. 渐进调整方案与衡量标准

按“梳理 → 隔离验证 → 单点调整 → 生产只读复查 → 再评估”推进。先聚焦订单确认，不同时重做销售、库存和配送的数据结构。

- 遗漏是否减少：固定场景修复前后对照，并统计明确窗口内同根因再次发生的次数；区分已验证与未验证。
- 失败能否回滚：在隔离库逐写入点注入故障，核对整张业务图；部分字段恢复不算整体回滚通过。
- 入口是否一致：相同输入对照状态、实际司机归属、送货单及单位数量；批量要明确成功/失败/未处理结果。

下一轮优先明确必要联动及批量契约，再逐步让确认动作使用同一事务和同一业务入口；创建幂等持久化作为独立变更。不因本轮发现问题而立即开展全系统重构。

晚间检查结果待补充：生产版本、检查窗口、候选数量、逐单解释、确认问题和下一次小范围修复清单。
