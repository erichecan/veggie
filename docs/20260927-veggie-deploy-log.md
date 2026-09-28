# veggie 部署效果闭环日志 · 2026-09-27

## 修复商品列表「Last Updated on」日期区间筛选点击日期无反应（2026-09-27 开发+部署，1 次提交）

**本次改动想达成什么**

用户反馈：商品模块点击「Last Updated on」列的日历图标能弹出日历，但点日历里任意一天没有反应。根因：`OdooTable.tsx` 里判断「点在筛选弹层外面就收起」的 mousedown 监听用 `ref.contains(e.target)`，但 From/To 各自的日历（`DatePicker` → base-ui `Popover`）经 Portal 挂到 `document.body` 末尾，不是该 ref 的 DOM 子节点；点日历任意一天时先被误判为"点了外面"，把整个筛选弹层连日历一起卸载，日历的 `onSelect` 从未跑到。修复：外部点击判断里放行 `[data-slot="popover-content"]` 的 Portal 内容。

顺带用户要求排查全项目是否有类似问题——扫了全部 20 处「手写 document 级点击监听 + ref.contains() 判断」的代码，逐一核对是否嵌了走 Portal 的内容，确认只有这一处受影响，其余要么没嵌 Portal 组件，要么已有 portal-aware 处理（`portalRef`/`panelRef` 显式挂在 Portal 节点上，或用 `mousedown`+`preventDefault` 时序规避）。未发现需要一并修的地方。

**技术观测（我负责）**

| 项 | 结果 |
|---|---|
| npx tsc --noEmit | ✅ 0 错 |
| 浏览器实测（本地 dev，本地种子管理员账号登录） | ✅ 修复前复现：点日期后整个筛选弹层消失、From 输入框未写入值；修复后：点日期后 From 输入框正确写入 `15/09/2026`，弹层保持打开 |
| dev server 请求日志 | ✅ 选中日期后能看到 `GET /api/products?cf_updatedAt_from=2026-09-15&...` 200，筛选参数真正传到了后端 |
| 全项目同类模式排查 | ✅ 20 处手写外部点击监听逐一核对，仅 `OdooTable.tsx` 一处受影响且已修 |
| GitHub Actions Deploy to droplet (`7014192`) | ✅ 6m4s 全绿 |
| 生产容器状态 | ✅ `docker ps` 确认镜像 tag `7014192deac9b73cd05f438330d00bafb4496ea4` 与提交 SHA 一致、`Up About a minute (healthy)` |
| 生产首页存活 | ✅ `curl https://www.johnstonebros.ie/` 200 |
| 提交 | `7014192 fix(products): 修复日期区间筛选点击日期没反应的问题` |

**定性观测（用户/客户负责）**

请用户在生产上实际打开商品列表 → 点「Last Updated on」列日历图标 → 点选一个日期，确认筛选生效且不再有"点了没反应"的感觉。因为登录生产需要真实客户账号，本次未替用户在生产端登录复现，只在服务器侧核实了新代码确实已跑起来（容器镜像 SHA 比对）+ 本地环境完整复现问题与修复。

**状态**：技术侧已达成（本地复现+修复验证+生产部署核实）；定性侧待用户在生产上过一遍确认
