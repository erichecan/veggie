# 生产备份权限修复与验证

执行日期：2026-10-06 UTC（Toronto 为 2026-10-05）。

## 根因与修复

应用备份使用数据库角色 `veggie`。三张由 `postgres` 持有的历史去重表缺少 `SELECT` 权限，导致 `pg_dump` 全库导出失败：

- `product_dedup_backup_20260905`
- `product_dedup_dropped_supplier_info_20260905`
- `product_dedup_dropped_sale_uom_20260905`

已在生产运行 `deploy/droplet/fix-backup-read-permissions.sql`，仅补充这三张表的只读权限；事务内检查 public 表及序列没有剩余读取权限缺口。不授予超级用户、写入权限或全局默认权限，不修改业务表内容。

## 完整备份与恢复验证

- 调用生产自动备份路由，HTTP 200，任务 `cmuvyfhin000901pnmvpsvonz` 成功。
- 备份对象：`backups/2026-10-06T00-42-41-140Z-cmuvyfhin000901pnmvpsvonz.sql.gz`。
- 大小：9,217,590 bytes，存于生产持久化备份目录。
- `gzip -t` 完整性校验通过。
- 将整个 SQL 备份恢复到独立临时数据库，`psql ON_ERROR_STOP=1` 全程成功；恢复 65 张 public 表，与生产表数量一致。
- 验证恢复后的 Customer 459 行、Order 3 行、历史产品去重表 132 行及另外两张去重表存在。
- 临时验证数据库已删除，未覆盖生产数据库。

## 失败记录清理

按用户明确要求，在确认备份成功并完成恢复验证后，事务删除 `BackupJob.status='failed'` 的全部 33 条记录。删除前的失败记录已包含在本次完整备份内。

剩余 3 条成功的自动备份记录，无失败或进行中的记录。自动备份路由另按已有 30 天保留策略清理了 2 条过期成功备份。生产健康检查 `status=ok`、`db=ok`。

生产数据库权限修复和记录清理已即时生效，无需重新部署应用；本地 SQL 和操作文档尚未提交。
