# DEV-PLAN：客户门户角标（缺货 / 新品 / 促销）+ 促销规则

日期：2026-09-26
来源：本次对话讨论。无产品文档参与（口头需求 + 我在现有代码里核实后确定的技术方案）。

## 一、这次要解决什么

餐馆客户门户（customer-portal）商品列表加三种角标：**缺货**、**新品**、**促销**。促销角标背后要有真实生效的促销规则（不是纯文案装饰），且规则要能按不同客户群体区分，不是只能全场统一打折。

**范围排除**：讨论一开始提到的"顶部促销轮播广告"和"左侧商品分类导航"，中途你把重点转到了角标+促销规则上，这两项本轮不做，先把角标+促销规则做完。如果你还要轮播和分类导航，告诉我，我再单独出一版计划。

## 二、关键技术决定（我已核实，不是新建一套平行系统）

项目里已经有一套完整的 Odoo 价格表规则引擎（`OdooPricelist.items`，JSON 存的 `OdooPricelistItem[]`）：支持按商品/分类、最小数量、生效时间段（`dateStart`/`dateEnd`）、固定价/折扣% 等方式定价，后台 `/classic/operator/pricelists/[id]` 已经有完整的规则编辑 UI（哪个客户挂哪张价格表，就是"客户群体"的划分方式）。之前讨论"结合价格表、针对不同客户群体做促销"，恰好就是这套引擎已经在做的事。

所以促销**不新建表**，而是：
1. 给 `OdooPricelistItem` 加一个可选字段 `badgeLabel`（角标文案，比如"限时8折"）——纯 TypeScript 类型改动，存进现有 JSON 字段，**不产生 Prisma migration**。
2. 后台价格表规则编辑页加一个"角标文案"输入框（只在这条规则填了 `dateStart`/`dateEnd` 才建议填，永久生效的规则不该叫"限时促销"）。
3. 计价引擎命中带 `badgeLabel` 的规则时，把角标文案 + 折前原价（用于门户画划线价）一起返回。

比新建一张 Promotion 表省一次 schema 迁移、一套新后台页面，也不会和现有定价逻辑打架、产生两套并行的促销判断。

## 三、模块拆解

| 模块 | 改动 |
|---|---|
| 类型 `lib/types.ts` | `OdooPricelistItem` 加 `badgeLabel?: string` |
| 计价引擎 `lib/pricing-engine.ts` | `resolvePrice` 命中项若有 `badgeLabel`，`PriceResolution` 增加 `promoLabel?: string`、`originalPrice?: number`（命中前的基准价，门户拿去画划线价） |
| 客户门户卡片 `lib/customer-portal-products.ts` | `CustomerProductCard` 增加 `promoLabel`、`originalPrice`、`isNew`（`createdAt` 30 天内）、`outOfStock`（`qtyOnHand<=0`）四个字段 |
| 商品网格 `components/customer-portal/product-grid.tsx` | 渲染缺货/新品/促销三种角标 + 促销时的划线原价 |
| 价格表编辑页 `app/[locale]/classic/operator/pricelists/[id]/page.tsx` | 规则表单加"角标文案"输入框 |

## 四、路由清单

不新增路由。复用 `GET /api/customer-portal/products`、`GET /api/customer-portal/frequently-ordered`（两处都走 `buildCustomerProductCards`，改一处两处生效）、`PUT /api/pricelists/[id]`（已支持整份 `items` 覆盖写入，新字段随 JSON 一起存，后端不用改）。

## 五、风险点（附实测数字）

- **缺货比例很高**：开发库里 `ACTIVE` 商品 1736 个，`qtyOnHand<=0` 的有 807 个，占 46.5%。如果生产库类似，门户接近一半商品会挂"缺货"。默认做法是**只提示、不锁购物车**（照样能下单，交给后续拣货环节处理真实缺货），不做"缺货商品不可加入购物车"这种硬阻拦。
- **"新品"用 `createdAt` 判断**：已查开发库，最近 30 天内新建的商品只有 1 个，不会出现"整批导入商品全部挂新品"的误报，这个字段可以直接用。
- **促销规则的生效顺序**：价格表规则按 `sequence` 从小到大匹配到第一条就停，新促销规则如果 `sequence` 比现有常规定价规则大，会排在后面、永远匹配不到、角标不生效。这点我会在编辑页加操作提示，不批量改历史 `sequence`（20260906 已经清过一次冲突，不想再引入新的）。
- **专属特殊价格优先级最高**：客户对某商品若有 `CustomerSpecialPrice`（一对一合同价），不会走到价格表分支，也就不会显示促销角标——预期行为（专属价通常已经比促销价更优惠），但要让你知道会有这种"看不到角标"的情况。

## 六、附录 A：技术验收标准

- `npx tsc --noEmit`、`npm run build` 通过
- `GET /api/customer-portal/products` 返回的商品卡片带 `outOfStock`/`isNew`/`promoLabel`/`originalPrice` 字段；抽查一个手动配了促销规则的商品，验证角标文案和划线价正确
- 查询数不新增：确认 `buildCustomerProductCards` 仍复用同一批 `pricelistsDb.findMany()`，没有为算促销角标而对每个商品单独查库（N+1）
- 鉴权维持现状：`portal.self.access` 不变，不新增路由，无需重新登记 `route-map.ts`
