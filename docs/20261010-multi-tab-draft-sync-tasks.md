# 任务台账：多 tab 协作不丢数（M1 焦点刷新 44 页 / M2 草稿自动保存 14 页）

依据：`DEV-PLAN.md`（2026-10-10 确认版，附录 B 为页面清单）。
这是进度唯一真相，每个周期开始先读这份，不凭记忆。

## U0 基础设施（必须先做，其余单元都依赖它）

- [x] U0 共享 hook + 草稿恢复 UI + 单测
      验收命令：`node --test --import=tsx tests/use-refetch-on-focus.test.ts tests/use-draft-autosave.test.ts && npx tsc --noEmit`（项目无 vitest，统一用 node:test，测试文件放 tests/ 不与 lib/hooks 同目录，纯逻辑函数注入 storage 不依赖 jsdom）
      可看物：`preview/20261010-draft-restore-banner.html`（本机沙箱里 Chrome/Playwright 浏览器都不可用，无法自动截图，改成一份直接搬 DraftRestoreBanner.tsx 真实 className 的静态预览页，用你自己的浏览器打开看效果；不是另画的示意图）
      定性状态：待你确认（条状提示长相对不对，对了才接数据）
      证据：单测 12/12 通过（shouldRefetch 4 条 + draft 读写/过期/清除 8 条），`npx tsc --noEmit` 无输出（通过）；`npm run test` 全量跑了一遍，960 条里有 8 条失败但都在 rbac-gate/role-reachability/pricing-override 等文件里，跟本次新增的 4 个文件无关（git status 确认改动范围只有这 4 个新文件），是改动前就存在的问题，不在本任务范围内
      依赖：无
      内容：`lib/hooks/use-refetch-on-focus.ts`、`lib/hooks/use-draft-autosave.ts`、`components/shared/DraftRestoreBanner.tsx`、`tests/use-refetch-on-focus.test.ts`、`tests/use-draft-autosave.test.ts`

## U1 订单/报价单组（5 页，含 3 个 M2）

- [x] orders/[id]（M1+M2，已有重复代码改用共享hook）
- [x] orders/page（M1）
- [x] quotations/[id]（M1+M2，已有重复代码改用共享hook）
- [x] quotations/page（M1）
- [x] place-order（M1+M2，已有重复代码改用共享hook）
      验收命令：`npx tsc --noEmit`（5 文件合并跑，无输出）+ `npm run build`（exit 0，日志 /tmp/build-u1.log 无 error）+ `npm run test`（本机沙箱无可用浏览器，跑不了 e2e/playwright，改用现有 node:test 全量回归）
      可看物：本机沙箱 Chrome/Playwright 浏览器不可用，无法截图/录屏；条状提示复用 U0 已确认的 `DraftRestoreBanner`（同一个组件，没有新样式），实际刷新/草稿行为只能靠你自己打开 5 个页面点一遍验证
      定性状态：待你确认（尤其是：切 tab 回来价格表/待处理需求有没有真的刷新；编辑到一半切走回来有没有弹出草稿恢复条）
      证据：tsc 对 5 个文件合并检查无输出；build exit code 0；`npm run test` 960 条里 950 通过、8 条失败，8 条都在 role-reachability/rbac-gate/pricing-override 相关文件（跟 `/api/auth/register` 匿名可达有关），U0 验收时已记录为改动前就存在、跟本次 5 个文件无关；`git status --short` 确认本次改动精确落在这 5 个文件，无误带改动
      依赖：U0

## U2 采购组（9 页，含 3 个 M2）

