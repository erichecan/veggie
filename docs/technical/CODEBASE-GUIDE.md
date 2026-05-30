# veggie-demo 代码说明文档

> 写给团队：这份文档解释 veggie-demo 是什么做的、数据怎么流、哪些代码将来有用、哪些可以扔掉。

---

## 一、这个 demo 是完全 mock 的，和正式系统没有共用任何代码

**结论先说：**

| 层级 | 正式系统（WMS / TMS / Ordering） | veggie-demo |
|------|----------------------------------|-------------|
| 后端 API | NestJS / Express，真实 REST 接口 | **无后端**，零 API |
| 数据库 | Neon PostgreSQL（云端真实 DB） | **无数据库**，全部存在浏览器 localStorage |
| 认证 | JWT，Passport.js | **无认证**，角色靠 URL 参数传入 |
| 数据流 | 前端 fetch → 后端 → DB | 前端直接读写 localStorage |
| 文件路径 | `ordering/`、`wms/`、`tms/` | `veggie-demo/`（独立目录） |

veggie-demo 是一个**纯前端、零依赖的独立 Next.js 应用**，没有复用正式系统任何一行后端代码，也没有共用任何组件库（两套都用 shadcn/ui，但各自独立安装）。

---

## 二、数据是怎么流的

```
用户操作（点击按钮）
     │
     ▼
页面组件（React）
     │  调用
     ▼
StoreAPI（lib/store.ts）   ← 这是唯一的"后端"
     │  读写
     ▼
localStorage（浏览器本地存储）
     │
     ├── veggie_demo_store  → 商品、订单、波次、行程、定价表
     └── veggie_role        → 当前标签页的角色（sessionStorage）
```

**关键特征：**
- 所有数据只存在当前浏览器里，刷新不丢，关闭浏览器清空
- 没有网络请求（除了加载商品图片，图片来自 Wikimedia Commons）
- 不同浏览器标签页共享 localStorage，但角色（sessionStorage）各自独立，所以可以在不同标签页模拟不同角色

---

## 三、文件清单和用途说明

### `lib/` — 核心逻辑层

| 文件 | 作用 | 将来正式开发时 |
|------|------|----------------|
| `lib/types.ts` | 定义所有数据结构（Product、Order、PickingWave、Trip 等） | **有参考价值**，数据模型设计可以直接借鉴给正式系统的 Prisma schema 和 TypeScript 类型 |
| `lib/store.ts` | 模拟"数据库 + API"，全部读写 localStorage | **丢弃**，正式系统用真实 API |
| `lib/mock-data.ts` | 种子商品数据（8 个蔬菜）、餐馆名单、角色名单 | **丢弃**，正式系统从数据库读取 |
| `lib/pricing.ts` | 定价解析逻辑（全局折扣 + 单品例外，33 行） | **可以直接复用**，这是真实业务逻辑，和后端无关 |
| `lib/hooks.ts` | 通用小工具 | 视情况 |
| `lib/utils.ts` | shadcn/ui 的 cn() 工具函数 | 样板代码，正式项目会自带 |

### `app/` — 页面层

所有页面都是**有参考价值的 UI 实现**，但数据层需要改造。

| 目录 | 对应角色 | 将来正式开发时 |
|------|----------|----------------|
| `app/operator/products/` | 运营 · 商品管理 | UI 可参考，数据改为调用 WMS API |
| `app/operator/pricing/` | 运营 · 客户定价 | UI 可参考，数据改为调用 WMS pricing API |
| `app/operator/orders/` | 运营 · 订单管理 | UI 可参考 |
| `app/operator/waves/` | 运营 · 拣货波次 | UI 可参考 |
| `app/operator/trips/` | 运营 · 配送行程 | UI 可参考 |
| `app/restaurant/` | 餐馆 · 下单 | UI 可参考，这是正式 ordering 系统的原型 |
| `app/picker/` | 拣货员 · 仓库拣货 | UI 可参考，对应 WMS 拣货模块 |
| `app/sorter/` | 分货员 · 分货装箱 | UI 可参考 |
| `app/driver/` | 司机 · 配送签收 | UI 可参考，对应 TMS 司机端 |
| `app/guide/` | 交互式演示导引 | **demo 专用，正式系统不需要** |
| `app/enter/` | 角色切换入口页 | **demo 专用，正式系统不需要**（正式系统有真实登录） |

### 其他文件

| 文件 | 说明 |
|------|------|
| `cloudbuild.yaml` | GCP Cloud Run 部署配置，**demo 专用** |
| `Dockerfile` | Docker 构建配置，**demo 专用** |
| `DEMO-GUIDE.md` | 对外分享的文字版操作指南 |
| `CODEBASE-GUIDE.md` | 本文档 |

---

## 四、正式开发时，哪些可以直接复用

### ✅ 可以直接复用（搬过去不需要大改）

**`lib/pricing.ts`（33 行）** — 定价解析逻辑
```
给定一个商品、一个餐馆 ID、一张价格表，返回实际单价。
优先级：单品例外规则 > 全局折扣 > 牌价
这段逻辑和数据库无关，搬到任何项目都能用。
```

**`lib/types.ts` 里的数据结构** — 作为设计参考
```
Product、Order、OrderItem、PickingWave、WaveItem、Trip、
TripRestaurant、RestaurantPricelist、PricingRule
这些类型反映了完整的业务流程，可以直接指导 Prisma schema 设计。
```

**所有页面的 UI 布局和交互细节** — 作为设计稿
```
demo 的每个页面都经过产品验证，布局、按钮位置、状态流转已经跑通，
正式开发时可以直接对照实现，不用从零想 UI。
```

### ❌ 不能复用，正式开发要重写的

| 要重写的部分 | 原因 |
|-------------|------|
| `lib/store.ts` 全部 | 用 localStorage 模拟的，要换成真实 API 调用（fetch / SWR / React Query） |
| `lib/mock-data.ts` 全部 | 硬编码种子数据，正式系统从数据库读 |
| `app/enter/` | 角色切换入口是 demo 专用，正式系统有登录页 |
| `app/guide/` | 演示引导页是 demo 专用 |
| `app/page.tsx`（首页） | 是 demo 的角色选择首页，正式系统的首页不是这个 |

---

## 五、总结：这个 demo 的定位

```
veggie-demo = 产品原型 + 客户演示工具

它的价值：
  ✅ 让客户/投资人看到完整业务流程跑通
  ✅ 让开发团队对齐 UI 和交互细节
  ✅ 数据模型设计参考

它不是：
  ❌ 正式系统的一部分
  ❌ 可以直接上生产的代码
  ❌ 和 WMS / TMS / Ordering 有任何代码共用
```

正式开发时，把 `veggie-demo/` 整个目录视为**参考资料**，不要往正式项目里合并它的代码——只参考 UI 布局和 `lib/pricing.ts` 的业务逻辑。

---

*最后更新：2026-04-11*
