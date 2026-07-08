# 报价单/销售单列表页 — 分面搜索 + 快捷筛选（计划）

> 日期：2026-07-07 ｜ 需求来源：客户截图（Odoo Sales 列表页）

## 目标
在 quotations、orders 两个列表页复刻 Odoo 搜索/筛选体验：
1. **My Quotations / My Sales Order** — 只看「我负责的业务员」的单（`salesUserId = 当前登录用户`）。
2. **时间快捷** — Today / Yesterday / This Week / Last Week（可扩展）。
3. **分面聚焦搜索** — 输入关键词→弹下拉→选维度生成 facet chip，多个 facet 可叠加（AND）。维度：单号 / 客户 / 销售 / 产品 / 司机。
4. **每列单独搜索** — 两页已有列筛选行，补齐缺列即可（非新功能）。

## 已定决策（用户确认）
- 聚焦交互：**完整复刻 Odoo 分面**（输入→下拉→chip，可叠加）。
- 聚焦维度：单号 / 客户 / 销售 / 产品 / 司机（全部）。
- "我的"：我负责的业务员（`salesUserId = 当前用户`）。

## 现状
- orders 页：`useServerList` 服务端分页；`/api/orders` 已支持 `salesUserId`、`dateField+fromDate/toDate`、`categoryId`、`search`(客户名/单号)。
- quotations 页：全量加载 `status=PENDING,CANCELLED` + 客户端过滤。
- 当前用户：`getSession()` → `{ userId, name, roles }`。

## 后端改动（`/api/orders` GET，向后兼容）
新增分面参数，彼此 AND，可与 `search` 共存：
`f_code`→code contains；`f_customer`→restaurantName contains；`f_salesman`→salesUser.name contains；
`f_product`→lines.some.productName contains；`f_driver`→driverSlot.driverName contains。

## 前端
- 新增可复用组件 `FacetSearchBar`（分面输入 + chip 管理），接进 `OdooControlPanel` 搜索槽。
- Filters 下拉新增 My / Today / Yesterday / This Week / Last Week。
- facet + 时间 + My 统一拼进 query。

## 分期（均已完成 ✅ 2026-07-07）
- **阶段 1 ✅**：后端分面参数 + 销售单页（orders）完整落地。已 curl + 浏览器验证。
- **阶段 2 ✅**：报价单页（quotations）。桥接策略落地：单号/客户/销售/司机走客户端（司机用 orderDriverMap），仅**产品**维度走服务端 `f_product` 拿 id 集合与客户端数据取交集；My/时间快捷也客户端（对象含 salesUserId/createdAt）。未重构现有批量/内联编辑。

## 验证结论
- 销售单页：客户 Kitchen 113→5、产品 Gyoza 15、销售 Li 13、司机 BAO 13/john 3(不分大小写)、客户+ThisWeek(AND)→1、My 带 salesUserId。
- 报价单页：客户 Wok→1、销售 Jiang→3、产品 Udon→1(服务端桥接)、Jiang+Wok(AND)→1、ThisWeek→1(07-06 那张)。司机在 PENDING 报价单为空属正常(未派车)。
- `tsc --noEmit` 0 错误；服务端日志 0 错误；lint 无新增告警。

## 风险
1. quotations 客户端 vs orders 服务端架构不一致 → 阶段 2 用「服务端 id 交集」桥接。
2. 分面 chip 与现有 activeFilter/列筛选/收藏状态叠加，需理清序列化。
3. 产品聚焦走 `lines.some` 关联查询，注意性能，先跑通再看。
