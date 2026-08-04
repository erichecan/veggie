# T1.4 本地验证记录：标准 PostgreSQL + unix socket + 本地磁盘存储

> 阶段 1 的出口硬关卡。目的是把驱动切换的问题在自己机器上暴露完，**不拿客户服务器试错**。
> 台账：`docs/20260802-private-deployment-tasks.md` · 设计：`docs/20260802-private-deployment-migration-design.md`
>
> 环境：colima（4 vCPU / 6 GB）+ `docker-compose.local-pg.yml`，
> `postgres:17-alpine`（`listen_addresses=''`，只走 unix socket）+ 本项目生产 Dockerfile 产物。

---

## 1. 结论

**驱动切换、存储驱动、备份与恢复、服务端 PDF 渲染全部通过。**
`STORAGE_DRIVER=local` + `DATABASE_DRIVER=pg` + unix socket 的组合可以上服务器。

途中暴露 **5 个问题，全部是既有的，没有一个是本次迁移改造引入的**。其中 2 个当场修掉
（会挡住迁移），3 个记录待办（与迁移无关，但必须让用户知道）。

---

## 2. 验证结果逐条

| # | 验证项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 容器内经挂载 socket 连宿主 PG | ✅ | `/api/health` → `{"db":"ok"}` |
| 2 | `db push` 建 schema | ✅ | 47 张表 |
| 3 | 种子数据 | ⚠️ 部分 | 用户 8 / 客户 1332 / 订单 5 / 行程 4 / 价格表 91；**商品 0**（见 §3 问题 4） |
| 4 | 真实登录（bcrypt + 库读） | ✅ | `operator@veggie.com` 拿到 token |
| 5 | 错误密码 | ✅ 401 `{"error":"邮箱或密码错误"}` | 不崩溃 |
| 6 | 未登录访问受保护 API | ✅ 401 | |
| 7 | 不存在的资源 | ✅ 404 | |
| 8 | 订单 / 客户 / 行程列表 | ✅ | 数据正确，`status:"COMPLETED"`（§3 问题 3 修复后的值） |
| 9 | 图片上传（local driver） | ✅ | `{"url":"/uploads/products/…png"}`，容器内落盘 19035 字节 |
| 10 | **备份**（`BACKUP_DRIVER=local`） | ✅ | `/data/backups/…sql.gz` 56828 字节 |
| 11 | **恢复演练** | ✅ | 恢复到 `restore_drill` 库：**47 张表、5 项行数与源库逐一相等** |
| 12 | **服务端 Chromium 渲染 PDF** | ✅ | 98964 字节有效 PDF，**中文与 € 完整渲染无豆腐块**（人工看图确认，非只看 200） |
| 13 | 容器日志 error 级 | ✅ 无 | 仅剩已知的 pdf-extract（§3 问题 5） |
| 14 | 采购单 PDF 识别 | ❌ | §3 问题 5 —— **生产镜像里同样坏** |

---

## 3. 暴露的问题

### 问题 1（已修）上传/备份目录属主 —— 会直接打死生产的上传功能

**现象**：`POST /api/upload-image` 500，日志 `EACCES: permission denied, mkdir '/data/uploads/products'`。

**根因**：容器以 `nextjs`(uid 1001) 运行，而 `/data/uploads` 是 `root:root 0755`。

**修法**：Dockerfile 里预建目录并 `chown -R nextjs:nodejs /data`。docker 具名卷会继承镜像里
该目录的属主，所以这一处同时解决了 compose 的情况。

> ⛔ **服务器上必须另外处理**：宿主机 bind mount **不继承**镜像属主。
> 阶段 2 的 T2.4 建 `/data/veggie/{uploads,backups}` 时必须 `chown 1001:1001`，
> 否则生产上传就是静默 500。**这条要写进部署手册。**

### 问题 2（已修）种子数据里有枚举里不存在的订单状态

`prisma/seed.ts` 用 `status: 'DELIVERED'`，而 `OrderStatus` 枚举里是 `COMPLETED`。

**为什么一直没被发现**：写的是 `o.status as any` —— `as any` 把类型系统关掉了。
typecheck 全绿、直到真去空库灌种子才在运行时炸。

**修法**：值改成 `COMPLETED`，并给 `DEMO_ORDERS` 显式标注 `status: OrderStatus`、去掉两处 `as any`。
已验证收紧有效：把值改回 `DELIVERED` → `error TS2322: Type '"DELIVERED"' is not assignable to type 'OrderStatus'`。

### 问题 3（未修，重要）迁移历史无法从空库重建 schema

`prisma migrate deploy` 在空库上**第一条就失败**：`20260419_decimal_partner_indexes`
直接 `ALTER TABLE "ProductTemplate"`，假定表已存在。**整个迁移历史里没有任何建表迁移。**

历史上 schema 一直是 `db push` 建的、迁移用 `migrate resolve` 补记（见记忆
`prisma-migration-shadow-db`），从来没人从零重放过。

**对迁移计划的影响**：

