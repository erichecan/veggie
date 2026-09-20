# veggie 部署效果闭环日志 · 2026-09-20

> 每次部署追加一条。代码上线 ≠ 完成，效果被观测到才算完成。
> 会话开头先读本文件，把「待观测且已过窗口」的先跑一遍再开新活。

---

## f0163d6 · 数据中心导航收敛到三项（2026-09-20 14:12 UTC）

**本次改动想达成什么**

客户要求数据中心不再露出 15 个分析页（经营总览 / AI 问数 / 销售统计 / 客户分析 /
毛利分析 / 采购进货分析 / 利润表 / 应收账龄 / 应付账龄 / 采购运营 / 物流分析 /
司机提成 / 内控审计 / 销售分析(reports/sales) / 物流分析（报表））。
只摘导航入口，页面与接口原样保留——这些接口并非各页独占，
reports/sales 在用 /api/analytics/margin、sales-analysis 在用
/api/analytics/driver-commission/day-sales，跟着页面删会打断留下的两个页面。

留下：← 返回销售 / 销售分析(sales-analysis，本次由「销售钻取(月/周/日)」改名) /
采购分析(reports/purchasing) / 数据库备份(按 system.backup.read 显隐)。
/classic/boss 原为「经营总览」，整页搬到 boss/overview，原路由改为重定向到 sales-analysis。

**技术观测（我负责）**

| 项 | 命令 / 证据 | 结果 |
|---|---|---|
| CI | GitHub Actions run 35515460427 @ f0163d6 | success |
| 部署 | Deploy to droplet run 35515460413 @ f0163d6 | success |
| 新镜像已起 | `curl /api/health` → `uptimeSec:46` | 容器已用新镜像重启 |
| 生产可访问 | `/` 与 `/enter` | 200 |
| 鉴权未被破坏 | `/classic/boss*` 未登录 | 307 → /enter |
| 本地实登验证 | Chrome 登录 boss 账号，本地 dev | /classic/boss 落到 sales-analysis；导航恰好 4 条；reports tab 只剩采购分析；boss/overview 与 analytics/margin 直链 200 |

⚠️ 无凭证下生产的 307 对不存在的路径同样返回，**不能**用状态码区分路由是否存在。
生产的导航渲染效果没有被我直接观测到，只能靠「同一份代码在本地实登验证通过 + 两条流水线绿」推断。

**定性观测（用户/客户负责）**

登录 https://www.johnstonebros.ie/classic/boss ，确认：
1. 顶部菜单是不是只剩「← 返回销售 / 销售分析 / 采购分析 / 数据库备份」四项；
2. 点进去直接落到销售分析页，不再是原来的经营总览。

问谁：用户本人（这批页面的去留是他转达客户的要求）。

**状态**：待观测

**遗留**：采购总览页（operator/purchases/overview）的「查看供应商 →」按钮仍指向
已撤下的「采购运营」页（lib/analytics/procurement-overview.ts:322）。页面还在所以不会报错，
但等于绕回一个已要求去掉的页面。属采购模块，未在本次范围内，待用户决定改指向还是去掉按钮。

---

## 采购分析：供应商 × 下单月份，视觉对齐销售分析（927d024 / 740081a）

**本次改动想达成什么**

客户拿现网 Odoo 12 的 Purchase Analysis 截图提要求：时间维度放横向、按月、供应商放左侧、
先只到月，且「新版的交互和展示样式要和 sales analysis 一致」。做在现有的
`boss/reports/purchasing` 上（用户拍板，不新建页），月份列取下单日期。
连带修掉三个「数字是错的但界面看不出来」的既有 bug（详见两条 commit message 与
`docs/20260920-purchase-analysis-pivot-tasks.md`）。

**技术观测（我负责）**

| 项 | 命令 / 证据 | 结果 |
|---|---|---|
| CI | Actions run 35516908861 @ 927d024 | success |
| 部署 | Deploy to droplet run 35516908887 @ 927d024 | success |
| 跑的确实是这次的镜像 | `sudo docker ps` | `veggie-app-1 · Up (healthy) · ghcr.io/erichecan/veggie:927d0244a1…` |
| 生产首页 | `curl https://www.johnstonebros.ie/` | 200 |
| 新页路由存在且鉴权正常 | `curl …/zh/classic/boss/reports/purchasing` | 307 → 登录页 |
| 报表接口鉴权 | `curl …/api/reports/purchasing` | 401 |
| 容器日志 | `sudo docker logs veggie-app-1` | 共 4 行（`✓ Ready`），error/exception 0 |
| 纯净构建 | 隔离 worktree 检出 927d024 + `prisma generate` → `tsc` / `npm run build` | 均通过（排除并发会话未提交改动的干扰） |
| 探针 | `npm run test:reports-pivot`（本机 dev 库） | 24 例 · 22 过 · 0 失败 · 2 未获验证 |
| 币种前提 | 生产库只读查询 | 35 张非取消采购单全 EUR，`subtotalExTaxEur` 与原币零差异 |

⚠️ **日志窗口只有 4 行**（容器刚起、还没有人访问过受登录保护的页面），
所以「error 0」是真实测量但窗口极小，**不能**据此断言生产运行无异常。
容器日志会被每次部署轮换（20260916 记过），后续要看历史得用别的路径。

⚠️ **新页在生产上没有被我直接看到过** —— 它在登录之后，而我没有生产账号。
目前只能靠「同一份代码在本地实登验证通过（中英双语 / 展开 / 度量开关 / 显示更多月 /
空状态 / 首列钉住 / 导出无异常）+ 两条流水线绿 + 镜像 SHA 对上」推断。

**⛔ 生产数据现状（只读探测，影响客户预期）**

| 事实 | 数字 |
|---|---|
| 采购单总数 | 41 张（LOCKED 22 / CANCELLED 6 / DRAFT 5 / RECEIVED 4 / INVOICED 2 / SENT 1 / CONFIRMED 1） |
| 本页口径下最近 6 个月 | 11 家供应商 · 22 个「供应商×月」组合 |
| 按月分布 | 05: 8(计8) · 06: 10(计10) · 07: 12(**计5**) · 08: 2(计1) · 09: 9(**计5**) |
| 对照：销售订单 | 149,930 张 |

即：**采购基本没在新系统里录**。这页打开会比客户的 Odoo 截图（几十家供应商、€111 万）
空得多，那不是功能故障。另外本页默认只计「已确认及之后」，7 月 12 张里只算 5 张。

**定性观测（用户/客户负责）**

登录 https://www.johnstonebros.ie/classic/boss → 采购分析，确认三件事：

1. 版式是不是你要的：供应商在左、月份在上、每月下面金额/数量/均价、最右合计、行前 `+` 能展开到商品；
   跟旁边「销售分析」看起来是不是同一套东西。
2. **均价**这一列：我给的是「金额 ÷ 数量」的加权均价，与 Odoo 的 Average Price（行单价算术平均）
   数字不同。能不能接受？不能的话改回算术平均，但合计格只能留空。
3. **只计已确认及之后的采购单**这个默认口径对不对？要不要把询价单（DRAFT/SENT）也算进来？

问谁：用户本人（需求由他转达客户）。

**状态**：待观测

**遗留**
- 生产上没有可供我登录的账号，新页的真实渲染与数据未经我直接验证。
- `components/reporting/export-excel.ts` 的修复只验到「不抛异常 + 屏幕上同源逻辑正确」，
  下载下来的 .xlsx 内容没有被打开核对过。
- code-review 第 9 条（商品下拉一次拉全量目录，`analytics-shared.tsx`）未处理，
  属既有问题且共享组件被另一会话占用中。
