# Odoo 数据库下载实施方案（~20G）

> 日期：2026-06-13
> 背景：原开发商将开放访问（可能给服务器 SSH / 数据库 / 接口）。目标是把原 Odoo 系统的**真实业务数据**取出，
> 为迁移进新系统（Next.js + Prisma + PostgreSQL）做准备。取出后走"分层导入 → 补期初一致性 → `npm run db:validate` 验收"。
>
> ⚠️ 核心判断：**20G 多半是 filestore（图片/附件/PDF）+ 邮件/日志表膨胀，真正要迁的业务数据通常 < 2G。**
> 所以第一步是「先量体积、再决定拿什么」，不要无脑拉 20G。

---

## 0. 先确认 6 件事（拿到访问后第一时间问清/查清）

| # | 要确认 | 为什么 / 怎么查 |
|---|---|---|
| 1 | **托管类型**：自建 VPS / Odoo.sh / Odoo Online(SaaS) | 决定整条路径（见 §1） |
| 2 | **访问方式**：SSH？直连 PostgreSQL？Odoo 管理后台(master password)？还是只有 API？ | 决定用哪种下载方法 |
| 3 | **Odoo 版本**（8/10/12/14/16/17…） | 影响表结构与字段名；`odoo --version` 或后台「设置→关于」 |
| 4 | **数据库名 / PG 连接信息**（host/port/user/dbname） | dump 必需；通常在 `odoo.conf` 的 `db_*` |
| 5 | **filestore 位置与大小** | Odoo 附件文件存在磁盘，不在 pg_dump 里（见 §3 gotcha） |
| 6 | **DB 体积 vs filestore 体积拆分** | 判断 20G 构成，决定是否全量（见 §2） |

> 这 6 项里**托管类型 + 访问方式**最关键，下文按它们分路。

---

## 1. 三种托管 → 三条路径

| 托管类型 | 能否 SSH/SQL | 推荐下载方式 |
|---|---|---|
| **自建 VPS**（最可能，因为"访问服务器"） | ✅ 完整 | **路径 A：`pg_dump` + filestore**（见 §4，首选） |
| **Odoo.sh** | ✅ 容器 SSH + 后台备份 | 直接在 Odoo.sh 后台「Backups」下载 dump（已含 filestore）；或路径 A |
| **Odoo Online（*.odoo.com SaaS）** | ❌ 无 SSH/SQL | 后台 `/web/database/manager` 导出 zip（有大小/超时限制，20G 大概率失败）→ 让原厂/Odoo 客服提供 dump，或**路径 C：API 选择性抽取** |

---

## 2. 第一步永远是「量体积」（别盲拉 20G）

拿到 DB 连接后先跑（psql 里）：

```sql
-- 整库大小
SELECT pg_size_pretty(pg_database_size(current_database()));

-- 占空间最大的 25 张表（找出膨胀源）
SELECT relname AS table,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 25;
```

服务器上查 filestore：
```bash
# data_dir 通常 ~/.local/share/Odoo 或 odoo.conf 的 data_dir
du -sh <data_dir>/filestore/<DBNAME>
```

**典型膨胀大户**（多半是它们撑起 20G，且**迁移不需要**）：
`ir_attachment`(若附件入库)、`mail_message` / `mail_tracking_value`、`ir_logging`、`bus_bus`、`base_import_*`、`ir_cron` 历史、各种 `*_log`。

**真正要迁的业务表**（通常 < 2G）：`res_partner`(客户/供应商)、`product_template`/`product_product`/`product_category`、`uom_uom`、`sale_order`/`sale_order_line`、`account_move`/`account_move_line`(发票/凭证)、`account_payment`、`stock_move`/`stock_quant`/`stock_picking`、`purchase_order`/`purchase_order_line`、`product_pricelist*`。

> 量完体积后做决定：**要么全量物理备份（省心、可离线反复查），要么只拉业务表（快）。** 两者都行，下面给全量首选方案。

---

## 3. 关键 gotcha：filestore 必须单独拿

Odoo 的附件（商品图、PDF、二维码等）默认**存磁盘**（`ir_attachment.store_fname` 指向 `<data_dir>/filestore/<DBNAME>/` 下的文件），**`pg_dump` 不含这些文件**。
- 若你需要图片/附件 → DB dump **和** filestore 都要拿。
- 若只迁数据、图片后补 → 可先跳过 filestore（这往往就是 20G 里最大的一块，跳过后传输量骤降）。
- 反之有些站点把附件存进 DB（`ir_attachment.db_datas`），那 dump 就很大、filestore 很小——§2 的体积拆分会告诉你是哪种。

---

## 4. 路径 A（首选）：SSH + pg_dump + filestore

> 适用自建 VPS / Odoo.sh。**全程在原厂/业主明确同意下、挑低峰时段做。**

