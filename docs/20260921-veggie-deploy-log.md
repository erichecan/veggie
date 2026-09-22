# veggie 部署效果闭环日志 · 2026-09-21

## 数据中心恢复4个分析入口，AI问数按权限位显隐（2026-09-21）

**本次改动想达成什么**

20260920 客户要求先把数据中心导航精简到只剩几项，同一天用户又要求把其中
AI 问数 / 毛利分析 / 利润表 / 司机提成 这 4 项加回来（原话未在本次会话中留存，
沿用上一轮会话遗留的未提交改动，本次只是补上提交与部署）。

AI 问数比较特殊：其权限位 `analytics.chat.read` 没有像其它 `analytics.*`
权限那样普发给 operator（`lib/rbac/sortkeys.json` / `route-map.ts` 可查），
只发给部分账号，所以没有像另外 3 项一样直接写死进 `LINKS`，而是按
`decodePermissions(user.pm).has('analytics.chat.read')` 动态显隐，避免无权限
用户点进去撞 403。其余 3 项直接恢复为固定入口。

**技术观测（我负责）**

| 项 | 结果 |
|---|---|
| tsc --noEmit | ✅ 0 错 |
| GitHub Actions CI | ✅ 绿（run 35559529655） |
| GitHub Actions Deploy to droplet | ✅ 绿，6m3s（run 35559529651），Build & push app/migrator image、Deploy 均成功 |
| 生产首页 | ✅ `curl https://www.johnstonebros.ie/` → 200 |
| 生产路由探针（未登录） | ✅ `/classic/boss`、`/classic/boss/analytics/margin`、`/classic/boss/analytics/income-statement`、`/classic/boss/analytics/driver-commission`、`/classic/boss/analytics/chat` 全部 307 跳登录，非 404/500 |
| 提交 | `f9ee61f feat(boss): 数据中心恢复4个分析入口，AI问数按权限位显隐` |

⛔ **我没能验证的**：生产上没有可供我登录的账号，4 个入口是否在导航里正确出现、
AI 问数是否只对有权限的账号显示，未经我肉眼确认，只验到路由层不 404/500。

**定性观测（用户/客户负责）**

登录 https://www.johnstonebros.ie/classic/boss ，确认：
1. 数据中心导航里出现「AI 问数 / 毛利分析 / 利润表 / 司机提成」4 个新入口
2. 用一个没有 AI 问数权限的账号登录，确认导航里看不到「AI 问数」这一项（不是看到了报403）

问谁：用户本人。

**状态**：待观测

---

## 销售/采购分析加宽消除横向滚动，钻取视图补单价列与任意时间段（2026-09-21）

**本次改动想达成什么**

客户发来两张截图批注：(1) 销售分析、采购分析两页的表格要横向滚动才能看全，
主要诉求是不想要横向滚动；(2) 钻取视图右侧维度展开面板缺一列单价；
(3) 钻取视图只能"从今天往回滚 N 周/月"，客户想看任意指定的时间段。
第三点原本判断要重写分桶逻辑成本较高，实查后端 `/api/analytics/margin`
本来就接受任意 from/to（按 `date_trunc` 分桶，不要求对齐周一/月初），
于是改成加两个可选的起止日期输入，成本比最初评估的低很多。

**技术观测（我负责）**

| 项 | 结果 |
|---|---|
| tsc --noEmit | ✅ 0 错 |
| 本地浏览器实测（boss@demo.local，1780×900） | ✅ 加宽后两张表无横向滚动；右侧维度面板新增"单价"列正常显示数值；自定义起止日期（2026-06-01→2026-09-21）正确拉出第25~33周数据，✕ 清除按钮正确恢复默认滚动窗口 |
| GitHub Actions Deploy to droplet | ✅ 绿，6m56s（run 35683844772） |
| 生产容器状态 | ✅ `veggie-app-1` 部署后健康（Up, healthy），启动时间与本次部署时间吻合 |
| 生产容器日志 | ✅ 部署后 80 行日志无 error/exception/fatal |
| 生产路由探针（未登录） | ✅ `/classic/boss/sales-analysis`、`/classic/boss/reports/purchasing` 均 307 跳 `/enter`，非 404/500 |
| 提交 | `af959be fix(boss): 销售/采购分析加宽消除横向滚动，钻取视图补单价列与任意时间段` |

⛔ **我没能验证的**：生产上没有可供我登录的账号，加宽/单价列/自定义时间段
这三点在生产真实数据下的渲染效果未经肉眼确认，只验到路由层不 404/500 +
容器健康 + 本地用相同代码在浏览器里跑通。

**定性观测（用户/客户负责）**

登录 https://www.johnstonebros.ie/classic/boss/sales-analysis 确认：
1. 页面里两张表（左侧钻取表、右侧维度面板）不需要横向滚动就能看全
2. 右侧维度面板里能看到"单价"这一列，数值合理
3. 顶部工具栏"客户"筛选右边有两个日期框，选一段过去的时间段（比如半年前）
   能正确显示那段时间的数据；点 ✕ 能恢复成默认的"最近几周"

再登录 https://www.johnstonebros.ie/classic/boss/reports/purchasing 确认表格也不需要横向滚动。

问谁：用户本人，或转给提反馈的客户。

**状态**：待观测