- [x] purchases/[id]（M1+M2）
- [x] purchases/new（M1+M2）
- [x] purchases/page（M1）
- [x] purchases/suggestions（M1）
- [x] purchases/vendors/[id]（M2 only，见下方说明）
- [x] purchases/vendors/page（M1）
- [x] purchases/catalog（M1）
- [x] purchases/annual-plan（M1）
- [x] purchases/fresh（M1）
      验收命令：`npx tsc --noEmit`（9 文件合并跑，无输出）+ `npm run build`（exit 0，日志 /tmp/build-u2.log 无 error）；本机沙箱无可用 Chrome/Playwright 二进制，原定的 playwright e2e 命令跑不了，改成这两条
      可看物：本机沙箱 Chrome/Playwright 不可用，无法截图/录屏；条状提示复用 U0 已确认的 `DraftRestoreBanner`（同一个组件，没有新样式），实际刷新/草稿行为只能靠你自己打开 9 个页面点一遍验证
      定性状态：待你确认（尤其是：切 tab 回来采购单/建议列表/供应商列表有没有真的刷新；编辑到一半切走回来有没有弹出草稿恢复条；新建采购单/新建供应商刷新页面后草稿还找得到）
      证据：tsc 对 9 个文件合并检查无输出；build exit code 0；`git status --short` 确认本次改动精确落在这 9 个文件（另有 DEV-PLAN.md 本身的改动 + U0 遗留的未提交文件，均不属于本次改动范围）。偏离说明：purchases/vendors/[id] 整张表单本来就是"打开即编辑"无独立查看态，且唯一的 apiGet 是正在编辑的供应商记录本身（没有另外的参考数据列表可刷），强行接 useRefetchOnFocus 会在用户编辑中途被刷新覆盖表单——故只接了 M2（草稿自动保存+新建走 draftId-in-URL），未接 M1，详见该文件内注释
      依赖：U0

## U3 价格表/商品/客户组（7 页，含 3 个 M2）

- [x] pricelists/[id]（M1+M2）
- [x] pricelists/page（M1）
- [x] products/[id]（M1+M2）
- [x] products/page（M1）
- [x] products/by-sale-unit（M1）
- [x] customers/[id]（M1+M2）
- [x] customers/page（M1）
      验收命令：`npx tsc --noEmit`（7 文件合并跑，无输出）+ `npm run build`（exit 0，日志 /tmp/build-u3.log 无 error）；本机沙箱无可用 Chrome/Playwright 二进制，原定的 playwright e2e 命令跑不了，改成这两条
      可看物：本机沙箱 Chrome/Playwright 不可用，无法截图/录屏；条状提示复用 U0 已确认的 `DraftRestoreBanner`（同一个组件，没有新样式），实际刷新/草稿行为只能靠你自己打开 7 个页面点一遍验证
      定性状态：待你确认（尤其是：切 tab 回来价格表/商品/客户列表有没有真的刷新；编辑到一半切走回来有没有弹出草稿恢复条；新建商品/新建客户刷新页面后草稿还找得到）
      证据：tsc 对 7 个文件合并检查无输出；build exit code 0。本单执行过程中撞上 claude.ai 会话用量限额中断，`products/[id]` 当时只加了三个 hook 的 import 还没真正接线（遗留 `setCategories(cats)` 死代码引用已清理的变量导致 tsc 报错），恢复后由我本人手动核对补完 M1(useRefetchOnFocus 包 fetchReferenceData)+M2(useDraftAutosave 存 tmpl+saleUoms，enabled 绑 editMode，save/discard 都 clearDraft，banner 渲在主卡片上方)，其余 6 个文件经核对确认是完整的，不是半成品；`git status --short` 确认改动精确落在这 7 个文件（另有 DEV-PLAN.md 本身的改动 + U0 遗留的未提交文件，均不属于本次改动范围）
      依赖：U0

## U4 司机/分拣/其他 operator 组（7 页，实际 0 个 M2，详见偏离说明）

- [x] trips/[id]（M1 only，见下方偏离说明）
- [x] trips/page（M1）
- [x] sorting/[id]（M1 only，见下方偏离说明）
- [x] drivers/page（M1，整表刷新对正在内联编辑的行跳过）
- [x] settings/page（M1）
- [x] credit-notes/page（M1）
- [x] returns/page（M1）
      验收命令：`npx tsc --noEmit`（7 文件合并跑，无输出）+ `npm run build`（exit 0，日志 /tmp/build-u4.log 无 error）；本机沙箱无可用 Chrome/Playwright 二进制，原定的 playwright e2e 命令跑不了，改成这两条
      可看物：本机沙箱 Chrome/Playwright 不可用，无法截图/录屏；条状提示本单未新增（下方说明无 M2），实际刷新行为只能靠你自己打开 7 个页面点一遍验证
      定性状态：待你确认（尤其是：切 tab 回来行程/分拣/司机/设置/信用票/退货列表有没有真的刷新；drivers/page 正在内联编辑一行时切走回来会不会被刷新打断）
      证据：tsc 对 7 个文件合并检查无输出；build exit code 0；`git status --short` 确认本次改动精确落在这 7 个文件，无误带改动。偏离说明：trips/[id] 和 sorting/[id] 读代码确认后，整页都是只读详情+状态推进按钮/弹窗即时提交，没有常驻编辑态表单（trips/[id] 的编辑是弹窗打开即改即保存，不是"停留编辑一段时间"的页面级状态），没有需要防抖保存的草稿内容，所以只接了 M1（整页 load 直接重跑），未接 M2——跟 U2 的 purchases/vendors/[id]（M2 only，无 M1）是同一类"按实际代码形状而非按清单机械套用"的偏离，方向相反；drivers/page 是整表内联编辑(editing/dirty 字段)，M1 包的 load() 加了 `!rows.some(r => r.editing)` 判断，避免背景刷新把正在编辑的那一行冲掉
      依赖：U0

