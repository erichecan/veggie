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
