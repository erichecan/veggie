# DEV-REPORT：批量确认出发 + 22 点自动兜底

完成日期：2026-09-22

> ⚠️ 本次提交时 `DEV-PLAN.md` 已被同一仓库里另一个并发会话（跟进"司机端退换货"需求）覆盖成不相关内容，故本报告不再链接它——本次计划的完整内容见本次对话记录，关键决策已逐条落在下文各节里。

## 给你看的

| 场景 | 来源 | 截图 | 状态 |
|---|---|---|---|
| 配送调度台顶部新增「确认全部出发」按钮，和「批量分配完成」并排 | 你原话（分批次统一确认） | [点击前](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20260922-confirm-departure-bulk-button.png) | 符合 |
| 点击后二次确认弹窗，文案说明「出发后交货日期/客户/司机不可再改，且不可撤销」 | 我推断的（不可逆操作需要防误触） | 弹窗为原生 confirm()，截图无法呈现，文案见下方"技术验收"里的 curl/浏览器操作记录 | 符合 |
| 确认后该日期下所有未出发批次一次性转为「已出发」，按钮消失、toast 提示"已批量确认 N 个批次出发" | 你原话（点一次全部处理） | [点击后](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20260922-confirm-departure-bulk-button-after.png) | 符合 |
| 单个批次原来的「确认出发」按钮继续保留，用于纠正个别例外 | 我推断的 | 见下方说明——此按钮当前在生产环境本就被功能开关隐藏，见"存档用的"一节 | 符合（但有一条重要背景，见下） |
| 22 点自动兜底：忘记手动点的话，系统当晚自动补上 | 你原话 | 无 UI（后台定时任务），验证方式见下方 curl 记录 | 符合 |
| 库存扣减口径：出发这一步不改 qtyOnHand，维持"确认订单时已扣、出发不重复扣" | 你拍板的 | 代码位置 `lib/wave-dispatch.ts` 顶部注释 | 符合 |

访问地址（本地验证用的隔离测试库，不是生产）：`http://localhost:3011/classic/operator/dispatch-console`

## ⚠️ 一条比功能本身更重要的背景，务必先看

调查代码时发现：配送调度台里单个批次的「🚚 确认出发」按钮，**在生产环境目前很可能是隐藏的**——不是因为代码被删，而是因为 2026-07-08 那次改动（commit `e238193`）加了一个功能开关 `DRIVER_APP_ENABLED`（`lib/features.ts`），原因是"司机端 + 拣货 iPad 尚未上线，确认出发在系统里空转"。这个开关默认关闭，我核对了 `cloudbuild.yaml`、`.github/workflows/`、`Dockerfile`，生产部署链路里**从来没有人把它设成 true**。

这应该就是你说"这个功能之前被客户在会上去掉"所指的那次——只是账本上记的是"因为司机端没上线所以先关灯"，不是"删掉"。

**这次新增的「确认全部出发」按钮和 22 点兜底，我特意做成不受这个开关影响**——理由是：出发这个动作现在有了新的真实意义（锁定订单不可再改客户/司机/交货日期），跟司机端上不上线已经没关系了，所以没有必要继续跟着一起关灯。但单个批次原来的按钮我没有动它的开关（保持现状），所以你在生产上会看到：**新的批量按钮会出现，旧的单个按钮除非你把开关打开否则还是不出现**。

如果你希望单个批次的按钮、「在途」徽章、「标记完成」这些也一起复原，需要把环境变量 `NEXT_PUBLIC_DRIVER_APP_ENABLED=true` 加进部署配置并重新构建部署（这个变量是编译时烧进前端包的，改了不重新 build 不生效）——这是一个单独的、影响面更大的决定（会同时带回一堆跟司机端强相关的 UI），我没有擅自做这个决定，等你说要不要。

## 存档用的（你不用看，出问题时我回来查）

### 现状核实

代码走查确认：`app/api/waves/[id]/dispatch/route.ts`（单个批次确认出发的接口）本身完整存在，行为正是用户描述的"回填交货日期、状态转 IN_DELIVERY、波次标记已出发"；出发后改客户/改司机/改交货日期在 `app/api/orders/[id]/route.ts` 里本来就已经被状态机挡住（`IN_DELIVERY` 在 `customerLockedStatuses`/`driverLockedStatuses`/`dateLockedStatuses` 三处都在列），商品行数量的编辑口子保持开放（服务于送货中缺货/退货调整库存差额），本次未改动这一条。

### 技术方案

