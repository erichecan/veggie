# Odoo 数据库下载工具包

把原开发商 Odoo（约 20G）安全下载到本机的一套可直接执行脚本。
完整背景与决策树见 [`docs/20260613-odoo-db-download-plan.md`](../../docs/20260613-odoo-db-download-plan.md)。

> ⚠️ Odoo 里的客户/订单是 **GDPR 受保护的真实 PII**。开跑前必须先拿到业主书面授权。
> 全程只走 SSH 加密通道，绝不对公网暴露 Postgres 端口；导出文件不进 git（已配 `.gitignore`）；用完即删。

---

## 第 0 步：填配置（所有脚本共用）

```bash
cd scripts/odoo-migration
cp config.env.example config.env
# 编辑 config.env，填 SSH / Postgres / DATA_DIR / API 等真实值
```

`config.env` 已被 `.gitignore` 忽略，不会提交。密码优先用 `~/.pgpass` 或交互输入，别写进文件。

---

## 选哪条路？

| 你能拿到什么 | 走哪条路 | 用到的脚本 |
|--------------|----------|-----------|
| SSH + 数据库（自建 VPS / Odoo.sh） | **路 A：pg_dump（推荐，最完整）** | `00 → 01 → 02 → 03 →（04）` |
| 只有 Odoo 后台 + API 密钥（Odoo Online SaaS） | **路 C：XML-RPC 抽取** | `extract_via_api.py` |

不确定属于哪种？先在服务器跑 `00-assess.sh` 看体积构成，再决定。

---

## 路 A：pg_dump 完整迁移

脚本分「服务器上跑」和「本机跑」两类。先把服务器侧脚本和配置 scp 上去：

```bash
# 本机：把配置和服务器侧脚本传到服务器
scp config.env 00-assess.sh 01-dump-server.sh 04-cleanup-server.sh \
    "$SSH_USER@$SSH_HOST:/tmp/odoo-export/"   # REMOTE_WORKDIR
```

然后按顺序：

```bash
# ① 服务器上：评估体积，判断全量/lean/要不要 filestore
ssh "$SSH_USER@$SSH_HOST"
cd /tmp/odoo-export && bash 00-assess.sh
#   → 据输出回填 config.env 的 DUMP_SCOPE / INCLUDE_FILESTORE

# ② 服务器上：导出（建议在 tmux 里，防断线）
tmux new -s dump
bash 01-dump-server.sh          # pg_dump -Fc + filestore.tgz + sha256

# ③ 本机：拉回来并校验（断点续传，断了重跑即可）
bash 02-transfer-local.sh

# ④ 本机：恢复成本地只读分析库
bash 03-restore-local.sh        # → 本地库 $RESTORE_DB

# ⑤ 服务器上：删掉临时导出（确认本机已校验通过后）
bash 04-cleanup-server.sh
```

跑完后，本地有一个 `$RESTORE_DB` 库，可以 `psql -d $RESTORE_DB` 直接查 Odoo 原始数据，
后续再写「Odoo → 本项目 Prisma schema」的字段映射脚本（按模块逐表迁移）。

---

## 路 C：只有 API

```bash
set -a; source ./config.env; set +a
python3 extract_via_api.py                      # 全量核心模型 → ./odoo-api-export/*.json
# 或增量 / 指定模型：
python3 extract_via_api.py --since 2025-01-01
python3 extract_via_api.py --models res.partner,sale.order,account.move
```

只依赖 Python 标准库，无需 pip。输出每个模型一个 JSON，含 `_summary.json` 汇总。

---

## 脚本清单

| 文件 | 在哪跑 | 作用 |
|------|--------|------|
| `config.env.example` | — | 配置模板，复制为 `config.env` 填写 |
| `00-assess.sh` | 服务器 | 库大小 + 最大表 + filestore 体积评估 |
| `01-dump-server.sh` | 服务器 | pg_dump（custom 压缩）+ filestore 打包 + 校验和 |
| `02-transfer-local.sh` | 本机 | rsync 断点续传拉取 + 校验完整性 |
| `03-restore-local.sh` | 本机 | 恢复成本地只读分析库 + 解包 filestore |
| `04-cleanup-server.sh` | 服务器 | 删除服务器上的临时导出副本 |
| `extract_via_api.py` | 本机 | 路 C：XML-RPC 分页导出核心模型为 JSON |

---

## 安全红线（不可妥协）

- ⛔ 不提交 `config.env`、`*.dump`、`*.tgz`、`odoo-api-export/`（`.gitignore` 已拦）
- ⛔ 不在公网开放 Postgres 端口；跨机只走 SSH
- ⛔ 未获业主授权不导出客户数据
- ✅ 数据落本机后加密保存；分析完成、迁移定稿后删除原始 dump 与 API 导出
- ✅ 生产库 `pg_dump` 选低峰时段执行（custom 格式对线上影响小，但仍属重 IO）
