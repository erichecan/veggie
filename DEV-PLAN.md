# DEV-PLAN — 配送调度台：已出发波次可被静默掏空的数据安全漏洞

> 生成日期：2026-07-09
> 类型：大改（BIG change）—— 触达 5 个文件的写路径校验补齐（非 schema 变更）
> 状态：✅ 已完成——用户追加要求"彻底修复 + 删除不可恢复的历史脏数据"后，第 2 节的范围收窄已废止，
>   实际执行了必须项 + 状态展示诚实化 + 历史脏数据删除，见第 7 节「彻底修复追加记录」
> 旧计划（数据分析中心）已归档至 `docs/20260703-dev-plan-analytics-center.md`

---

## 0. 依据

本计划基于本会话内对 `该批次已出发，不能再分配` 报错的根因排查结论：

- `app/[locale]/classic/operator/dispatch-console/_components/BatchTab.tsx`
- `app/api/waves/[id]/{assign,unassign}/route.ts`
- `lib/wave-assign.ts`
- `lib/wave-pick-lock.ts`（已有的同类闸门实现，作为本次新增闸门的参照范式）
- `lib/features.ts`（`DRIVER_APP_ENABLED` 开关语义）
- 生产库实查：`2026-07-03` 排车中 YIWEI / hanhua / ANDRIUS 三个波次，`dispatchedAt`/`completedAt` 均已写入，但 `orderIds` 现为空数组；`ActionLog` 显示 ANDRIUS 波次在 **2026-07-09（今天）** 被两次"从波次移除订单"，证实是关灯期 UI 把已完成波次伪装成空闲待分配车后被手工拖空。

---

## 1. 问题一句话

调度台/API 里能把订单从波次移出或转移的四条写路径，只校验了"拣货锁"（`pickLockedAt`），从未校验"已出发"（`dispatchedAt`）；同时前端渲染层把"已出发"的视觉提示（徽章/灰卡/禁拖）整体挂在 `DRIVER_APP_ENABLED`（当前=false，司机端关灯期）开关下，导致真实已出发/已完成的波次在关灯期被画成普通空闲待分配车——看着能拖，一拖就破坏数据。

---

## 2. 范围确认（仅"必须项"，不含以下内容）

**本次修，不做的事（需要你后续单独拍板）：**
- ❌ 不恢复"在途"徽章/灰色完成卡片在关灯期的显示（那是产品有意做的简化，改不改要你决定）
- ❌ 不清理 `wave.status` 死字段（历史遗留，不影响本次修复的正确性）
- ❌ 不修复/找回 7/3 那 3 个波次已经丢失的订单归属（数据已不可靠地还原，见第 5 节的诊断脚本，只读上报范围，不做写回）
- ❌ 不改 `removeOrderFromAllWaves`（`lib/wave-assign.ts`）—— 它被订单"撤回报价单/取消"复用，`IN_DELIVERY → CANCELLED` 是状态机允许的合法流转（`app/api/orders/[id]/route.ts:29`），已发车后取消订单、把它从波次摘出去是**正确行为**，不能在这里加"已出发拒绝"，否则会把合法的取消流程堵死。

---

## 3. 架构 / 质量 /性能评估（大改必答）

- **架构**：新增一个与 `assertWaveNotPickLocked` 同构的 `assertWaveNotDispatched` 闸门（新文件 `lib/wave-dispatch-lock.ts`），复用现有"antiquated error class → 路由 catch 转 409"的既有范式（`WavePickLockedError` 同款），不引入新模式，边界清晰。
- **质量**：四处遗漏点是重复实现（`assign`/`unassign`/`wave-assign.ts` 里 zone 构建代码本身就复制了 3 份）导致校验被漏加一次以上；本次不做大重构（DRY 收敛留作后续可选项），但新增的闸门以单一函数复用到全部 4 个调用点，保证不再出现"漏第 5 处"的情况。
- **性能**：新增校验是按 `waveId` 单行 `findUnique`，与既有 `assertWaveNotPickLocked` 同等开销，多数调用点复用同一次已查到的 wave 对象即可，无需额外查询（见下方实现细节）。

---

## 4. 改动清单

