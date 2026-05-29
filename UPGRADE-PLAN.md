# veggie-demo → 生产版本 升级计划

> 状态：待执行（客户确认后开始）
> 目标：把 veggie-demo 的简化界面接入真实 WMS/TMS 后端，成为正式生产前端

---

## 架构定位（最终状态）

```
所有用户（运营、司机、拣货员、餐馆老板）
              │
              ▼
    veggie-demo 风格的简化界面   ← 唯一的用户界面
              │
              │  HTTP API 调用
              ▼
    WMS（NestJS）+ TMS（Express）  ← 业务引擎，用户看不见
              │
              ▼
         Neon PostgreSQL          ← 单一数据库
```

WMS/TMS 的复杂管理界面不面向业务用户，定位降级为：开发调试控制台 + 超级管理员异常处理工具。

---

## 第一阶段：接口盘点（开发前必须完成）

扫描 veggie-demo 所有页面，列出每个操作对应的 API 需求，对照 WMS/TMS 现有路由标注状态。

### 运营人员

| 页面 | 操作 | 需要的 API | WMS/TMS 现状 |
|------|------|-----------|--------------|
| 商品管理 | 查看商品列表 | `GET /products` | ❓ 待确认 |
| 商品管理 | 编辑商品（价格/库存） | `PATCH /products/:id` | ❓ 待确认 |
| 商品管理 | 新建商品 | `POST /products` | ❓ 待确认 |
| 客户定价 | 查看餐馆定价表 | `GET /pricing/restaurant/:id` | ❓ 待确认 |
| 客户定价 | 保存定价规则 | `PUT /pricing/restaurant/:id` | ❓ 待确认 |
| 订单管理 | 查看订单列表 | `GET /orders` | ❓ 待确认 |
| 订单管理 | 生成拣货波次 | `POST /wms-waves` | ❓ 待确认 |
| 拣货波次 | 查看波次列表 | `GET /wms-waves` | ❓ 待确认 |
| 拣货波次 | 查看波次详情 | `GET /wms-waves/:id` | ❓ 待确认 |
| 配送行程 | 查看行程列表 | `GET /trips` | ❓ 待确认 |
| 配送行程 | 创建行程 | `POST /trips` | ❓ 待确认 |

### 餐馆老板

| 页面 | 操作 | 需要的 API | WMS/TMS 现状 |
|------|------|-----------|--------------|
| 商品选购 | 查看商品（含定价） | `GET /products` + `GET /pricing/restaurant/:id` | ❓ 待确认 |
| 商品选购 | 提交订单 | `POST /orders` | ❓ 待确认 |
| 我的订单 | 查看历史订单 | `GET /orders?restaurantId=xxx` | ❓ 待确认 |

### 拣货员

| 页面 | 操作 | 需要的 API | WMS/TMS 现状 |
|------|------|-----------|--------------|
| 拣货列表 | 查看分配给我的波次 | `GET /wms-waves?assignedTo=xxx` | ❓ 待确认 |
| 拣货作业 | 开始拣货 | `PATCH /wms-waves/:id/start` | ❓ 待确认 |
| 拣货作业 | 标记单项完成 | `PATCH /wms-waves/:id/items/:itemId/done` | ❓ 待确认 |
| 拣货作业 | 完成整张波次 | `PATCH /wms-waves/:id/complete` | ❓ 待确认 |

### 分货员

| 页面 | 操作 | 需要的 API | WMS/TMS 现状 |
|------|------|-----------|--------------|
| 分货列表 | 查看待分货波次 | `GET /wms-waves?status=picked` | ❓ 待确认 |
| 分货作业 | 开始分货 | `PATCH /wms-waves/:id/sort-start` | ❓ 待确认 |
| 分货作业 | 按餐馆确认完成 | `PATCH /wms-waves/:id/sort-restaurant/:restId` | ❓ 待确认 |
| 分货作业 | 完成分货 | `PATCH /wms-waves/:id/sort-complete` | ❓ 待确认 |

### 司机

