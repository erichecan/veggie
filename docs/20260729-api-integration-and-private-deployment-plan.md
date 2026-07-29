# 对外API对接 + SaaS/私有化部署 改造方案

> 状态：规划文档，尚未实现。对应 2026-07-29 的需求核查结论：
> - 条款一「预留标准API接口，对接第三方ERP/财务系统/电子秤/税控盘/物流平台」——**不满足**
> - 条款二「支持SaaS云部署或私有化部署」——**部分满足**（SaaS没问题，私有化有实质障碍）
>
> 本文档只给方案和路线图，不含代码改动。实现时按"分阶段路线图"里的顺序拆成独立的开发任务。

---

## 0. 现状基线（改造前必须知道的几个事实）

| 项 | 现状 | 位置 |
|---|---|---|
| API 鉴权 | 统一 JWT session token，`middleware.ts` 拦截 `/api/*`，无 API Key/OAuth 机制 | `middleware.ts:19-34` |
| API 命名空间 | 无版本号，无对外/对内区分，151 个 route.ts 全部混在 `app/api/` 下 | `app/api/**` |
| 数据库驱动 | `PrismaNeon` adapter + `@neondatabase/serverless`（WebSocket 协议，Neon 专有） | `lib/db.ts` |
| 图片存储 | 硬编码 `@google-cloud/storage` SDK 直连 GCS | `app/api/upload-image/route.ts`、`app/api/purchase-orders/pdf-extract/route.ts` |
| 多租户 | `tenantId` 字段仅存在于 3 个模型（`PurchaseSuggestion`、`Notification`、`Statement`），硬编码默认值 `"test-company"`，业务查询从未按租户过滤 | `prisma/schema.prisma:1285,1323,1341` |
| 容器化 | 已有 Dockerfile（多阶段构建，standalone Next.js + Alpine Chromium），运行时不依赖 GCP 专有 API，理论上可脱离 Cloud Run 独立跑 | `Dockerfile` |
| 现有"数据互通"雏形 | 人工级 CSV/Excel 导入导出：订单导出、采购单导入、供应商账单导入、GDPR 数据导出 | `app/api/orders/export-csv`、`app/api/purchase-orders/import`、`app/api/vendor-bills/import`、`app/api/gdpr/export` |

---

## 1. 改造方案 A：标准对外 API 层

### 1.1 设计原则
- **对内对外彻底分家**：现有 151 个 `/api/*` 路由继续只服务自家前端（JWT session 鉴权不动）。新建独立命名空间 `/api/external/v1/*`，专供第三方系统调用，鉴权、限流、日志与内部 API 完全分离，互不影响。
- **只读优先**：第一期只开放"数据导出/查询"类接口（库存、订单、发票），写入类接口（比如第三方直接建单）放到第二期，降低数据一致性风险。
- **幂等与可重放**：所有写入接口要求调用方传 `idempotencyKey`，避免网络重试导致重复下单/重复扣库存。

### 1.2 鉴权机制
推荐：**API Key + HMAC 签名**（比 OAuth2 client-credentials 更适合中小型 ERP/财务系统的对接习惯，实现和联调成本都更低）。

- 新增 `ApiClient` 模型：`id / name / apiKey(hash) / apiSecret(hash) / scopes[] / rateLimit / active / createdAt`
- 请求头：`X-Api-Key` + `X-Signature`（HMAC-SHA256(secret, method+path+timestamp+body)）+ `X-Timestamp`（拒绝超过 5 分钟的时间戳，防重放）
- `scopes` 做粗粒度权限控制，例如 `inventory:read`、`orders:read`、`orders:write`、`invoices:read`
- 管理界面：在 operator 后台加一个"API 密钥管理"页面，可创建/吊销/查看调用日志

### 1.3 分域接口设计

