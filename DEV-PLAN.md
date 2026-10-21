# DEV-PLAN：餐厅自助下单——新增匿名可浏览入口（不显价/不显库存），登录后看价下单

日期：2026-10-20

## 读取了哪些文档

项目根目录无专门的 PRD/需求文档命中（`ls *.md` 只有 README/CLAUDE/AGENTS/DEV-PLAN/DEV-REPORT）。需求来源是用户口头描述，逐字存档见
`docs/20261020-veggie-需求原话.md`。

## 现状排查（技术决策依据，不用你看）

1. **已存在的客户自助下单门户**：`app/[locale]/customer-portal/**`，功能完整（商品网格、分类导航、促销角标、购物车、下单、我的订单、常购/收藏），但要求登录且 `role==='RESTAURANT'`（`customer-portal/layout.tsx:21`），没有任何匿名可看的部分。
2. **账号体系已经是独立的一套**：不是新建数据表，是同一张 `User` 表里 `role='RESTAURANT'`，通过 `/register` 自助注册（创建 Customer+User，`isActive=false, pendingApproval=true`，人工审核后才能登录）。这跟内部调度员/业务员等角色完全分开，已验证（你的要求，已到生产库核实）。
3. **还有一套孤立的 Demo 旧页面** `app/[locale]/classic/restaurant/**`：功能更简陋，付款是假的（"🔔 Demo 演示·点击确认即模拟付款成功"），没有任何导航链接指向它（只有自己内部互相引用），最近一次改动是 2026-10-10 的批量质量修复带过的，不是本次要动的东西——**本次不碰，不整合，不删除**。
4. **商品价格因客户而异**：`resolveCustomerPrice()`（`lib/pricing-engine.ts:320`）需要一个具体 Customer 才能算价。匿名访客没有 Customer，所以匿名接口**不能**调用现有的 `buildCustomerProductCards`（那个函数设计上就是要算价的），必须另写一个不算价、只读基础字段的函数，而不是"算完价格再在返回前删掉"——后者容易因为漏删某个字段（如 `lastPrice`/`originalPrice`）造成价格泄露。
5. **当前没有任何真正公开的页面**：根路径 `/` 直接判断 localStorage 有无 session，没有就跳 `/enter`；`/enter` 登录页没有 `returnTo` 机制，登录后固定跳 `getDefaultLandingPath`。本次要新加"匿名浏览→点击登录→登录后跳回原流程/直接进 customer-portal"。
6. **公开 API 白名单是生产踩过真坑的地方**（2026-08-02 `/api/customers` 匿名泄露 1605 条客户全量数据的事故，见 `lib/public-routes.ts` 顶部注释与 `tests/public-api-routes.test.ts` 快照锁定）。新增白名单条目必须专门为匿名场景新写、从查询层就不触碰价格/客户/财务数据的接口，不能把现有接口改成可选鉴权后直接扔进白名单。
7. **分类导航**现有实现 `app/api/customer-portal/categories/route.ts` 要求登录（`withAuth`），且过滤了一批内部测试类目（`all/stockable/saleable/test` 等，历史 Odoo 导入遗留），匿名版本要复用这个过滤名单，否则客户会看到内部类目。

## 场景清单（这是你说的/客户说的/我推断的，逐条标来源）

- [你说的] 餐厅自助下单要有一个单独的入口，不是现在藏在登录后面的 `/customer-portal`。
- [你说的] 不登录也能浏览商品，但看不到价格。
- [你说的] 登录后能看到价格（并继续下单）。
- [你说的] 账号体系沿用已经存在的、跟内部调度员分开的那一套（RESTAURANT 角色 + 自助注册审核），不新建。
- [你说的] 未登录时商品名+图片+分类都显示，价格和库存都不显示。
- [我推断的] 未登录状态下点"查看价格/加入购物车"时，引导去登录，登录成功后直接进已有的 `/customer-portal`（复用现成的下单/购物车全流程），而不是在匿名页里重新做一套下单逻辑——这是为了不重复造轮子，但"是不是你想要的交互"需要你看了截图再确认。
- [我推断的] 新入口的 URL 定为 `/shop`（默认命名，你想叫别的名字随时改，不影响实现）。
- [我推断的] 匿名页不展示促销角标/新品角标/常购清单/再来一单——这些都依赖登录态和历史订单数据，未登录状态下没有意义，直接不做。
- [我推断的] 已登录的 RESTAURANT 用户如果手动访问 `/shop`，直接跳转到 `/customer-portal`（避免同一个人看到两套长得像但不一样的商品页，造成困惑）。

