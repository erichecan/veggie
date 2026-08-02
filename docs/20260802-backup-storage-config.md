# 备份落点配置指南（BACKUP_DRIVER）

> 2026-08-02。背景：审计发现备份 3 次任务成功 0 次，最近一次只报
> `The specified bucket does not exist`，看不出该配什么；且落点直连 GCS，
> 与「功能做完整体迁到客户自有 DigitalOcean 服务器」的目标架构冲突。
> 现改为 driver 抽象，迁移时只改配置不改代码。

## 三个 driver 怎么选

| driver | 什么时候用 | 迁到自有服务器后 |
|---|---|---|
| `local` | **默认**。落本地磁盘，配合 systemd timer + rclone 推异地 | ✅ 开箱可用 |
| `s3` | **推荐的目标形态**。任何 S3 兼容存储：DigitalOcean Spaces / MinIO / B2 / AWS S3 | ✅ 照常可用 |
| `gcs` | 遗留兼容，仅为不打断当前 Cloud Run 部署 | ❌ 不可用，别在新环境选 |

不配 `BACKUP_DRIVER` 就是 `local`。写成 `spaces`、`minio` 这类拼错的值会**直接抛错**，
不会静默回退——否则备份会一直"成功"地落在容器本地磁盘上，重启即失而无人知晓。

## 各 driver 需要的环境变量

### local
```bash
BACKUP_DRIVER=local
BACKUP_LOCAL_DIR=/var/backups/veggie   # 可选，默认 ./backups
```
合同要求「至少一份备份保存在不同于主服务器的位置」，local 单用不满足，
需再配一条推送（例：`rclone sync /var/backups/veggie spaces:veggie-backups`）。

### s3 —— DigitalOcean Spaces
```bash
BACKUP_DRIVER=s3
S3_BUCKET=veggie-backups
S3_ENDPOINT=https://fra1.digitaloceanspaces.com   # 换成你的区域
S3_REGION=fra1
S3_ACCESS_KEY_ID=<Spaces access key>
S3_SECRET_ACCESS_KEY=<Spaces secret>
```

### s3 —— MinIO（自建，跑在同一台服务器上也行）
```bash
BACKUP_DRIVER=s3
S3_BUCKET=veggie-backups
S3_ENDPOINT=https://minio.internal:9000
S3_FORCE_PATH_STYLE=1      # MinIO 需要 path-style
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

### gcs（遗留）
```bash
BACKUP_DRIVER=gcs
GCS_BACKUP_BUCKET_NAME=veggie-db-backups
```

## ⛔ 桶要自己建

代码不会替你开通任何云资源。这是刻意的——按项目部署铁律，不给一个明确要拆掉的架构加钉子。
桶建好之前备份会失败，但失败信息会明说缺哪几个环境变量，落进 `BackupJob.errorMessage`，
在 BOSS「数据库备份」页直接能看到。

## 下载行为的差异

- `s3` / `gcs`：接口返回 `{ url }` 签名链接（10 分钟有效），前端跳转，不占应用带宽
- `local`：没有 URL 可签，`/api/backups/[id]/download` 直接把 gzip 流转发出去

两种前端都兼容，不用改调用方。

## 已验证

2026-08-02 用 `local` driver 跑通完整链路：
`pg_dump → gzip → 落盘 → 下载流`，产出 **81.7 MB**，解压后是合法 SQL（48 个 `CREATE TABLE`）。
这是该系统第一次成功产出备份。

⚠️ 本机 `pg_dump` 需与服务端大版本一致。本机 Homebrew 默认是 14，而 Neon 是 17，
要显式指定：`PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"`。
生产 Docker 镜像已装 pg17（提交 `9415112`）。

## 恢复

```bash
gzip -dc backup-<id>.sql.gz | psql "<目标库连接串>"
```
备份用 `pg_dump --clean --if-exists`，可直接覆盖恢复到空库或已有库。
合同要求「备份可正常恢复」——恢复演练目前仍靠人工执行本命令，尚无自动验证。
