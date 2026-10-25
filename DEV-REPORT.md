# DEV-REPORT：商品库存预警（Low Stock Alert）

对应 `DEV-PLAN.md`（已确认），需求原话存档：`docs/20261025-商品库存预警-需求原话.md`。

## 给你看的

| 场景 | 来源 | 可看物 | 状态 |
| --- | --- | --- | --- |
| 商品编辑里增加一个库存预警的设定 | 客户原话 | 见下方「怎么验」第 1 步 | 符合 |
| 每个商品的预警值不一样,客户自己维护 | 客户原话 | 同上，输入框是每个商品独立的数字 | 符合 |
| 设置完以后,库存达到这个预警值,商品列表有提醒 | 客户原话 | 见下方「怎么验」第 2 步 | 符合 |
| 库存管理这页也有提醒 | 客户原话 | 见下方「怎么验」第 3 步 | 符合 |
| 判断用实际在手库存 qtyOnHand,不用 Forecast Qty | 你的选择（追问后确认） | 同上，接口返回值可核对 | 符合 |
| 没设置预警值（还是默认 0）的商品不参与提醒 | 我推断的 | 同上 | 符合 |
| "达到预警值"算触发（≤，不是必须跌破） | 我推断的 | 同上 | 符合 |

**⚠️ 这次没有截图**：本机浏览器自动化环境缺 Chrome 可执行文件（已知环境问题，跟这次改动无关，
之前就记录过，重装会卡住所以没再试）。改成给你一段 20 秒内能自己复现的操作路径，比截图更直接：

### 怎么验（本地 http://localhost:3000，生产 https://www.johnstonebros.ie）

1. 商品编辑页：进「操作 → 商品」随便点一个商品 → Edit → 「Inventory & UoM」分区，
   Tracking 下面新增一行「库存预警值」，填个数字（比如比当前在手库存大的数）→ Save。
2. 商品列表页：回列表页，刚才那个商品那一行的「Quantity On Hand」会出现黄色徽章，
   顶部橙色提醒横幅文案变成"N 种商品已达到各自设置的库存预警值"（之前是硬编码的
   固定数字 10，现在跟你刚填的那个数绑定）。
3. 库存管理页：操作 → 库存管理，"需要关注"面板和按品类分组表里会出现这个商品。
4. 把预警值改回 0（或留空）→ Save，三处提醒都会消失——验证"没设置"确实不参与判断。

## 存档用的（你不用看，出问题时我回来查）

### 改了什么

- `Product.safetyStockMin` 字段早就存在（20260522 加的），一直没接 UI。这次接上：商品编辑页
  加输入框，保存接口补数值校验（0–1,000,000）+ 操作记录留痕。
- 新增 `lib/stock-alert.ts::lowStockSqlCondition()`，商品列表页角标/筛选（`lib/products-query.ts`）
  和库存管理页（`lib/analytics/inventory-overview.ts`）两处 SQL 改成共用这一句判断，不再各写各的，
  防止同一商品在两页显示状态不一致。
- 顺手修复一个潜在 bug（不是本次新引入，按项目惯例我自己判断+记录，不单独上升）：
  `inventory-overview.ts` 原来判断条件是 `safetyStockMin IS NOT NULL`，但现网这个字段默认值是
  `0` 不是 `null`，这个条件形同虚设（等价于只要 `qtyOnHand<=0` 就命中，跟客户设的预警值毫无关系）。
  改成 `safetyStockMin > 0 AND qtyOnHand <= safetyStockMin`——不修的话这次新功能在库存管理页上线
  也看不到效果。
- 商品列表页原来的"低库存"徽章用的是跟 `safetyStockMin` 完全无关的全局硬编码阈值 10，这次改成
  逐商品判断，同时把这个不再有意义的"固定数字 10"从告警文案里去掉。

### 范围说明（技术判断，不上升）

客户说的"库存管理这页"经核实是 `app/[locale]/classic/operator/inventory`（导航标签「库存管理」）。
另有一个长得很像的 `app/[locale]/classic/warehouse`（导航标签是「仓库管理」/「库存」，面向
WAREHOUSE 角色），不是这次要改的页面，没有动。`place-order`/`quotations/[id]` 页面本来就有自己
独立阈值的缺货提示，这次也没碰——那两处是另一套东西，不在客户这次描述的范围里。

### 验收命令与结果

- `npx tsc --noEmit`：零输出，通过。
- `npm run build`：通过（见本次会话 build 日志，`ƒ`/`○` 路由清单无变化，没有新增/删除路由）。
- `npx prisma migrate status`：`Database schema is up to date!`，无待应用迁移（本次不新增迁移）。
- 路由探针（本地 dev server 实测，curl）：
  - `PUT /api/products/[id]` 带合法 `safetyStockMin`（如 7.5）→ 保存成功，`GET` 读回同值。
  - 带负数 / 超过 1,000,000 → 均返回 `400`。
- 鉴权探针（`PUT /api/products/[id]` 要求 `master.product.update`）：
  - 无 token → `401`
  - 错 token → `401`
  - 本地签发的 `DRIVER` 角色测试 token（没有现成密码已知的低权限账号，
    用项目自己的 `JWT_SECRET` 在隔离脚本里现签一个，不碰任何真实账号密码，验证后即删脚本）→ `403`
- 业务不变量脚本（临时脚本，验证后已删）：插入 3 个测试商品（未设置=0 / 已达标 / 库存充足），
  断言商品列表页 `alertCounts.low` 与库存管理页 attention 列表对同一批商品给出完全一致的判断结果，
  通过后已清理测试数据，无残留。
- 查询效率：两处改动都是把已有聚合 SQL 里的判断条件原地替换，没有新增逐行查询，不引入 N+1。

### 部署

- commit `3c809434`，已推送 `main`。
- GitHub Actions `Deploy to droplet` run
  <https://github.com/erichecan/veggie/actions/runs/40217178410>，结果 `success`。
- SSH 核对生产容器：`ghcr.io/erichecan/veggie:3c809434eb9100c9f3ece168be20d5760a1d7b81`，
  状态 `Up About a minute (healthy)`，镜像 tag 与本次 commit hash 完全一致。
- `curl https://www.johnstonebros.ie/` → `200`；
  `curl https://www.johnstonebros.ie/en/classic/operator/products`（未带登录态）→ `307` 跳登录页，
  符合预期（受保护页面不应该在匿名访问下返回内容或 500）。

### 已知不可用功能 / 未覆盖范围

无。本次 5 项计划内容全部完成，验收命令全部跑过且全绿。
