# 00 · 系统概览

> North Fresh —— 面向爱尔兰中餐馆的蔬菜/食材 B2B 配送系统。当前由运营（OPERATOR）代客下单，未来上 C 端（customer-portal 已有雏形）。
> 本文档基于真实代码静态分析，关键结论标注文件路径+行号；不确定处标注「待确认」。

---

## 1. 技术栈

| 层级 | 技术 | 版本/说明 |
|---|---|---|
| 框架 | Next.js（App Router，默认 Server Components） | 16.2.3 |
| UI 运行时 | React | 19.2.4 |
| 语言 | TypeScript | 5.x |
| ORM | Prisma | 7.7.0，客户端输出到 `lib/generated/prisma`（`schema.prisma` 行 2-4） |
| 数据库 | PostgreSQL（Neon serverless，`@prisma/adapter-neon`） | — |
| 认证 | JWT（`jose`，HS256，7 天有效）+ `bcryptjs` 密码哈希 + 自研 TOTP（`lib/totp.ts`） | — |
| 样式 | Tailwind CSS 4 + shadcn 风格自建组件 + `@base-ui/react` + `antd`（表格/表单） | — |
| 图表/报表 | `recharts`、`xlsx`（导出）、`jsbarcode`、`pdf-parse` | — |
| 地图 | `@vis.gl/react-google-maps`、`leaflet`/`react-leaflet` | 配送距离/地理编码 |
| i18n | `next-intl` 4.9.1，locale = `zh`（默认）/`en`，prefix=`as-needed` | — |
| 其他 | `resend`（邮件）、`@sentry/nextjs`（监控）、`ws`（WebSocket） | — |

> ⚠️ 见 `AGENTS.md`：本项目 Next.js 版本有 breaking changes，写代码前先读 `node_modules/next/dist/docs/`。`[locale]` 等 params 为 `Promise`，需 `await`。

---

## 2. 认证与鉴权

**关键文件**：`middleware.ts`、`lib/auth.ts`、`app/api/auth/login/route.ts`、`lib/permissions.ts`

### 2.1 JWT 流程
- 登录签发 `signToken(payload)`（`lib/auth.ts`），HS256，7 天。
- Token 双存：
  - **Cookie `veggie_token`**（path=/，maxage=7d，SameSite=Lax）—— 供 middleware SSR 校验。
  - **localStorage `veggie_token`** —— 供前端 API 调用；`veggie_user` 存用户快照供前端按角色路由。
- **Payload 结构**（`lib/auth.ts` 行 30-39）：`{ userId, email, role, roles?[], name, customerId? }`。

### 2.2 middleware 拦截
`middleware.ts`（行 32-66）：所有非白名单 `/api/*` 请求必须带 `Authorization: Bearer <token>`，否则 401。中间件把 cookie 中的 token 转发为 header。白名单：`/api/auth/login`、`/api/health`、`/api/customers`、`/api/tile`。
i18n 中间件（`next-intl`）只做语言前缀处理，**不参与鉴权**。

### 2.3 RBAC
- 轻量级 RBAC 在 `lib/permissions.ts`（无 `@casl`，纯 TS 矩阵，行 46-124）：`Role × (Subject, Action) → bool`。
- Actions：read/create/update/delete/confirm/cancel/receive/invoice/pay/settle/approve_edit/manage_users/export_gdpr/delete_gdpr。
- **BOSS = 超级管理员，全通过**。
- 后端：`withAuth(req, handler, allowedRoles?)`；前端：`useAbility()` + `can(action, subject)`（从 localStorage 读 role）。

### 2.4 多角色（单角色 → 数组迁移中）
- `User.role`（单值，向后兼容）+ `User.roles[]`（字符串数组，新）。
- 登录解析（`app/api/auth/login/route.ts` 行 57-69）：`roles[]` 非空则用之，否则回退单 `role`；token 与响应同时下发两者。
- **前端路由/权限目前仍用单 `role`**（待迁移到 `roles[]`）。