| 对接对象 | 接口方向 | 建议接口 | 备注 |
|---|---|---|---|
| **ERP** | 双向 | `GET /external/v1/products`、`GET /external/v1/inventory`、`GET /external/v1/orders`、`POST /external/v1/orders`（ERP 下发采购/销售单） | 商品与库存是最高频对接点，优先做 |
| **财务系统** | 出站为主 | `GET /external/v1/invoices`、`GET /external/v1/accounting/journal-entries`（导出 `JournalEntry`/`JournalEntryLine`） | 现有 `journalEntry` 模型已有完整会计分录，改造量小，直接包一层导出接口 |
| **电子秤** | 入站，**非 HTTP** | 需要一个「边缘网关」中间服务 | 电子秤/汇总秤绝大多数走串口(RS232)、TCP 私有协议或厂商 SDK，不会直接说 HTTP。方案是另写一个跑在门店/仓库本地的轻量网关程序（Node/Python 均可），把秤的实时重量转成 HTTP 请求 `POST /external/v1/weighing-events` 推给 veggie。**这部分脱离本仓库范围，需要先拿到具体秤的品牌型号和协议文档才能定型**，工作量按"大"估，且是新建一个独立小项目，不是改现有代码 |
| **税控盘** | 视市场而定 | 视合规要求另设计 | 中国大陆税控盘一般走本地 SDK（COM/串口），欧洲多国是"财政收银机"(fiscal cash register)规范或对接税务局在线开票 API（如意大利 SDI、匈牙利 NAV）。**当前系统界面用 € 符号，面向欧洲市场的可能性更大，必须先确认目标国家/地区，两种合规路径改造量和方向完全不同**，这是本方案里唯一"没调研清楚就没法排期"的一项 |
| **物流平台** | 双向 | `GET /external/v1/trips`、`POST /external/v1/trips/{id}/status`（承运商回传运单状态） + 出站 webhook | 现有 `Trip` 模型已经是"物流交账 SSOT"（见项目历史记忆），改造量中等 |

### 1.4 Webhook 出站机制（配合上面"物流平台""ERP"的双向对接）
- 新增 `WebhookSubscription` 模型：`apiClientId / eventType / targetUrl / secret / active`
- 事件类型：`order.created` / `order.status_changed` / `inventory.low_stock` / `invoice.issued` / `trip.dispatched`
- 投递方式：写入后异步队列（可先用简单的 `setTimeout`/后台 cron 轮询待投递事件表，不引入额外中间件如 Kafka/RabbitMQ，量级不需要）
- 失败重试：指数退避，最多 5 次，超过后标记失败并在管理界面可见

### 1.5 API 文档
- 用 `zod` 定义每个 external 接口的请求/响应 schema（项目已用 TypeScript，改造成本低），跑一个 `zod-to-openapi` 之类的转换脚本自动生成 OpenAPI 3.0 文档，托管在 `/external/docs`（Swagger UI）
- 避免手写维护一份独立文档跟代码脱节

### 1.6 限流与审计
- 按 `ApiClient.rateLimit` 做简单的令牌桶限流（内存或 Redis，视是否已有 Redis 而定，现在项目里没有就先用简单的内存计数 + 数据库落地日志）
- 所有 external API 调用记录到 `ApiCallLog`（复用现有 `writeLog`/`action-log` 的模式即可，不用另起一套）

---

## 2. 改造方案 B：SaaS / 私有化 部署解耦

### 2.1 数据库层解耦（优先级最高，改造量最小）
- 现状：`lib/db.ts` 写死 `PrismaNeon` adapter
- 目标：按环境变量切换，`DATABASE_DRIVER=neon | pg`
  - `neon` 模式：保持现状，继续用于 SaaS 云端
  - `pg` 模式：换成标准 `@prisma/adapter-pg` + `pg` 连接池，接普通 PostgreSQL（客户自建库房服务器、阿里云 RDS、AWS RDS 等都能用）
- Prisma schema 本身不用改（两种 adapter 底层都是标准 Postgres 协议），只改 `lib/db.ts` 一个文件的初始化逻辑

### 2.2 存储层抽象
- 现状：`upload-image`、`pdf-extract` 两处硬编码 `@google-cloud/storage`
- 目标：抽一个 `lib/storage.ts`，定义 `StorageProvider` 接口（`upload/getUrl/delete`），提供两个实现：
  - `GcsStorageProvider`（SaaS 云端默认）
  - `LocalDiskStorageProvider`（私有化默认，存到容器挂载的本地卷；后续可选加 `S3StorageProvider` 兼容 MinIO 等私有对象存储）
- 通过环境变量 `STORAGE_PROVIDER=gcs | local` 切换

### 2.3 私有化部署交付包
- 新增 `docker-compose.private.yml`：veggie 应用容器 + 自建 PostgreSQL 容器 + （可选）MinIO 容器，一条 `docker compose up` 起完整环境
- 新增 `.env.private.example`：私有化场景需要的环境变量模板（`DATABASE_DRIVER=pg`、`STORAGE_PROVIDER=local`、`JWT_SECRET`、无需 GCP 相关变量）
- 新增初始化脚本 `scripts/private-deploy-init.sh`：跑 `prisma migrate deploy` + 建首个管理员账号，替代现在依赖 GCP Secret Manager 手工配置的流程
- 现有 Dockerfile 不用大改，私有化场景直接复用（已验证运行时不硬编码 GCP 调用）

### 2.4 多租户架构决策（需要先做商业模式选择，见第4节问题清单）
两条路径二选一，改造量差异巨大：