| 页面 | 操作 | 需要的 API | WMS/TMS 现状 |
|------|------|-----------|--------------|
| 今日行程 | 查看分配给我的行程 | `GET /trips?driverId=xxx&date=today` | ❓ 待确认 |
| 配送作业 | 开始配送 | `PATCH /trips/:id/start` | ❓ 待确认 |
| 配送作业 | 核货完成 | `PATCH /trips/:id/restaurants/:restId/verify` | ❓ 待确认 |
| 配送作业 | 填收款金额 | `PATCH /trips/:id/restaurants/:restId/payment` | ❓ 待确认 |
| 配送作业 | 拍照签收（上传图片） | `POST /trips/:id/restaurants/:restId/pod` | ❓ 待确认 |
| 配送作业 | 确认送达 | `PATCH /trips/:id/restaurants/:restId/deliver` | ❓ 待确认 |
| 配送作业 | 行程完成 | `PATCH /trips/:id/complete` | ❓ 待确认 |

> **执行前动作**：逐条对照 WMS/TMS 现有路由文件，把 ❓ 改为 ✅（已有）或 🔴（需新增）或 🟡（有但数据结构需调整）

---

## 第二阶段：认证改造

### 现状
veggie-demo 用 URL 参数传角色（`?role=driver&id=xxx`），无真实认证。

### 目标
每个角色有真实账号，登录后拿 JWT token，后续所有请求带 token。

### 改造内容
1. 把 `app/enter/page.tsx` 改成真实登录页（用户名 + 密码）
2. 登录成功后把 token 存入 sessionStorage（现在存的是角色信息）
3. 所有 API 请求 header 带 `Authorization: Bearer <token>`
4. 后端按 token 判断当前用户角色，不再信任前端传的 role 参数

### 演示模式保留
可以保留一个 `?demo=true` 参数，在 Demo 环境下自动注入测试账号 token，让 `/guide` 导引页点击即可切换角色，不需要每次手动登录。

---

## 第三阶段：数据层替换

### 改造策略
只改 `lib/store.ts`，页面组件不动。

把每一个 `StoreAPI.xxx()` 方法的实现，从读写 localStorage 换成 `fetch` 调用真实 API。

对外接口不变，页面不感知数据来源变化。

```typescript
// 现在（localStorage）
getProducts(): Product[] {
  return loadStore().products
}

// 改造后（真实 API）
async getProducts(): Promise<Product[]> {
  const res = await fetch('/api/products', { headers: authHeaders() })
  return res.json()
}
```

注意：方法签名从同步变异步，页面组件需要配合加 `await` 和 loading 状态。这是唯一需要改页面的地方。

### 改造顺序（按业务优先级）
1. 商品列表（餐馆下单依赖它）
2. 订单提交（核心业务动作）
3. 波次管理（拣货员依赖）
4. 行程管理（司机依赖）
5. 定价表（运营配置）

---

## 第四阶段：种子数据和重置机制

### 演示用种子数据
在 WMS/TMS 各建一套标准演示数据：
- 4 家测试餐馆（Hang Dai Chinese、Good World、Pearl River、Ka Shing）
- 8 个商品（现有 mock-data 里的蔬菜）
- 测试账号：运营×1、餐馆老板×4、拣货员×1、分货员×1、司机×2

### 重置 API
给 `/guide` 演示导引页提供一键重置：
```
POST /demo/reset
→ 删除所有演示期间产生的订单、波次、行程
→ 保留商品、定价、账号等基础数据
→ 让演示可以反复从第1步开始
```

---

## 不需要改动的部分

| 内容 | 原因 |
|------|------|
| 所有页面的 UI 和布局 | 已经过产品验证，不动 |
| `lib/pricing.ts` | 纯业务逻辑，和数据源无关，不动 |
| `lib/types.ts` | 数据结构继续沿用，可能微调字段名 |
| `app/guide/page.tsx` | 演示导引页继续保留，改为用真实 token |
| Tailwind / shadcn/ui 配置 | 不动 |

---

## 里程碑

| 阶段 | 交付物 | 完成标准 |
|------|--------|----------|
| 接口盘点 | 填完上方接口对照表 | 每一行都有明确状态（✅/🔴/🟡） |
| 补全缺失接口 | WMS/TMS 新增/调整路由 | veggie-demo 所有操作在真实环境跑通 |
| 认证改造 | 真实登录流程 | 每个角色能用账号密码登录 |
| 数据层替换 | `lib/store.ts` 全面改造 | localStorage 完全移除 |
| 种子数据 | 生产/演示数据脚本 | `/demo/reset` 一键可用 |

---

*计划制定：2026-04-11 · 执行前请先完成接口盘点*