- 抽出共享核心逻辑 `lib/wave-dispatch.ts::dispatchWave()`，原单批次路由、前端批量按钮（逐个调用同一个 `/api/waves/[id]/dispatch` 接口）、22 点 cron 三处共用同一份事务代码，不写三遍。
- 新增 `POST /api/cron/auto-confirm-departure`，鉴权走 `x-cron-secret`（与 `generate-statements`/`backup-database` 同一套路，不接角色权限），自动被 `route-map.ts` 里已有的 `/api/cron/**` 通配规则和 `public-routes.ts` 的 `/api/cron` 前缀白名单覆盖，**不需要新增任何权限点或白名单登记**。
- 扫描范围是"波次日期 ≤ 今天（都柏林业务日）"而不只是"今天"——新增 `lib/wave-dispatch.ts::businessTodayDateOnly()`，专门给"纯日期"字段（`waveDate` 存的是朴素 UTC 零点）用，不能直接用 `lib/analytics/metrics.ts` 的 `businessTodayStart()`（那个是真实时间戳，夏令时期间会早 1 小时，拿去比较会把"今天"自己的批次也判断成"还没到"）。
- 前端「确认全部出发」按钮完全照抄仓库里已有的「批量分配完成」（`markAllAssignmentDone`）写法：前端对候选波次逐个 `Promise.allSettled` 调用已有的单个接口，不新增批量专用的后端路由——降低新增接口面，权限复用现有的 `dispatch.wave.update`。
- systemd 定时任务：`deploy/droplet/systemd/veggie-auto-dispatch.service` + `.timer`，写法照抄已在跑的 `veggie-backup.service/.timer`（22:00 本地时间，`Persistent=true` 防关机漏跑），复用同一个 `/etc/veggie/backup.env` 里的 `CRON_SECRET`（所有 cron 路由共用同一把密钥，没必要为同一个值再建一份文件）。

### 技术验收

在本机隔离测试库（`veggie_test`，与共享开发库/生产完全隔离）上验证，避免碰共享数据：

```
$ npx tsc --noEmit
（无输出，类型检查通过）
```

核心事务逻辑（`dispatchWave`）直接单测：
```
✅ fixture: order_ie_004 起始状态是 CONFIRMED
✅ 场景A 第一次 dispatchWave 返回 ok:true
✅ 场景A 更新了 1 个订单
✅ 场景A order_ie_004 状态转为 IN_DELIVERY
✅ 场景A order_ie_004 deliveryDate 已回填
✅ 场景A 波次 dispatchedAt 已标记
✅ 场景A 已生成 Trip
✅ 场景A 第二次调用幂等拒绝(不重复出发)
✅ 场景B cron 查询扫到了「过去」的未出发波次
✅ 场景B cron 查询没有扫到「未来」的波次
✅ 场景B 空批次(orderIds=[]) 被过滤掉，不计入 total
```

`/code-review high` 修复后补测的两条（并发竞态 + 扫描下界）：
```
✅ 并发调用两次，只有一次成功
✅ 另一次拿到「已确认出发」而不是也成功一遍
✅ 并发场景下只生成了 1 条 Trip（不是 2 条重复）
✅ 40 天前的波次超出 30 天回溯窗口，未被 cron 候选查询扫到
```

单个批次接口 `PUT /api/waves/[id]/dispatch` 鉴权探针（真实 HTTP + 真实 JWT）：
```
无 token           → 401
错 token           → 401
司机角色(无权限)    → 403
运营角色(有权限)    → 200，返回 dispatchedCount/tripId
同一波次再调一次    → 400 "该批次已确认出发"（幂等）
```

cron 接口 `POST /api/cron/auto-confirm-departure` 探针：
```
无 x-cron-secret    → 401
错 secret           → 401
正确 secret         → 200 {"scannedBusinessDate":"2026-09-23","total":1,"dispatched":1,"skipped":0,"failed":0,...}
再调一次（已无候选）→ 200 {"total":0,"dispatched":0,...}（幂等，不重复处理）
```

浏览器真实点击验证（见上方截图）：登录运营账号 → 配送调度台 → 点击「确认全部出发（2）」→ 二次确认弹窗（accept）→ toast "已批量确认 2 个批次出发" → 数据库回查 `order_ie_002` 状态转 `IN_DELIVERY`、`deliveryDate` 回填、波次 `dispatchedAt` 写入。

`/code-review high` 与 `/security-review` 已按第十一节要求跑过，findings 逐条处理如下：