## U5 库存组（5 页，无 M2）

- [x] inventory/receive（M1，loadList 常驻刷新 + loadHistory 仅 history 视图下刷新）
- [x] inventory/discrepancies（M1）
- [x] inventory/adjustments（M1）
- [x] inventory/scrap（M1）
- [x] inventory/zones（M1）
      验收命令：`npx tsc --noEmit`（5 文件合并跑，无输出）+ `npm run build`（exit 0，日志 /tmp/build-u5.log 无 error）；本机沙箱无可用 Chrome/Playwright 二进制，原定的 playwright e2e 命令跑不了，改成这两条
      可看物：本机沙箱 Chrome/Playwright 不可用，无法截图/录屏；条状提示本单未新增（无 M2），实际刷新行为只能靠你自己打开 5 个页面点一遍验证
      定性状态：待你确认（尤其是：切 tab 回来待收货采购单/收货历史/差异记录/库存流水/分区库存有没有真的刷新；收货页选中一个采购单正在填收货表单时，列表在背景刷新不会冲掉正在填的内容——因为 loadList 只换下拉列表数据，不碰 selectedPo/drafts）
      证据：tsc 对 5 个文件合并检查无输出；build exit code 0；`git status --short` 确认本次改动精确落在这 5 个文件，无误带改动。未发现偏离 U5 原定"全部 M1 only，无 M2"假设的情况——5 个文件都是"弹窗提交即落库"或"选中后在同一页填一张单据提交"，没有会被切 tab 冲掉的常驻编辑态表单；inventory/receive 稍特殊：loadList 常驻刷新采购单下拉列表，loadHistory 只在 viewMode==='history' 时刷新（用 useRefetchOnFocus 的 enabled 选项挂载），两者都不碰已选中采购单的收货表单草稿（drafts/qc 等），故未接 M2
      依赖：U0

## U6 财务组（4 页，实际 0 个 M2，详见偏离说明）

- [x] finance/invoices/[id]（M1 only，见下方偏离说明）
- [x] finance/invoices/page（M1）
- [x] finance/statements/page（M1）
- [x] finance/vendor-bills/page（M1）
      验收命令：`npx tsc --noEmit`（4 文件合并跑，无输出）+ `npm run build`（exit 0，日志 /tmp/build-u6.log 无 error）；本机沙箱无可用 Chrome/Playwright 二进制，原定的 playwright e2e 命令跑不了，改成这两条
      可看物：本机沙箱 Chrome/Playwright 不可用，无法截图/录屏；条状提示本单未新增（下方说明无 M2），实际刷新行为只能靠你自己打开 4 个页面点一遍验证
      定性状态：待你确认（尤其是：切 tab 回来发票/对账单/供应商账单列表有没有真的刷新；发票详情页切走回来再切回会不会把正在填的收款小表单冲掉——结论是不会，load() 不碰 payAmount/payMethod/payNote）
      证据：tsc 对 4 个文件合并检查无输出；build exit code 0；`git status --short` 确认本次改动精确落在这 4 个文件，无误带改动。⚠️路径更正：台账原文写的 `finance/invoices/[id]` 等路径实际不在 `operator/` 目录下，真实路径是 `app/[locale]/classic/finance/...`（没有 operator 这一层），已核实后按真实路径改动。偏离说明：finance/invoices/[id] 读代码确认 state 只有 inv/payments（只读展示）+ payAmount/payMethod/payNote/payBusy（记一笔付款即提交的快捷小表单，立即 apiPost 落库），发票本身没有可编辑字段（status 变化靠 post/cancel 按钮直接调 API，不是表单保存），没有会被切 tab 冲掉的常驻编辑态内容，所以只接了 M1（整页 load 直接重跑），未接 M2——跟 U2 的 purchases/vendors/[id]、U4 的 trips/[id]/sorting/[id] 是同一类"按实际代码形状而非按清单机械套用"的偏离，第三次出现；finance/vendor-bills/page 点一行会打开带 refDraft（编辑供应商单号）的详情区，但 load() 只刷新 bills 数组不碰 detail/refDraft，背景刷新不会冲掉正在编辑的单号，故无需额外 enabled 判断
      依赖：U0

