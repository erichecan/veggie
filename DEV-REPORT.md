# DEV-REPORT：餐厅自助下单匿名浏览入口（/shop）+ 商品图片批量上传

对应 DEV-PLAN.md（2026-10-20）、需求原话 docs/20261020-veggie-需求原话.md。
登录 bug 排查按用户指示暂停，未动，见 DEV-PLAN.md 附录 B。

## 给你看的

| 场景 | 来源 | 截图/复现方式 | 状态 |
| --- | --- | --- | --- |
| 未登录也能浏览商品（看名字/图片/分类），看不到价格和库存 | 原话第 1、2 条 | file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20261020-shop-mobile.png | 符合 |
| 点"登录查看价格"后，按 RESTAURANT 账号体系登录，直接进客户门户下单 | 原话第 2 条（用户已查证生产库，账号体系确认沿用现有 RESTAURANT） | 访问 http://localhost:3000/shop → 点右上角"登录/注册"→ `?from=shop` → 登录成功后跳 `/customer-portal`（非走角色默认落地页） | 符合 |
| /shop 接入真实商品数据，不是假数据 | 原话第 5 条 | curl `http://localhost:3000/api/public/products` 返回数据库里真实商品（见下方存档证据），不是写死的 mock | 符合 |
| 批量上传商品图片，要支持逐张人工指定商品（不能按文件名自动匹配） | 原话第 6 条 | 商品列表页「批量上传图片」按钮 → `/classic/operator/products/bulk-images`，选图后每张单独点出下拉搜索框指定商品，跟下单页选商品同一套交互组件 | 符合（已端到端验证，见存档） |

**待你确认的点（不是功能没做，是数据现状，需要你看一眼判断是否符合预期）：**
- 现在生产库商品的 `images` 字段几乎全是空的（抽样确认），所以 `/shop` 页面目前看到的大多是 🥬 占位图而不是真实商品图——这是预期中的"接好了接口，等你用批量上传工具把图片传上去"的状态，不是 bug。
- `/shop` 默认排序沿用了 customer-portal 同款的 `sequence asc, createdAt desc`，前几条会出现"vest "、"test AA"、"test BB" 这类测试/演示脏数据商品（历史遗留，非本次引入）。这个排序问题不在本次范围内，若要处理需要你先确认：是清理这批脏数据，还是改排序规则，还是都不动先放着。
- ⚠️ 本机 Chrome 浏览器二进制缺失（Playwright/chrome-devtools MCP 打不开页面，是本机环境问题，非功能问题），这一轮没能在浏览器里真实点击/截图验收最终接真实数据后的页面；上面截图是接数据前静态版本的截图。已改用 curl 对接口返回的真实数据、字段白名单、分页数、鉴权边界逐条验证（见下方存档），但"页面长什么样"这件事严格说还差一次真人眼验收。建议你自己打开 http://localhost:3000/shop 看一眼布局和分类标签是否顺眼。

访问地址：http://localhost:3000/shop （本机本地环境，尚未部署到生产）

## 存档用的

### Stream B：/shop 匿名浏览 + 真实数据接入（大改）

**涉及文件**：新增 `app/[locale]/shop/page.tsx`、`app/api/public/products/route.ts`、`app/api/public/categories/route.ts`、`lib/customer-facing-categories.ts`；改动 `middleware.ts`（放行 `/shop` 页面）、`lib/public-routes.ts`（放行两个 `/api/public/*` 接口）、`app/[locale]/enter/page.tsx`（`?from=shop` 登录后跳转）、`app/api/customer-portal/categories/route.ts`（改用共享的分类过滤函数）、`tests/public-api-routes.test.ts`（白名单快照更新）。

**`/code-review high` 结果处理**（5 条，4 条已修复，1 条确认是误报）：

