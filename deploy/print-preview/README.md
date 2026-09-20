# 打印模板评审页 —— 构建前置条件

纯静态站，只为给客户看单据长什么样。不连数据库、不含应用代码。

## ⛔ 干净检出**不能**直接 `docker build`

Dockerfile 里这两个 `COPY` 的源都**不在 git 里**（`.gitignore:87-88`），这是有意的：

| 路径 | 为什么不提交 | 怎么来 |
|---|---|---|
| `.htpasswd` | 含 Basic Auth 口令哈希 | 见下面「生成 .htpasswd」 |
| `site/` | 是渲染产物（19 张单据 + 13 个变体），跟着模板代码走，提交进去必然过期 | 见下面「生成 site/」 |

直接在新机器上 `docker build` 会以 `COPY failed: no source files` 失败 —— 不是环境坏了，
是这两步没做。完整流程见 `docs/20260919-print-templates-preview-tasks.md` 的「复现方式」。

## 生成 site/

需要一个灌了生产数据的隔离快照库（**不要连生产库**）：

```bash
# 1. 起隔离快照库
docker run -d --name veggie-snap-pg -e POSTGRES_USER=veggie -e POSTGRES_PASSWORD=snaponly \
  -e POSTGRES_DB=veggie -p 127.0.0.1:15433:5432 postgres:17-alpine
npx prisma db push --url "postgresql://veggie:snaponly@127.0.0.1:15433/veggie" --accept-data-loss

# 2. 服务端模板（18 个）
DATABASE_URL="postgresql://veggie:snaponly@127.0.0.1:15433/veggie" DATABASE_DRIVER=pg \
  npx tsx --tsconfig tsconfig.print-preview.json scripts/print-preview/render-server-templates.ts <out>

# 3. 起连快照库的 dev server(3200)，抓客户端模板（9 个）与 window.open 类（5 个）
node scripts/print-preview/capture-client-templates.mjs <out> orderId=... invoiceId=... pricelistIds=...
node scripts/print-preview/capture-windowopen-templates.mjs <out> waveId=...

# 4. 组装成站点
node scripts/print-preview/build-index.mjs <out> deploy/print-preview/site
```

## 生成 .htpasswd

```bash
htpasswd -Bc deploy/print-preview/.htpasswd <用户名>
# 没有 htpasswd 命令时：
docker run --rm httpd:alpine htpasswd -Bbn <用户名> <口令> > deploy/print-preview/.htpasswd
```

口令不要写进任何提交的文件；发给客户走单独渠道。

## 构建与部署

```bash
cd deploy/print-preview
docker build --platform linux/amd64 -t <img> . && docker push <img>
gcloud run deploy print-preview --image=<img> --region=europe-west1 --allow-unauthenticated
```

⛔ 部署前先 `gcloud config get-value project` 核对是 `supply-491510`；
这是**独立服务**，不要碰现有的 veggie 服务。
