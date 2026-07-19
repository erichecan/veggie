# canBeSold / canBePurchased 实际生效设计

## 背景

`ProductTemplate.canBeSold` / `canBePurchased` 两个字段目前基本是摆设：

- `canBeSold`：只在商品编辑表单的勾选框、商品管理列表筛选、审计日志字段标签里出现。下单页
  （place-order）、报价单编辑（quotations/[id]）、销售单编辑（orders/[id]）三个场景的商品
  选择器都没有读取它，关掉这个开关运营依然能把商品加进订单/报价单。
- `canBePurchased`：只在采购单新建/编辑页的商品选择下拉一处生效（`GET /api/products?purchasable=1`
  在服务端过滤）。采购单保存 API、PDF/Excel 导入自动匹配商品的逻辑都不检查这个字段，绕过下拉
  （走导入，或直传 productId）依然能把不可采购商品塞进采购单。

## 目标

让这两个开关在标记为不可售/不可采购之后，真正阻止运营把对应商品加入新的订单/报价单/采购单行，
同时不影响已经存在的历史单据。

## 设计决策（已与用户确认）

1. **拦截强度**：前端选择器隐藏 + 后端保存时硬校验，双保险。理由：`canBePurchased` 目前正是
   "只挡下拉、后端不查"的半吊子状态，才会出现绕过入口（导入、直调 API）的问题，这次两个字段都
   要避免重蹈覆辙。
2. **历史行**：只挡"新增一行"这个动作。已经存在于订单/报价单/采购单里的行，无论商品后来是否被
   关闭 canBeSold/canBePurchased，改数量、改价、删除、整单保存都不受影响。
3. **PDF/Excel 采购导入**：自动匹配的候选商品池排除不可采购商品，使其匹配不上（回落到"未匹配"
   状态），交给现有的人工处理路径，不新增审核 UI。

## 架构：三层防线

```
① 查询层：GET /api/products 新增 sellable=1 参数（对称于已有的 purchasable=1）
② 选择器层：3 个销售页面的商品拉取都带上 sellable=1，采购侧沿用已有的 purchasable=1
③ 保存层：写操作的 API/SSOT 函数里，对"新增行"做一次服务端硬校验，拒绝就 400 + 早返回
```

三层里，①②是同一件事的两半（服务端过滤 + 客户端消费），③是独立的兜底，即使有人绕过①②
（直调 API、未来新增的页面忘记接 sellable 参数）也会在保存时被拦下。

## 详细改动点

### 销售侧（canBeSold）

| 文件 | 改动 |
|---|---|
| `app/api/products/route.ts` | GET 新增 `sellable=1` 查询参数，命中时 `where.template.canBeSold = true`；与已有 `purchasable=1` 合并进同一个 `template` where 对象，互不冲突 |
| `place-order/page.tsx` | 商品拉取 URL 加 `&sellable=1` |
| `quotations/[id]/page.tsx` | 商品拉取 URL 加 `&sellable=1` |
| `orders/[id]/page.tsx` | 商品拉取 URL 加 `&sellable=1` |
| `app/api/orders/route.ts` POST（建单/报价单） | 全部行的 productId 校验 canBeSold，失败则 400 早返回 |
| `app/api/orders/[id]/route.ts` PUT（整单保存） | 只校验 `linesPayload` 里 `!l.id` 的新增行；沿用现有的 `newLineProducts` 批量查询（已经在查 commissionPrice），顺带带上 `template.canBeSold` |
| `app/api/orders/[id]/lines/route.ts` POST（追加单行） | 加同样的校验；当前 UI 没有调用方，但接口存在且可被直调，顺手补上 |

`daily-sales/_components/ShortageHandler.tsx` 明确排除在外——那里的 `ProductSearchInput`
是缺货列表的筛选分面（按商品过滤订单列表），不是"加一行商品"的下单动作，接 `sellable=1`
反而会让用户搜不到历史缺货记录里已下架的商品。

### 采购侧（canBePurchased）

| 文件 | 改动 |
|---|---|
| `lib/create-purchase-order.ts` `createPurchaseOrder()` | 建 PO 前批量查询 `input.lines` 里全部 productId 的 `canBePurchased`，任一为 false 则 `throw Object.assign(new Error(...), { status: 400 })`（与文件里已有的数量/单价校验同一风格）。这是 `POST /api/purchase-orders` 和"采购建议转采购单"（`purchase-suggestions/convert`）唯一的共用创建入口，改这一处即可同时覆盖两条路径 |
| `app/api/purchase-orders/[id]/route.ts` PUT（整单保存） | 只校验新增行（`id` 带 `new-` 前缀的行），批量查询 `canBePurchased`，失败 400 早返回 |
| `app/api/purchase-orders/import/route.ts` | 匹配候选商品池的查询加 `where: { template: { canBePurchased: true } }`；不可采购商品从候选池剔除，`matchProducts()` 自然把对应行标成未匹配（`confidence: 'none'`），交给现有的人工处理路径 |

## 报错处理

统一 `NextResponse.json({ error: '商品「洋葱」已下架，不可加入订单' }, { status: 400 })`。

关键点：`app/api/orders/[id]/route.ts` 和 `app/api/purchase-orders/[id]/route.ts` 的 PUT
catch 块目前会把非特定类型的异常统一吞成 500 + 通用文案（"更新订单失败" / "保存失败"），
会盖掉校验信息。所以这两处的校验用 **early return**（`return NextResponse.json(...)` 直接
写在 try 块里，不走 throw→catch），不是靠 catch 兜底。`app/api/orders/route.ts` POST 和
`app/api/purchase-orders/route.ts` POST 的 catch 块已经对 `err.status` 在 400-499 区间做了
透传，这两处可以沿用文件里已有的 throw 风格。

前端 `lib/api.ts` 的 `humanizeError()` 对 400 状态码会原样把后端 `error` 文案透出给 toast，
不需要改前端错误处理逻辑。

## 非目标 / 不做的事

- 不做"商品被关闭后自动清理历史单据里的行"——历史行永久不受影响
- 不新增采购导入的人工审核 UI——沿用现有的"未匹配"处理路径
- 不动 `lib/server-pricing.ts`——它是定价解析器，不是准入闸门，行已经在订单里之后如何定价
  和是否可售是两件事
- 不批量清理/迁移历史脏数据——本次是行为闸门，不是数据订正

## 验证计划（实现完成后执行）

1. `sellable=1` / `purchasable=1` 的 GET 请求返回结果确实按开关过滤
2. 关闭某商品 `canBeSold`，在下单页/报价单编辑/销售单编辑三处搜索该商品，确认选择器里搜不到
3. 直调 `POST /api/orders`、`PUT /api/orders/:id`（新增行）、`POST /api/orders/:id/lines`，
   productId 传一个 canBeSold=false 的商品，确认返回 400 且报错信息正确
4. 已有订单行引用的商品被后置关闭 canBeSold 后，整单保存（不新增行）确认不受影响、正常成功
5. 采购侧同样跑一遍：`POST /api/purchase-orders`、"采购建议转采购单"、`PUT /api/purchase-orders/:id`
   新增行、PDF/Excel 导入含不可采购商品的文件
6. 检查服务端日志无隐藏 error