### 4.1 在服务器上生成 dump（先落地到服务器磁盘，别直接跨网络流式导）

```bash
# 进 tmux/screen，避免断线中断（20G 可能跑 30 分钟+）
tmux new -s odoodump

# 确认服务器有足够剩余磁盘放 dump 文件
df -h

# 自定义格式（已压缩、支持并行恢复、可选择性恢复）
pg_dump -Fc -h 127.0.0.1 -U <DBUSER> -d <DBNAME> \
  -f /tmp/odoo_<DBNAME>_$(date +%Y%m%d).dump

# 体量大可用目录格式 + 并行，快很多：
# pg_dump -Fd -j 4 -h 127.0.0.1 -U <DBUSER> -d <DBNAME> -f /tmp/odoo_dump_dir
```
- `pg_dump` 走 MVCC 快照，**不锁表**，但有 I/O 负载 → 低峰做。
- 只要业务表可加 `-t` 过滤：`-t res_partner -t product_template -t sale_order ...`（配合 §2 决定）。

### 4.2 打包 filestore（如需图片/附件）

```bash
tar -czf /tmp/filestore_<DBNAME>_$(date +%Y%m%d).tgz \
  -C <data_dir>/filestore <DBNAME>
```

### 4.3 校验和（两端比对，防传输损坏）

```bash
sha256sum /tmp/odoo_<DBNAME>_*.dump /tmp/filestore_*.tgz > /tmp/odoo_dump.sha256
cat /tmp/odoo_dump.sha256
```

### 4.4 传回本机（可断点续传）

```bash
# 本机执行；--partial 断点续传，-P 进度
rsync -avzP --partial \
  <user>@<server>:/tmp/'odoo_<DBNAME>_*.dump' ./odoo-backup/
rsync -avzP --partial \
  <user>@<server>:/tmp/'filestore_<DBNAME>_*.tgz' ./odoo-backup/
rsync -avzP <user>@<server>:/tmp/odoo_dump.sha256 ./odoo-backup/

# 本机校验
cd odoo-backup && shasum -a 256 -c odoo_dump.sha256   # macOS
```

### 4.5 本机恢复成一个可查的 Postgres（用于抽取/转换，别在原服务器上动）

```bash
createdb odoo_restore
# 自定义格式：
pg_restore -d odoo_restore -j 4 ./odoo-backup/odoo_<DBNAME>_*.dump
# 目录格式同理指向目录
```
之后用 psql / DBeaver 直接查，或起一个**只读**的本地 Odoo 指向它来核对。

### 4.6 收尾（重要）

```bash
# 删掉服务器上的临时 dump（别把客户数据留在 /tmp）
ssh <user>@<server> 'rm -f /tmp/odoo_<DBNAME>_*.dump /tmp/filestore_*.tgz /tmp/odoo_dump.sha256'
```

---

## 5. 路径 C（备选）：API / XML-RPC 选择性抽取

> 适用「只开放接口」或 Odoo Online。**不拉 20G，只拉你要迁的业务模型**——这恰恰是你真正需要的。

Odoo 外部 API（XML-RPC，端点 `/xmlrpc/2/common` 认证 + `/xmlrpc/2/object` 读取）：
```python
import xmlrpc.client
url, db, user, pwd = 'https://<host>', '<db>', '<user>', '<api_key_or_pwd>'
common = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/common')
uid = common.authenticate(db, user, pwd, {})
models = xmlrpc.client.ServerProxy(f'{url}/xmlrpc/2/object')

# 分页 search_read，导出为 JSON/CSV
def dump(model, fields, batch=500):
    out, off = [], 0
    while True:
        rows = models.execute_kw(db, uid, pwd, model, 'search_read',
            [[]], {'fields': fields, 'limit': batch, 'offset': off, 'order': 'id'})
        if not rows: break
        out += rows; off += batch
    return out

# 要迁的核心模型（按需补全字段）
# res.partner / product.template / product.product / product.category / uom.uom
# sale.order / sale.order.line / account.move / account.move.line / account.payment
# stock.move / stock.quant / purchase.order / purchase.order.line / product.pricelist*
```
- 优点：选择性、可重复、可**增量**（按 `write_date > 上次` 过滤拉变更）。
- 缺点：全量慢；图片要单独取（`/web/image/...` 或 ir.attachment）。
- 适合：迁移阶段「主数据 + 近期交易」的精准抽取，而非整库归档。

---

## 6. 20G 传输实务速查

