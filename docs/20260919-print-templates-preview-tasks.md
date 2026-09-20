# 打印模板全量预览页 · 任务台账

> 20260919 开工。目标：把系统里全部打印模板用**生产真实数据**填充，汇总到一个
> HTML 页面，标注每张单据从哪里打印，部署到客户自己的 GCP（Cloud Run），
> 加 Basic Auth 后把链接交给客户统一评审。
>
> 用户已拍板的三件事（20260919 对话）：
> 1. 部署方式 = Cloud Run 新建独立服务（项目 supply-491510），不碰现有 veggie 服务，不碰 DO 生产
> 2. 数据来源 = 生产真实数据快照（因此必须加访问控制，不能裸挂公网）
> 3. 销售订单打印改「Invoice No.」= 启用独立发票号序列（不是沿用订单号）

## 范围：模板清单（盘点结果，16 类 20+ 张）

| # | 模板 | 生成器 | 路线 |
|---|---|---|---|
| 1 | 拣货单 PICKING LIST | `lib/print/trip-picking-template.ts` | 服务端 PDF |
| 2 | 送货单 DELIVERY NOTE | `lib/print/trip-delivery-template.ts` | 客户端 iframe |
| 3 | 销售单 SALES ORDER | `lib/print/trip-sales-template.ts` | 客户端 iframe |
| 4 | 送货汇总单 DELIVERY SUMMARY | `lib/print/trip-summary-template.ts` | 服务端 PDF |
| 5 | 客户签收单 POD | `lib/print/trip-receipt-template.ts` | 客户端 iframe |
| 6 | 发票/送货单/销售单（单订单） | `app/[locale]/classic/print/[id]/page.tsx` | 客户端 |
| 7 | 批量订单打印 | `app/[locale]/classic/print/batch/page.tsx` | 客户端 |
| 8 | 发票 INVOICE（Invoice 实体） | `operator/invoices/[id]/print/page.tsx` | React @media print |
| 9 | 采购单/询价单 PO·RFQ | `lib/purchase-order-pdf.ts` | 服务端 HTML |
| 10 | 价格表 PRICE LIST | `app/[locale]/classic/print/pricelist/page.tsx` | 客户端 |
| 11 | 日报三件套（订单汇总/明细清单/商品×星期） | `lib/print/day-wise-report-template.ts` | 服务端 PDF |
| 12 | 分类总量单 | `daily-sales/_components/SalesStats.tsx` | window.open |
| 13 | 波次拣货单（旧版） | `operator/waves/[id]/page.tsx` | window.open |
| 14 | 报价单（下单页） | `operator/place-order/page.tsx` | DOM 快照 |
| 15 | 老板报表三张 | `boss/sales-report/page.tsx` | window.open |
| 16 | 分析结果表 | `boss/analytics/chat/_components/ChatEntryView.tsx` | window.open |

死代码（不收进预览页，但在页面上注明）：`app/[locale]/classic/print/day-wise-report/page.tsx`

## 交付单元

- [x] **U1 生产数据子集导出**
      验收命令：`ls -la <scratchpad>/snapshot/*.sql && wc -l`
      可看物：导出清单（表名 + 行数）
      定性状态：不需要用户看
      证据：
      依赖：SSH 通（已验证 167.99.86.19:2200，sudo -u postgres 只读查询可跑）
      证据：small.sql 3.6MB（31 张小表全量）+ order.csv 724 单 + orderline.csv 6150 行 + invoice.csv 30 张
      约束：⛔ 生产库只读，只允许 SELECT / COPY TO，不得有任何写操作

- [x] **U2 本地快照库 + 导入**
      验收命令：`psql -h 127.0.0.1 -p 15433 -c 'select count(*) from "Order"'`
      定性状态：不需要用户看
      证据：docker 容器 veggie-snap-pg（127.0.0.1:15433，与共享的 Neon 开发库完全隔离）
      Order=724 OrderLine=6150 Invoice=30 Customer=1590 Product=5406 Pricelist=86 Wave=76 Pallet=70 PO=41
      依赖：U1