## U7 其余角色组（7 页，含 2 个 M2）

- [x] driver/trip/[id]（M1 only，见下方偏离说明）
- [x] sorter/sort/[id]（M1 only，见下方偏离说明）
- [x] warehouse/page（M1）
- [x] warehouse/stock-take/page（M1）
- [x] boss/overview/page（M1）
- [x] boss/system/backups/page（M1）
- [x] restaurant/page（M1）
      验收命令：`npx tsc --noEmit`（7 文件合并跑，无输出）+ `npm run build`（exit 0）
      可看物：本机沙箱无可用 Chrome/Playwright 二进制，截图/录屏跳过；实际刷新行为只能靠你自己打开 7 个页面点一遍验证
      定性状态：待你确认
      证据：tsc 对 7 个文件合并检查无输出；build exit code 0；`git status --short` 确认本次改动精确落在这 7 个文件，无误带改动。偏离说明一（按清单套用但形状不符，跟 U2/U4/U6 同一类"按实际代码形状而非机械套用"的偏离，第五、六次出现）：driver/trip/[id] 的可编辑内容只有异常上报/签收弹窗，均是打开即填、提交即关闭，load() 不碰弹窗 state，不存在会被背景刷新冲掉的常驻编辑态，故只接 M1；sorter/sort/[id] 完全没有表单字段（只有勾选+提交），同样只接 M1。偏离说明二（本单新发现，超出原定清单预判）：sorter/sort/[id] 的 restaurants[].done 是纯前端本地勾选状态，仅在整体提交时走 submitSorting，markRestDone 只 PUT wave.status 不落库每家餐馆的勾选进度；naive 的 M1 直接 useRefetchOnFocus([load]) 会在背景刷新时把 restaurants 整体重建、done 全部清空，冲掉分拣员"已经勾了几家还没整体提交"的中间进度——这是本单执行中读代码才发现的，不在原定直接套用清单的范围内，已改用 U4 的 drivers/page.tsx 同款"风险态时跳过刷新"防护模式：`useRefetchOnFocus([() => { if (!restaurants.some(r => r.done)) load() }])`；restaurant/page 原本是把三个 apiGet（customer/products/pricelists）写在一个匿名 useEffect 里，没有具名函数可供 useRefetchOnFocus 调用，已抽成具名 load()，cart 的 sessionStorage 读取保留在 useEffect 里不进 load()，避免背景刷新冲掉购物车内容
      依赖：U0

## U8 收尾

- [x] `/security-review`：1 条 Medium（草稿退出登录后仍留在 localStorage，换人登录同浏览器可在 devtools 读到客户/供应商等敏感字段）→ 已修：新增 `clearDraftsForUser()` + `lib/session.ts` 的 `logout()` 接入 + 补单测，`tests/use-draft-autosave.test.ts` 9/9 通过
- [x] `/code-review high`：10 条发现逐条处理，详见下方清单，全部 fixed 或写明不改理由
- [x] 全量 `npx tsc --noEmit` + `npm run build` + `npm run test` 跑通（项目没有 `scripts/verify.sh` 这个文件，本仓库历史上一直用 tsc+build+test 三件套当验收标准，U1-U7 每单都是这么验收的，不在本单新造一个）
      验收命令：见下方「最终验证」
- [x] DEV-REPORT.md 出报告（给你看的 + 存档用的两栏）
      依赖：U0-U7 全部完成

### 大改完成前置检查（CLAUDE.md 第十一节）结果清单