- **先压缩再传**：`pg_dump -Fc` 已压缩；filestore 用 `tar -czf`。
- **断点续传**：`rsync --partial -P`（网络抖动不用重来）。
- **磁盘空间**：服务器要够放 dump；本机要够放 dump + 恢复后的库（恢复后约 dump 的 2-3 倍）。
- **耗时估**：传输时间 ≈ 压缩后大小 ÷ 实际带宽。先看 §2 拆分，跳过 filestore 往往把 20G 砍到 1-3G。
- **长任务**：服务器侧 dump 放 `tmux`/`screen`/`nohup`，防 SSH 断线中断。
- **低峰执行**：生产库白天别跑；能要到**只读副本**或离线备份最好。

---

## 7. 安全与合规（⛔ 这是 EU 真实客户数据，必须当回事）

- **PII / GDPR**：客户姓名、电话、地址、VAT、订单都是受 GDPR 保护的个人数据。下载/存储/处理必须有合法依据 + 业主授权，用完即删。
- **加密传输**：只走 SSH/rsync-over-SSH，**绝不**把 Postgres 端口暴露公网；远程 psql 用 SSH 隧道（`ssh -L 5433:127.0.0.1:5432 ...`）。
- **加密静置**：dump 落本地后放加密卷/加密磁盘；长期留存先 `gpg` 加密。
- **绝不进 git**：dump/filestore/含连接串的脚本一律加 `.gitignore`，不提交不上云。
- **最小权限 + 授权留痕**：用只读 DB 账号；下载前拿到原厂/业主书面同意，记录时间与范围。
- **用后清理**：删服务器临时文件、删本地中间产物、撤销临时凭据。

---

## 8. 拿到数据之后（接上迁移）

1. **恢复/落地** → 本地 `odoo_restore` 库或 JSON/CSV。
2. **分层抽取**（与种子同序）：先主数据（partner→category→uom→product→pricelist），再交易（order→stock→invoice→payment）。
3. **映射到新 schema**：Odoo 模型 → Prisma 表（`res_partner`→`Customer`，`product_product`→`Product`，`sale_order(_line)`→`Order(Line)`，`account_move`→`Invoice`，`stock_move`→`StockMove` …）。注意单位换算、税率、特价、`externalId` 保留 Odoo id 便于对账。
4. **补期初一致性**：导入快照后，为每个商品造一条期初 `StockMove(ADJUSTMENT)` 使 `qtyOnHand == ΣStockMove`；未结发票 `amountPaid == Σpayments`；客户期初余额造 `Statement`。
5. **验收**：`npm run db:validate` —— 9 项不变量全绿才算"数据可驱动流程/报表"。不绿就按报告逐条修，**再上线**。

> 参考：全局 skill `validating-data-integrity`（迁移验收/巡检）、`testing-end-to-end-experience`（导入后驱动真实接口跑一遍）。

---

## 9. 决策树（一图速查）

```
拿到访问
  ├─ 自建 VPS / Odoo.sh，有 SSH/SQL ──► 路径 A：pg_dump(-Fc) + filestore(tar) + rsync + 本地 pg_restore   ★首选
  ├─ Odoo.sh ────────────────────────► 后台 Backups 直接下载（已含 filestore）
  ├─ Odoo Online(SaaS)，只有后台 ─────► /web/database/manager 导 zip（20G 多半超时）→ 找原厂要 dump
  └─ 只开放 API ─────────────────────► 路径 C：XML-RPC 选择性抽取业务模型（不拉 20G）

下载前先做：§2 量体积 + §0 确认 6 件事；
下载中：§6 传输实务 + §7 安全合规；
下载后：§8 分层导入 → db:validate 验收。
```

---

## 10. 可直接执行的脚本工具包

本计划已落成一套可直接执行的脚本，位于 [`scripts/odoo-migration/`](../scripts/odoo-migration/)，到时填好 `config.env` 就能一条条跑，无需再手敲命令。用法见该目录的 [`README.md`](../scripts/odoo-migration/README.md)。

| 文件 | 在哪跑 | 对应本文 |
|------|--------|---------|
| `config.env.example` | — | §0 连接信息，复制为 `config.env` 填写 |
| `00-assess.sh` | 服务器 | §2 量体积 |
| `01-dump-server.sh` | 服务器 | §3 路径 A：pg_dump(-Fc) + filestore + 校验和 |
| `02-transfer-local.sh` | 本机 | §6 rsync 断点续传 + 校验 |
| `03-restore-local.sh` | 本机 | §8 本地 pg_restore 成只读分析库 |
| `04-cleanup-server.sh` | 服务器 | §7 用后清理服务器副本 |
| `extract_via_api.py` | 本机 | §3 路径 C：XML-RPC 选择性抽取 |

路 A（有 SSH/SQL）：`00 → 01 → 02 → 03 →（04）`；路 C（只有 API）：`extract_via_api.py`。
`config.env`、`*.dump`、`*.tgz`、`odoo-api-export/` 均已被脚本目录的 `.gitignore` 拦截，不会误提交客户 PII。