- [x] **U3 各模板 HTML 产出**
      验收命令：每张单据产出一个 html 文件，`ls preview-out/*.html | wc -l` ≥ 20
      可看物：单张单据 HTML
      定性状态：待客户确认
      证据：32 个 HTML，全部通过内容体检（无错误页、无空壳）。三条产出路径：
      - 服务端纯函数渲染 18 个（scripts/print-preview/render-server-templates.ts）
      - 浏览器抓 iframe/整页 9 个（capture-client-templates.mjs）
      - 劫持 window.open 抓 5 个（capture-windowopen-templates.mjs）
      依赖：U2

- [x] **U4 销售订单 Invoice No. 样例**（改为「先问再做」）
      ⚠️ 方案在执行中被推翻：原计划按 INV-YYYY-NNNN 呈现一套新号，但查生产库发现
      **系统里已经有 148,285 张发票记录**，号码是 `INV/...`（123,062 张，Odoo 历史）
      和 `V#####`（25,223 张）两种格式，最新一张 V59085 停在 2026-07-13——正好卡在
      8 月初迁服务器前后。也就是说发票号很可能仍由 Odoo 12 在开。
      这种情况下自起一套号会与 Odoo 撞号/断号，会计对不上账。
      因此预览页不给出假号，改为把这个问题列为「需要客户拍板」第 1 条。
      定性状态：待客户确认
      依赖：U3

- [x] **U5 总览页组装**
      内容：每张单据 = 预览 + 「在哪里打印」（页面路径 + 按钮文案 + 角色）+ 已知问题标注
      定性状态：待客户确认
      证据：19 张主单据 + 13 个中英文/变体版本；左侧导航带问题标记（黄点=有注意事项，
      红点=当前打不开）；顶部「需要你拍板的几个问题」6 条
      生成器：scripts/print-preview/build-index.mjs + templates-meta.json
      依赖：U3 U4

- [x] **U6 Basic Auth + 容器化**
      验收命令：本地 `curl -I` 无凭证返回 401，带凭证返回 200
      证据：本地实测 无凭证 401 / 错密码 401 / 正确凭证 200 / 内页无凭证 401 / 内页有凭证 200
      文件：deploy/print-preview/{Dockerfile,nginx.conf,.htpasswd}
      ⛔ .htpasswd 含口令哈希，不要提交 git
      依赖：U5

- [x] **U7 Cloud Run 部署 + 线上验证**
      验收命令：`curl -I -u user:pass https://<url>` 返回 200，无凭证 401
      可看物：https://print-preview-549968261036.europe-west1.run.app/
      定性状态：待用户转给客户
      证据：线上实测 无凭证 401 / 错密码 401 / 正确凭证 200 / 单据页 401→200 / 条码库 200；
      浏览器实际渲染确认标题与 19 张单据数正确
      部署方式：本地 docker build --platform linux/amd64 → 推 europe-west1 已有的
      cloud-run-source-deploy 仓库 → gcloud run deploy --image
      （**没有**用 gcloud builds submit，也没有新建 Artifact Registry 仓库）
      服务配置：print-preview / europe-west1 / 256Mi / min-instances=0 / max-instances=3
      依赖：U6
      约束：项目必须是 supply-491510（部署前 `gcloud config get-value project` 核对）；
      新建独立服务，不得触碰现有 veggie 服务

## 已知风险 / 待决策

1. **真实数据上公网**：客户名、地址、电话、成交价会出现在页面上。已决定加 Basic Auth，
   链接与口令分开交付。如客户要求去掉口令，必须先换成脱敏数据。
2. **发票号序列尚未实现**：预览页展示的是目标形态，不是系统当前行为。当前销售订单
   打印的是订单号。实现前要回答：谁开票、何时开、一张发票能否合并多张订单。
3. **12/15/16 三类模板没有独立生成器**（现拼 HTML 或抓 DOM），要在预览页里如实呈现，
   不能用重写版糊弄——否则客户看到的和实际打印的不是一回事。

## 交付结果（20260919 完成）

**网址**：https://print-preview-549968261036.europe-west1.run.app/