### 4.1 新增 `lib/wave-dispatch-lock.ts`
仿照 `wave-pick-lock.ts`：`WaveDispatchedError` + `assertWaveNotDispatched(waveId)`（`dispatchedAt` 非空即抛错，message = `该批次已出发，不能再分配`）。

### 4.2 `app/api/waves/[id]/unassign/route.ts`
`assertWaveNotPickLocked(id)` 之后追加 `assertWaveNotDispatched(id)`；catch 块增加 `WaveDispatchedError → 409`。
（该端点只被调度台拖拽调用，属于人工调度操作，发车后必须整体锁死，不存在"合法取消"的例外场景。）

### 4.3 `app/api/waves/[id]/assign/route.ts`
- 目标波次 `id` 本身：`assertWaveNotPickLocked(id)` 之后追加 `assertWaveNotDispatched(id)`（现状：目标波次是否已出发**完全未校验**，前端 `dropToWave` 的拦截是唯一防线，直连 API 可绕过）。
- `otherWaves` 循环里（把同一订单从别的波次"顺手摘除"那段）：`assertWaveNotPickLocked(ow.id)` 之后追加 `assertWaveNotDispatched(ow.id)`。
- catch 块复用同一个 `WaveDispatchedError → 409`。

### 4.4 `lib/wave-assign.ts` → `assignOrderToWave`
`otherWaves` 循环里同样追加 `assertWaveNotDispatched(ow.id)`（防御性：正常业务下这条不会触发，因为 `orders/[id]/route.ts:119-132` 已在更上层拦住已出发订单改派司机；加在这里是保持 assign 侧两个入口口径一致，避免以后再长出一个漏判点）。
`removeOrderFromAllWaves` **不改**（原因见第 2 节）。

### 4.5 `BatchTab.tsx`（前端，数据安全 + 交互反馈）
- `dropToLeft`：在现有 `pickLockedAt` 检查旁，追加 `waves.find(w => w.id === src)?.dispatchedAt` 检查 → toast `该批次已出发，不能移出` + return。
- `dropToWave`：`src` 侧追加同样的 `dispatchedAt` 检查（目前只查了目标 `waveId` 的 dispatchedAt，没查来源 `src` 的）。
- `draggable` / `onDragStart`（订单卡片）：改用不受 `DRIVER_APP_ENABLED` 影响的真实判断 `!!wave.dispatchedAt`（而不是当前被开关阉割的 `dispatched` 变量），从源头上禁止拖动已出发波次里的订单——即使处于关灯期。
- 空车占位文案：`laneOrders.length === 0` 且 `wave.dispatchedAt` 为真时，"拖订单到此"改为"🚚 已出发（无订单）"，不再邀请用户往一个实际已发车的空槽里丢单。
- 上述改动均只影响"能不能拖 / 提示文案"，**不改动**徽章、灰色完成卡片、`待理货` 状态文字的现有关灯期表现（第 2 节已声明不在本次范围）。

### 4.6 只读诊断脚本 `scripts/diagnose-dispatched-wave-orphans.ts`
扫描全库 `pickingWave.dispatchedAt != null` 且 `orderIds = []` 的波次，列出日期/司机/dispatchedAt，用于确认这类"已出发但被掏空"的历史脏数据除已知的 3 条外还有多少条。纯只读，不接 `--fix`（第 2 节已声明不做数据找回，找回没有可靠依据）。

---

## 5. 验证计划

- 手工复现：本地/预发环境把某个波次走一遍"分配→确认出发"，再尝试从调度台拖出/拖入该波次的订单 → 应立即被拦截并弹出提示，网络面板确认后端返回 409（不是前端假装拦截）。
- `curl` 直连 `PUT /api/waves/[id]/unassign`、`PUT /api/waves/[id]/assign` 对一个已出发波次发起请求（绕开前端）→ 应返回 409，而不是 200。
- 跑 `scripts/diagnose-dispatched-wave-orphans.ts`，记录当前全库范围内的历史脏数据条数，写进完成报告。
- 确认 `IN_DELIVERY → CANCELLED` 取消流程未被误伤：找一个已出发波次里的订单，走"取消订单"，确认订单被正常从波次移出（因为 4.4 明确没碰 `removeOrderFromAllWaves`）。