### 2.5 角色 → 落地页
`app/[locale]/enter/page.tsx`（行 14-22）：
```
OPERATOR  → /classic/operator      RESTAURANT → /customer-portal
SORTER    → /classic/sorter        DRIVER     → /classic/driver
BOSS      → /classic/boss          FINANCE    → /classic/accounting
WAREHOUSE → /classic/warehouse     SALES      → （enter 页未显式映射，权限存在但无独立页）
```

---

## 3. 目录结构（精简地图）

```
app/
├─ [locale]/
│  ├─ enter/                 登录页（演示账号 + 手动登录）
│  ├─ classic/               B2B 内部门户（按角色分目录）
│  │  ├─ operator/           运营中枢（~27 子模块，全功能导航）
│  │  ├─ boss/               老板报表（经营总览 + 分析 + 销售报表）
│  │  ├─ finance/            财务总览/对账单/司机交账/核销
│  │  ├─ accounting/         会计（核销/总览/对账单/交账）
│  │  ├─ driver/             司机配送 + 交账
│  │  ├─ sorter/             分货任务
│  │  ├─ warehouse/          仓库管理（到货/出货/库存/采购）
│  │  ├─ restaurant/         餐厅自助下单（旧版，C 端雏形）
│  │  └─ print/              打印模板（拣货/送货/汇总/价格表）
│  └─ customer-portal/       C 端门户（商品浏览 + 我的订单），未上线
└─ api/                      ~45 个路由模块（见 04 文档）

lib/
├─ auth.ts permissions.ts db.ts api.ts        认证/鉴权/Prisma 单例/前端 fetch
├─ server-pricing.ts pricing-engine.ts        定价引擎（见 03 文档）
├─ accounting.ts                              凭证/科目（见 03 文档）
├─ order-code.ts action-log.ts uom.ts ...     编号/审计/单位换算
├─ reports/{definitions,sql-builder,types}.ts 透视报表引擎（见 04 文档）
├─ print/                                     打印模板加载器
└─ generated/prisma/client/                   Prisma 自动生成客户端

prisma/
├─ schema.prisma            38 model（见 01 文档）
├─ migrations/              迁移历史；报表 VIEW 在 20260522_reporting_views/
└─ seed*.ts                 多个种子脚本（见 05 文档）
```

---

## 4. 多租户

**软多租户（单库，预留字段，当前未激活）**。
仅 `PurchaseSuggestion`/`Notification`/`Statement` 三张表有 `tenantId String @default("test-company")`。无租户路由段、无 header 校验。当前为单租户「North Fresh」。
应用层隔离主要靠 `customerId`（RESTAURANT 角色）+ JWT scope。

---

## 5. 整体架构

- **Server Components**：根/locale layout、i18n 消息加载；**Client Components**：`classic/*`、`customer-portal`、`enter` 下几乎所有交互页（`'use client'`）。
- **业务逻辑位置**：集中在 `app/api/**/route.ts`（REST 风格 Route Handlers）+ `lib/*`。前端只做 UI + 通过 `lib/api.ts` 调 API。
- **数据流（下单为例）**：前端表单 → `lib/api.ts` POST `/api/orders`（带 JWT）→ middleware 校验 → route handler（`withAuth` + `can()` + 定价重算 + 事务）→ 响应。
- **审计**：每次变更写 `ActionLog`（`lib/action-log.ts`）；订单状态变更额外写 `OrderAuditLog`。
- **错误**：后端抛 `ApiError`；前端 `lib/api.ts` 拦截 401 → 清 token 跳 `/enter`；UI 用 `sonner` toast。

---

## 关联文档
[01 数据模型](01-data-model.md) · [02 角色与工作流](02-roles-and-workflows.md) · [03 业务规则](03-business-rules.md) · [04 功能与报表](04-features-and-reports.md) · [05 数据来源与种子现状](05-data-sources-and-seed-state.md)