- **路径 A（推荐，改造量小）：单租户多实例**——SaaS 客户之间物理隔离，每个客户一套独立的 Cloud Run 服务 + 独立数据库（可以是同一个 Neon 项目下的多个 database，或多个 GCP project）。私有化客户同理，各自一套。现有的"每次部署=一个客户"心智模型完全不用改，`tenantId` 那 3 个遗留字段可以直接删掉。运营成本高一点（N 个客户 N 套基础设施），但改造成本几乎为零。
- **路径 B（改造量大）：真多租户共享实例**——一套部署服务多个客户，数据库里靠 `tenantId` 隔离。需要：46 个模型里凡涉及客户私有数据的都要补 `tenantId` 外键 + 所有 Prisma 查询强制带租户过滤（建议上 Prisma Client Extension 在查询层统一注入，而不是每个 route.ts 手动加，否则极易漏加造成跨租户数据泄露）+ 鉴权体系里 `JwtPayload` 要带上租户信息。工作量评估"大"，且是数据安全高风险区，需要专项安全测试。

### 2.5 许可/激活机制（可选，私有化交付常见配套需求）
如果私有化是要卖给客户自己运维、脱离你方监控的场景，通常还需要一个轻量的 license 校验（比如按机器码或到期时间校验的离线 license 文件），防止客户到期不续费还继续用。**这条不是本方案必需项，是否要做取决于商业模式，见第4节问题清单。**

---

## 3. 分阶段路线图与工作量估算

| 阶段 | 内容 | 工作量 | 依赖 |
|---|---|---|---|
| P0 | 数据库层解耦（2.1）+ 存储层抽象（2.2） | 小–中 | 无，可立即开始 |
| P0 | 私有化部署交付包（2.3） | 中 | 依赖 P0 数据库/存储改造先完成 |
| P1 | 多租户架构决策 + 落地（2.4，取决于选哪条路径） | 路径A：小 / 路径B：大 | **需要先拍板商业模式**（见问题清单） |
| P1 | 对外 API 层基础设施：ApiClient 鉴权 + 限流 + 审计日志（1.1-1.2、1.6） | 中 | 无 |
| P1 | ERP 对接接口（商品/库存/订单，1.3 第一行） | 中 | 依赖 P1 基础设施 |
| P2 | 财务系统导出接口（1.3 第二行） | 小–中 | 依赖 P1 基础设施 |
| P2 | Webhook 出站机制 + 物流平台对接（1.4、1.3 第五行） | 中 | 依赖 P1 基础设施 |
| P2 | OpenAPI 文档自动生成（1.5） | 小 | 依赖前面接口基本定型 |
| P3 | 电子秤边缘网关（独立小项目） | 大 | **需要先拿到设备品牌/型号/协议文档** |
| P3 | 税控盘对接 | 大，方向未定 | **需要先确认目标市场（欧洲哪国/是否含中国大陆）** |

---

## 4. 实现前必须业务侧先确认的问题

这几条不确认，P1 之后的排期没法准确估：

1. **多租户商业模式**：私有化客户之间是"各自一套独立部署"还是"未来要上一个共享的 SaaS 多租户平台"？直接决定选 2.4 的路径 A 还是路径 B（工作量差 10 倍以上）。
2. **税控盘目标市场**：具体是哪个国家/地区？（欧洲财政收银机规范因国而异，中国大陆税控盘完全是另一套技术栈）
3. **电子秤设备信息**：品牌、型号、通信协议（串口/TCP/厂商SDK）——没有这个信息，边缘网关方案没法定型，只能先按"最坏情况"（走私有协议、需要驱动开发）估工作量。
4. **私有化交付是否需要 license 校验**：客户自己运维、你方是否还要控制到期/续费？决定是否要做 2.5。
5. **对外 API 第一批优先对接谁**：ERP、财务、物流三个方向工作量都不小，需要业务侧排出优先级，不建议三个同时开工。

---

## 5. 风险提示

- **多租户如果后补，比一开始就设计好贵得多**：如果第4节问题1选了"路径A单租户多实例"，但半年后客户要求"一套系统管多个子公司"，届时要在有生产数据的情况下做租户隔离改造，风险和成本远高于现在从零设计。建议尽早拍板。
- **电子秤/税控盘是本方案里唯一"没调研就无法估工作量"的两项**，不要在排期里把它们当成常规开发任务处理，先做技术选型调研（可能需要联系设备厂商要协议文档）再排期。
- **对外 API 一旦发布给第三方，接口契约变更成本高**（别人的 ERP 已经接了你的字段），建议 P1 阶段先找 1-2 个种子客户/ERP 服务商做联调验证，不要一次性对所有客户开放。