## 范围：这次不做

- 不碰、不整合 `classic/restaurant` 那套孤立 Demo 旧页面。
- 不改注册审核流程（`/register` 现状保留）。
- 不做匿名下单（必须登录才能真正下单，匿名页只能看不能买）。
- 不做"匿名加购物车、登录后恢复购物车"这种跨会话购物车合并——复杂度与收益不成比例，匿名页纯浏览，加购/下单一律引导登录后在 customer-portal 里重新操作。

## 模块拆解

1. **新匿名浏览页面** `app/[locale]/shop/page.tsx` + `layout.tsx`
   - 商品网格（名称+图片+分类，无价格无库存角标）、分类筛选、分页。
   - 页面顶部/每个商品卡片上有"登录查看价格"引导按钮。
   - 已登录 RESTAURANT 用户访问自动跳 `/customer-portal`。

2. **新匿名只读 API**
   - `GET /api/public/products`：复用 `status=ACTIVE` + `sellable` 过滤，只 select `id/name/spec/images/categoryId`，不 join 价格表、不碰 `Customer`。
   - `GET /api/public/categories`：复制现有分类聚合逻辑（含 `HIDDEN_CATEGORY_NAMES` 过滤），去掉 `withAuth`。

3. **登录跳转补一个 returnTo**
   - `/enter` 页面加一个可选 query 参数（如 `?from=shop`），登录成功后如果带这个参数就跳 `/customer-portal`，否则维持现状 `getDefaultLandingPath`。只加这一个分支，不改其他角色的登录行为。

4. **路由保护登记**
   - `middleware.ts` 页面分支：`/shop` 加入匿名放行名单（跟 `/enter`、`/register` 同一处判断）。
   - `lib/public-routes.ts`：新增 `/api/public/products`、`/api/public/categories` 两条，写清楚"只读商品名/图片/分类，不含价格、库存、客户、财务数据"的理由。
   - `tests/public-api-routes.test.ts` 快照同步更新。

## Schema 设计

不需要新表、不需要新字段。全部复用现有 `Product`、`ProductCategory` 表的现有字段。

## 路由清单

| 路径 | 访问权限 | 说明 |
|---|---|---|
| `GET /shop` | 匿名 | 新增，商品浏览 |
| `GET /api/public/products` | 匿名 | 新增 |
| `GET /api/public/categories` | 匿名 | 新增 |
| `GET /customer-portal` | 需登录(RESTAURANT) | 现状不变，登录后下单仍在这里完成 |

## 风险点

1. **白名单扩面是真事故区**：新接口从查询层就不 select 价格/客户字段，不是"返回前删字段"，避免重复 2026-08-02 的坑。
2. **分类污染**：必须复用 `HIDDEN_CATEGORY_NAMES` 过滤名单，否则内部测试类目("TEST"等)会被客户看到。
3. **两套商品页混淆**：已登录用户手动输入 `/shop` 网址会被强制跳到 `/customer-portal`，避免看到两份长得不一样的商品列表。
4. **`/enter` 改动范围要收窄**：只加一个 query 参数分支，不能动到其它角色（BOSS/OPERATOR/SALES 等）现有的登录跳转逻辑。

## 执行顺序（先出可看物，不是先写后端）