> 20260920 按用户要求改版（revision 00003）：去掉「老板销售报表（三张）」与「波次拣货单（旧版）」
> 两张单据，去掉「没有收录的三项」与「需要你拍板的几个问题」两个模块。
> 单据数 19 → 17 张，编号重排为 1–17。被删的 4 个 HTML 文件**不再部署到站点**
> （它们同样含真实客户数据，留在服务器上等于还挂在公网），线上实测已 404。
> 下面那 6 条待拍板事项从页面上撤下，但仍保留在本台账里，不作废。
**凭证**：用户名 `johnstone`，密码见交付消息（不写进版本库）

线上实测：无凭证 401 / 有凭证 200；32 个单据文件全部 200；条码库与字体 200；
浏览器实际渲染确认 19 个 iframe 全部加载成功、版式正常、无 Cookie 横幅残留。

### 执行中发现、需要客户/用户拍板的 6 件事（已写进预览页顶部）

1. **发票号到底谁在开**（最重要）：生产库有 148,285 张发票，`INV/...` 12.3 万张（Odoo 历史）
   + `V#####` 2.5 万张，最新 V59085 停在 2026-07-13。新系统自起一套号会与 Odoo 撞号/断号。
2. **销售单 PAYMENT 栏印出 "password"**：客户资料付款方式字段脏数据。
3. **发票打印页对生产数据 100% 崩溃**：`invoices/[id]/print/page.tsx:190` 读 `line.taxAmount`，
   而库里发票行是 `{amount, orderId, orderCode}` 的旧结构。不是个别脏数据，是结构不匹配。
   预览页里那张是用真实订单行临时拼的样例。
4. **拣货单有两套并存**：`trip-picking-template`（按商品汇总）与 `waves/[id]` 内联实现
   （按分区+勾选框），样子和口径都不同。
5. **签收单数据源已死**：依赖 Trip 表，生产库 Trip 自 2026-07-04 起无新记录（波次没人点「确认出发」）。
6. **老板销售报表排版未做打印适配**：无抬头无页码，与其他正式单据不是一个规格。

### 另外两个顺带发现（非本次任务范围，记录备查）

- **日报 loader 的状态过滤会漏单**：`STATUS_FILTER` 只认 CONFIRMED/WAVE_ASSIGNED/IN_DELIVERY/COMPLETED，
  而快照里 7/6–7/10 那 669 单状态是 `LOCKED`，在日报里完全不出现。是否有意为之需确认。
- **`stripAutoPrintScript` 对销售单/送货单无效**：那两个模板把 `window.print()` 和 JsBarcode
  初始化写在同一个 `<script>` 块里，而该函数的正则只匹配独立块。生产上没暴露是因为这两张单
  走客户端打印、本来就要弹框；但若将来要给它们出服务端 PDF，会踩到。

### 复现方式

```bash
# 1. 起隔离快照库并灌入生产数据（数据导出脚本见台账 U1）
docker run -d --name veggie-snap-pg -e POSTGRES_USER=veggie -e POSTGRES_PASSWORD=snaponly \
  -e POSTGRES_DB=veggie -p 127.0.0.1:15433:5432 postgres:17-alpine
npx prisma db push --url "postgresql://veggie:snaponly@127.0.0.1:15433/veggie" --accept-data-loss

# 2. 渲染服务端模板（18 个）
DATABASE_URL="postgresql://veggie:snaponly@127.0.0.1:15433/veggie" DATABASE_DRIVER=pg \
  npx tsx --tsconfig tsconfig.print-preview.json scripts/print-preview/render-server-templates.ts <out>

# 3. 起连快照库的 dev server(3200)，抓客户端模板（9 个）与 window.open 类（5 个）
node scripts/print-preview/capture-client-templates.mjs <out> orderId=... invoiceId=... pricelistIds=...
node scripts/print-preview/capture-windowopen-templates.mjs <out> waveId=...

# 4. 组装 + 部署
node scripts/print-preview/build-index.mjs <out> <site>
cd deploy/print-preview && docker build --platform linux/amd64 -t <img> . && docker push <img>
gcloud run deploy print-preview --image=<img> --region=europe-west1 --allow-unauthenticated
```