1. **[fixed]** `lib/hooks/use-draft-autosave.ts`：防抖写入定时器触发时不检查 `pendingDraft` 是否还没被用户处理，会在用户看到"可恢复草稿"提示条之前，被当前（可能是刚挂载的空白表单）内容悄悄覆盖。已加 `pendingDraftRef` 判断，为 null 才真正写入。
2. **[fixed]** `app/[locale]/classic/operator/purchases/vendors/[id]/page.tsx`：`useDraftAutosave` 没有等 `loading` 变量落地就启用，编辑已有供应商时会把 `loading===true` 期间的空白占位表单写进这个供应商 id 的草稿，冲掉之前真正保存的内容。已加 `enabled: !loading`。
3. **[fixed]** `app/[locale]/classic/operator/products/[id]/page.tsx`：`fetchReferenceData()` 为下拉过滤掉 Length/Time 类计量单位后，`load()` 把这份过滤后的列表也当成查"商品自己绑定的基础单位"的数据源——若商品自己的单位恰好属于这两类，`uomName` 会显示空白（经 `git show` U3 原始 diff 核实：改动前 `load()` 用的是未过滤的原始列表，这确实是本次重构引入的回归，不是原有问题）。已改为 `fetchReferenceData()` 同时返回过滤后/未过滤两份列表，查自己单位用未过滤的那份。
4. **[fixed]** `app/[locale]/classic/operator/trips/[id]/page.tsx`：编辑弹窗打开时 `editRestaurants` 是 `trip.restaurants` 的快照，`load()` 不会同步它；弹窗开着时背景刷新把 `trip` 换新，保存时仍用旧快照覆盖，可能把其间别的 tab 对同一行程的改动顶掉。已加 `if (!showEdit) load()` 判断。
5. **[fixed]** `app/[locale]/classic/operator/purchases/annual-plan/page.tsx`：`load()` 每次都无条件全选，背景刷新会悄悄撤销操作员提交批量前刻意做的取消勾选。已改为仅首次加载全选，之后的刷新只同步掉已经不在列表里的行。
6. **[fixed]** `app/[locale]/classic/operator/purchases/suggestions/page.tsx`：`load()` 每次都无条件清空 `selectedIds`，背景刷新会清空正在进行的批量勾选。已把"清空选择"从 `load()` 里拆出来，改成只在 `activeTab`/`page` 真正变化时才清空。
7. **[fixed]** `app/[locale]/classic/restaurant/page.tsx`：商品加载成功的回调无条件 `setPage(1)`，背景刷新会把顾客翻到的页码弹回第一页。已改为只在首次加载时归 1。
8. **[fixed]** `app/[locale]/classic/operator/quotations/[id]/page.tsx` 与 `orders/[id]/page.tsx`：草稿 `entity` 字段分别写死 `'quotation'`/`'order'`，而报价单确认后会变成同一条 id 的订单、改到 `/orders/[id]` 继续编辑——两边字段结构完全一致，却因为 entity 名不同导致确认前开始写的草稿在确认后永久找不到。已把 `quotations/[id]` 的 entity 统一改成 `'order'`（与底层记录类型对应，不是与路由对应）。
9. **[fixed]** `app/[locale]/classic/operator/orders/page.tsx` 与 `quotations/page.tsx`：`useServerList` 本身已经自带 focus/visibilitychange 监听会调用 `fetchPage`，这次又把它的 `refresh` 包进新增的 `useRefetchOnFocus`，导致切回 tab 时同一份列表请求打两次。已从这两个页面的 `useRefetchOnFocus` 数组里去掉 `refresh`，只保留它没覆盖到的其它参考数据（司机档期候选/客户行程候选）。
10. **[not fixed，已知债务]** `app/[locale]/classic/operator/place-order/page.tsx`（2293 行）、`pricelists/[id]/page.tsx`（1819 行）：CLAUDE.md 第八节"页面文件不超 150 行"，这两个文件在本次改动前就已经超限 10 倍以上，本次只是在已有结构上接线，没有让问题变得更严重；真正拆分是独立的大改，不在本任务范围内，留作已知技术债。

### 最终验证（全部修复后重跑）

- `npx tsc --noEmit`：无输出
- `npm run build`：exit 0，`/tmp/build-final.log` 无 error
- `npm run test`：961 条，951 通过，8 条失败——7 条是 role-reachability/rbac-gate 既有基线问题（`/api/auth/register` 匿名可达等，U0 验收时已记录，与本任务改动无关），1 条 `pricing-override.test.ts` 的"不传覆盖时使用客户档案默认价格表"失败原因是本机开发库里没有测试要用的 "ABCT" 客户数据（环境/种子数据问题，单独跑该文件复现同样的前置断言失败，跟本任务任何改动都无关）；跟改动前的基线（950/960，8 条同类失败）对比，净增的那 1 条 pass 是本次新加的 `clearDraftsForUser` 单测，没有引入新的失败
