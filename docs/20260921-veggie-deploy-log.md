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