| # | 问题 | 处理 |
| --- | --- | --- |
| 1 | `/shop` 原来一次性拉 `pageSize=100`，而实际商品总数 1735 条，列表会被静默截断 | 改成真分页（`page`/`totalPages`）+「加载更多」按钮，`PAGE_SIZE=60` |
| 2 | 说 `/api/public/categories` 缺 `canBeSold: true` 过滤 | 核实代码，该过滤条件在上一轮就已经加上了，这条是误报，未改动 |
| 3 | 两个新匿名接口没有限流 | 接入 `lib/rate-limit.ts`，共享 `public-catalog` 桶，60 次/分钟 |
| 4 | 登录后跳转路径写死 `'/customer-portal'`，和 `lib/role-access.ts` 的 `ROLE_HOME.RESTAURANT` 重复一份真相 | 改成引用 `ROLE_HOME.RESTAURANT` |
| 5 | customer-portal 和 /shop 两处分类过滤/聚合逻辑各抄一份，容易改一处漏另一处 | 抽成 `lib/customer-facing-categories.ts` 共享，各自保留原本的过滤差异（/shop 多一个 `canBeSold`） |

**验证证据**（本次会话内重跑，均为刚产生的命令输出，非历史记录）：

```
$ npx tsc --noEmit
（无输出，exit 0）

$ npx tsx --test tests/public-api-routes.test.ts
✔ app/api 下能扫到路由（扫描逻辑本身没坏）
✔ 匿名可达的 API 路由集合与快照完全一致
✔ 客户/订单/商品/财务等敏感前缀绝不在白名单里
✔ 白名单里每一条都在快照里有书面理由
tests 4 / pass 4 / fail 0

$ npm run build
（成功，路由树含 /shop，无 error/failed）

$ curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/shop
200
$ curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/classic/operator/products/bulk-images   # 匿名
307
$ curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/customer-portal   # 匿名
307
$ curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/customer-portal/products   # 匿名
401

$ curl -s "http://localhost:3000/api/public/products?page=1&pageSize=3"
{"products":[...3条真实商品...],"total":1735,"page":1,"pageSize":3,"totalPages":579}
# total=1735 印证了修复前 pageSize=100 会截断 94% 的商品，现已用分页解决

# 字段白名单检查（20 条抽样，Python 脚本核对 key 集合）
实际 key: ['categoryId','id','images','name','saleDescription','spec']
未出现任何价格/库存字段（price/listPrice/standardPrice/qtyOnHand 等）

# 限流突发测试：连续 65 次请求同一个 public-catalog 桶
60 次 200，随后 5 次 429；约 60 秒后恢复 200
```

**Stream A：商品图片批量上传（小改，4 文件，无 schema 变更）**

改了什么：新建 `app/api/products/bulk-images/route.ts`（后端，鉴权 `master.product.update`，限流 10/分钟，`FormData` 按 `image:<productId>` 键写入 `Product.images`）、`app/[locale]/classic/operator/products/bulk-images/page.tsx`（前端，选图后用 `useInlineProductPicker` 逐张指定商品）；改动 `lib/rbac/route-map.ts`（登记新路由）、`app/[locale]/classic/operator/products/page.tsx`（列表页加入口按钮）。

端到端验证（真实登录 + 真实数据库写入 + 回读确认 + 清理）：
```
登录 boss@demo.local → 拿到 JWT
POST /api/products/bulk-images（1x1 测试 PNG，productId=cmqn90vbz02nfdmyli3w876kp）
→ 200 {"results":[{"productId":"...","ok":true,"url":"/uploads/products/..."}]}
→ 回读 /api/public/products 确认该商品 images 字段已更新
→ 测试完成后 PUT 该商品 images:[] 还原，确认恢复为 []（未留测试脏数据）
```

**已知不可用功能 / 环境限制（不隐瞒）：**
- 本机开发环境没有把 `/uploads/*` 挂载出去（生产环境靠 `deploy/droplet/nginx-veggie.conf` 的 `location /uploads/` 直接读磁盘文件），所以本机上传成功后直接访问图片 URL 会 404。这是本机 dev 环境的固有缺口，老功能"单张上传商品图片"（`/api/upload-image`）一样会 404，不是这次新功能引入的问题，生产环境不受影响。
- 浏览器端真实点击验收本轮未能完成（本机 Chrome 二进制缺失），改用 curl + 真实登录 + DB 回读的方式验证了后端行为，但页面交互手感（点击、下拉选品框弹出位置、拖拽体验）还没有真人在浏览器里走过一遍，建议你抽空用真实浏览器点一下 `/classic/operator/products/bulk-images` 和 `/shop`。