1. 先出 `/shop` 静态页截图（真实文案+假数据+能点，不接真实 API）给你确认长什么样、交互对不对——这一步不动数据库和后端。
2. 你确认后，接 `/api/public/products`、`/api/public/categories` 真实数据。
3. 接登录引导 + `returnTo` 跳转，打通"浏览→登录→进 customer-portal 下单"整条链路。
4. 跑 `scripts/verify.sh` + 补充本次新增路由的鉴权探针（匿名访问 `/api/public/*` 应 200 且不含价格字段；匿名访问 `/customer-portal/*` 应 302/401）。
5. `/code-review high` + `/security-review`（本次属于新路由+鉴权变更的大改，按 CLAUDE.md 十一节必须跑）。

## 附录 A：技术验收标准（我负责，你不用看）

`scripts/verify.sh` 本次新增断言：

- `npx tsc --noEmit`、`npm run build` 通过
- 路由探针：`GET /shop` 匿名 200；`GET /api/public/products` 匿名 200；`GET /api/public/categories` 匿名 200
- 鉴权探针：
  - `GET /api/public/products` 匿名返回的商品对象里**不含**任何价格字段（`customerPrice`/`price`/`listPrice`/`lastPrice`/`originalPrice`）和库存字段（`outOfStock`/`qtyOnHand`）——断言 JSON 里这些 key 不存在，不是断言值为 null
  - `GET /customer-portal` 匿名访问应被 middleware 重定向到 `/enter`（302）
  - `GET /api/customer-portal/products` 无 token 应仍 401（确认本次改动没有顺手放宽现有接口）
- `tests/public-api-routes.test.ts` 快照更新且通过
- 查询探针：`/api/public/products` 不 N+1、分页合理

铁律：verify.sh 不过不写完成报告；没有命令输出的条目标 ⚠️ 未验证，不标 ✅。

### 实际验收结果（2026-10-20，本次会话内重跑，证据见 DEV-REPORT.md「存档用的」）

- ✅ `npx tsc --noEmit` 通过（exit 0，无输出）
- ✅ `npm run build` 通过（路由树含 `/shop`，无 error/failed）
- ✅ 路由探针：`/shop`→200、`/api/public/products`→200、`/api/public/categories`→200
- ✅ 鉴权探针：抽样 20 条商品 key 集合仅 `categoryId/id/images/name/saleDescription/spec`，不含任何价格/库存字段；`/customer-portal`匿名→307（本项目用 intl 中间件统一走 307 而非 302，效果等价）；`/api/customer-portal/products` 无 token→401（未被顺手放宽）
- ✅ `tests/public-api-routes.test.ts` 4/4 通过
- ✅ 查询探针：`/api/public/products?page=1&pageSize=3` 返回 `total:1735, totalPages:579`，确认分页生效（修复前 `pageSize=100` 单次拉取会截断 94% 商品）
- ✅ 限流：65 连发同一限流桶，60×200 后 5×429，约 60 秒后恢复
- ⚠️ 浏览器真实点击/视觉验收未完成（本机 Chrome 二进制缺失，Playwright/chrome-devtools MCP 打不开页面），已用 curl + 真实登录 + DB 回读替代，但页面交互手感仍待你本人在浏览器里确认

## 附录 B：登录问题排查进度（已暂停，留档待续）

你要求先搁置，已排查到的结论（避免下次重新来一遍）：
- 生产 `JWT_SECRET` 已正确设置，不是用兜底假密钥
- 生产镜像是最新的，历史"Cookie 横幅挡住登录按钮"修复已生效
- 你的账号 `erichecan@gmail.com` 在生产库状态正常（role=BOSS, isActive=true）
- 你描述的现象是"感觉跳转了一下，又被弹回登录页"，用手机自带浏览器直接打开网址——这个模式历史上出现过（`middleware.ts:95` 注释记录的"同名 cookie 多份残留"问题），代码里已有逐个验签兜底，但不能排除你手机上这份残留比较复杂
- 下一步（恢复排查时直接执行）：先让你清一次手机浏览器里这个网站的数据再登录测试，确认是否是残留 cookie 问题