| 场景 | 受影响？ |
|---|---|
| 阶段 4/5 `pg_dump` + `pg_restore` 整库 | ❌ 不受影响——schema 与 `_prisma_migrations` 都随 dump 过来 |
| 阶段 3 流水线的增量 `migrate deploy` | ❌ 不受影响——库已由 restore 建好 |
| **灾难恢复** | ⚠️ **完全依赖 dump。迁移历史帮不上忙**，必须在备份手册里写明 |

本次本地验证改用 `db push` 绕过。

### 问题 4（未修）商品种子已失效 —— `npm run db:seed` 灌不出商品

`pic/product.product.csv` 在 2026-07-15 被换成 **Odoo 技术字段名导出**
（表头 `id,name,lst_price,categ_id/id,…`），而 `prisma/csv-loader.ts` 的 `loadCsvProducts`
仍按人类可读表头读（`External ID`/`Name`/`Sale Price`/`Product Category`）。
每行第一个字段就取不到 → `continue` → 0 条。

`loadCsvCustomers` 用的是另一套解析，不受影响（1325 条正常）。

**后果**：种子库没有商品，跑不了「下单 → 扣库存 → 拣货 → 签收」的完整业务闭环。
本次因此只验到栈层面，业务闭环未走通。

**注意**：技术字段名导出里**没有 `Quantity On Hand` 列**，所以即使修好映射，
商品也会是 0 库存，闭环仍需另外造库存。修这个要连"演示库存怎么来"一起想清楚。

### 问题 5（未修，影响生产）采购单 PDF 识别在生产镜像里就是坏的

```
Cannot find module '/app/.next/server/chunks/pdf.worker.mjs'
  imported from /app/.next/server/chunks/node_modules_pdf-parse_dist_pdf-parse_esm_index_*.js
```

dev 模式与**生产镜像**都复现。pdfjs 的 worker chunk 没被打进 standalone 产物。
文件本身已正常落盘（存储层是好的），失败发生在下游 `extractPdfText`。

**这意味着当前 Cloud Run 生产环境上该功能大概率同样不可用**，与迁移无关。

**建议修法**（未执行，等决策）：把 `pdf-parse` 加进 `next.config.ts` 的
`serverExternalPackages`，与已有的 `puppeteer-core` 同样处理——不打包、交给运行时 require。
`outputFileTracingIncludes` 已经为该路由包了 `@napi-rs/**`，但那解决的是另一个问题
（DOMMatrix polyfill），管不到 worker chunk。

---

## 4. 预判错了的地方

设计文档 §2.2 把「unix socket 的容器内权限」列为最高风险项，预判 T1.4 会先失败在这里。
**实际没有发生**：`postgres:17-alpine` 创建的 socket 是 `srwxrwxrwx`（0777），
目录 `drwxrwsr-t`，任何 uid 都能连。

真正咬人的是**同一类问题的另一处**——上传目录的属主（问题 1）。
风险的方向判断对了，具体落点猜错了。

> Debian/Ubuntu 的 apt 版 PostgreSQL 默认 `unix_socket_permissions=0777`，
> 与 alpine 镜像一致，所以服务器上大概率也不会卡在 socket。但 `/data/veggie/*`
> 的属主是**必然**要处理的。

---

## 5. 顺带产出：迁移/运维容器的形状

生产运行时镜像是 Next standalone 产物，**不含 prisma CLI**（`node_modules/.bin` 里没有），
设计文档 §4.1 写的 `docker compose run --rm app npx prisma migrate deploy` 会去 npm 现拉 CLI，
依赖外网且脆弱。

改用从 `builder` 阶段构建的 `migrator` 服务（那一层有 `npm ci` 装全的 node_modules），
`profiles: ["tools"]` 让它不参与 `up -d`。**阶段 3 的服务器编排照抄这个形状即可。**

---

## 6. 环境搭建中的坑（复现时会撞到）

| 坑 | 现象 | 解 |
|---|---|---|
| 本机无容器运行时 | `/usr/local/bin/docker` 是指向已删除 Docker.app 的**悬空软链** | `brew install colima docker docker-compose` |
| `HOMEBREW_CACHE=/homebrew-cache` 只读 | brew install 失败 | 命令级覆盖 `HOMEBREW_CACHE=$HOME/Library/Caches/Homebrew` |
| `~/.docker/config.json` 残留 `credsStore: desktop` | `docker-credential-desktop not found`，拉镜像失败 | 删掉该键（`credHelpers` 的 gcloud 条目要保留） |
| colima 默认只挂 `$HOME` | 项目在 `/Volumes/...`，bind mount 静默为空目录 | `colima start --mount /Volumes/…/veggie:w` |
| compose 插件未注册 | `docker compose` 找不到 | `~/.docker/config.json` 加 `cliPluginsExtraDirs` |

---

## 附：复现命令

```bash
colima start --cpu 4 --memory 6 --disk 40 --mount /Volumes/datacenter/04-eric/AIcoding/veggie:w
docker compose -f docker-compose.local-pg.yml up -d --build
docker compose -f docker-compose.local-pg.yml run --rm migrator npx prisma db push
docker compose -f docker-compose.local-pg.yml run --rm -e SEED_FORCE_BULK=1 migrator npx tsx prisma/seed.ts
curl -s http://127.0.0.1:3100/api/health
# 清理
docker compose -f docker-compose.local-pg.yml down -v
```