- **安全审查**：未发现新增高置信度安全问题（新 cron 路由的鉴权写法与仓库里另外两个已有的 cron 路由完全一致，未引入新的注入面或授权绕过）。
- **代码审查找出 3 个真问题，已修复**：
  1. ⛔ 并发竞态：`dispatchWave` 原实现是"先查一次 `dispatchedAt` 再单独 update"，DEV-PLAN 里写"天然幂等防重复"其实不准确——两次并发调用（比如 22 点 cron 撞上运营手动点「确认全部出发」）能同时通过前面的判断，各自生成一条 Trip，导致同一波次重复出发+司机行程翻倍+提成重复计。已改成事务内 `updateMany({where:{dispatchedAt:null}})` 当互斥锁，用数据库行锁保证并发只有一次生效。已用真实并发调用验证：两次同时调用只有一次成功，Trip 只生成 1 条。
  2. cron 扫描范围原来完全没有下界（"waveDate ≤ 今天"，往前可以追溯到任意久远），审查指出：如果生产库里有历史遗留的、一直没处理的老波次，第一次启用这个定时任务时会被一次性当成"刚出发"处理，静默重写很久以前的订单状态。已加 30 天回溯下界（覆盖任何请假/连续假期场景，但不会无限翻旧账），并已用真实数据验证 40 天前的波次不会被扫到。
  3. 确认出发的审计日志（`writeLog` 里的 `detail`）在重构时不小心把原来记录的交货日期具体数值弄丢了，只剩"已回填"这种没有值的说法。已让 `dispatchWave` 把用到的 `deliveryDate` 一并返回，日志和 cron 的 `results[].detail` 都补回具体日期值。
- **代码审查还提了 1 条我核实后确认不是问题，不处理**：审查以为库存扣减实现的是用户"没选中"的方案（认为出发应该真扣库存），但对照 `docs/20260922-confirm-departure-需求原话.md` 和 DEV-PLAN「库存扣减口径」一节——那次追问后我明确把"两段式"落地成"确认时预留（不变）+ 出发不新增扣减动作，只作为审计留痕"这个保守方案，并把这个具体落地方式写进了计划、你也回复"确认"通过了，审查 agent 没有看到这段对话上下文，只看到需求原始引语就判断"实现和选择矛盾"，是误判。
- 另有 1 条是重复实现（`businessTodayDateOnly` 本可以直接复用 `lib/analytics/metrics.ts` 里已经在用的 `toDayKey`），已改成直接调用它，不再自己重新实现一遍时区换算。

### 部署（需要你确认后再执行，涉及生产服务器变更）

新的 cron 定时任务不会自动在生产 droplet 上生效，需要手动安装启用（和当初装备份定时任务是同一套流程）：

```bash
scp deploy/droplet/systemd/veggie-auto-dispatch.service deploy/droplet/systemd/veggie-auto-dispatch.timer dev@167.99.86.19:/tmp/
ssh dev@167.99.86.19
sudo mv /tmp/veggie-auto-dispatch.service /tmp/veggie-auto-dispatch.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now veggie-auto-dispatch.timer
systemctl list-timers veggie-auto-dispatch.timer   # 确认下一次触发时间
```

「确认全部出发」按钮本身随下次正常的应用部署（push main → GitHub Actions）自动上线，不需要额外步骤。

### 已知不可用 / 需要你决定的功能点

- 单个批次原有的「确认出发」按钮、「在途」徽章、「标记完成」按钮：受 `DRIVER_APP_ENABLED` 开关影响，生产环境目前大概率仍是隐藏状态（见上方"一条比功能本身更重要的背景"）。这次新功能不依赖这个开关，但也没有替你决定要不要把它打开。
- 批量确认出发是不可逆操作，目前没有"撤销出发"的功能（前端只做了二次确认弹窗防误触）——这是 DEV-PLAN 阶段就明确不做的范围，如果后续发现需要撤销通道，需要另开一次需求讨论。
- 顺带发现一个跟这次功能无关的既有缺口：`scripts/db/bootstrap-fresh.ts`（私有化部署"从零建库"用的脚本）第 2 步会报错 `relation "ProductTemplate" does not exist`——20260703 那条视图迁移引用了 20260825 商品合表后已经不存在的旧表名，导致全新库无法一次性跑完整个 bootstrap 流程（我为了本次测试跳过了这一步，手动执行了后续步骤）。这个跟本次"确认出发"功能无关，我没有顺手改，记在这里供你决定是否要单独安排修。