---

## 6. 已知限制（如实记录，不隐瞒）

- 7/3 那 3 个波次已经丢失的订单归属**无法通过本次修复找回**——它们当时被拖出后去了哪（退回待分配池，还是转给了别的司机）已经不可追溯（`unassign`/`assign` 的操作日志只记录"移除数量"，不记录具体订单号）。如果业务上需要核实这批订单当天究竟送没送，需要另外人工核对，不在本次代码修复范围内。
- `hanhua`/`YIWEI` 两个波次的订单归零，在 ActionLog 里找不到任何对应的"移除"记录（`unassign`/`assign` 均无痕迹，`removeOrderFromAllWaves` 也没有对应的取消/撤回记录）——说明它们是通过本次排查未能定位的路径清空的（不排除是直接数据库操作/历史脚本），本次修复堵住了目前代码里能找到的全部空子，但不能 100% 排除还有未知路径，建议后续如再复现同类现象及时反馈。

---

## 7. 彻底修复追加记录（2026-07-09，用户明确要求后执行）

用户在验证过第 1-6 节的最小修复后明确要求"彻底修复"+"历史数据无法找回就直接删除"。以下是在原计划之外追加执行的内容：

### 7.1 状态展示诚实化（原第 2 节里被列为"不做"的关灯期视觉项，现已实现，但刻意保持范围最小）
`BatchTab.tsx` 新增 `realLabel`（不受 `DRIVER_APP_ENABLED` 影响，直接读 `wave.dispatchedAt`/`completedAt`）：
- 状态徽章（展开态 + 收起态）：`dispatched`/`assignmentDone` 都不命中时，不再兜底到 `wave.status` 撑出的假"待理货"，改显示 `🚚 已出发` / `✅ 已完成`。
- 进度条：真实已出发/已完成时强制 100%，不再按 `wave.status` 对应的假进度百分比显示。
- 出发时间行：从"仅 `dispatched`(关灯期恒 false)才显示"改为"真实 `dispatchedAt` 存在就显示"。
- "✅ 分配完成"按钮：真实已出发的车不再显示这个按钮（后端 `assignment-done` 路由本来就会拒绝已出发波次的这个操作并返回 400，之前前端会展示一个注定失败的按钮）。

**刻意没动的部分**：`wave.completedAt && DRIVER_APP_ENABLED` 那个"完成态整卡收缩成灰色 stub"的判断（第 305 行附近）保持不变——这是为了不引入"角标数量 > 卡片里看到的订单数"的新错配（代码注释里原有的权衡，历史设计决策，参见第 4.5 节），不属于本次要修的 bug 范畴，改了反而可能制造新的困惑。

### 7.2 历史脏数据：核实安全后直接删除
新增只读诊断脚本 `scripts/diagnose-dispatched-wave-orphans.ts` 摸底，全库扫描后发现（比最初报告的 3 个多）**12 个**"已出发但 orderIds 为空"的历史波次，最早可追溯到 2026-06-23。

删除前核实了关联影响：
- `Pallet.waveId` 是真外键且 `onDelete: Cascade`——扫描到这 12 个波次共关联 **0 条** Pallet，删除不会级联丢失托盘数据。
- `Trip.waveId` 只是普通字符串字段（非外键）——**7 条** Trip 会失去 `waveId` 关联，但 Trip 自身的司机/佣金/餐馆快照数据（发车时已独立快照进 Trip 表）完全不受影响。

确认安全后，用 `scripts/cleanup-dispatched-wave-orphans.ts --apply` 删除了全部 12 条波次记录。删除后重跑诊断脚本确认：命中数 = 0。

### 7.3 验证
- `npx tsc --noEmit`、`eslint` 均通过（仅剩与本次改动无关的 3 条历史 warning）。
- `curl` 复测 `/api/waves?date=2026-07-03`：返回 200，被删的 3 个波次不再出现，其余波次数据未受影响。
- 生产/本地共享的开发数据库上执行了实际删除操作（非本地隔离环境），已在对话中向用户报告。
