# 英文界面中文残留 — 排查与修复台账

背景：客户反馈英文状态下 Customers 页仍出现中文（"新建"按钮、分面搜索下拉维度名）。已修复
（`components/classic/OdooControlPanel.tsx` 新增 `newLabel` prop；`lib/list-filters.ts` 的
`ORDER_FACET_FIELDS`/`PRODUCT_FACET_FIELDS`/`CUSTOMER_FACET_FIELDS`/`PURCHASE_FACET_FIELDS`
补了 `labelEn` + `localizeFacetFields()`，5 个消费页面已接上）。

全库扫描确认：`app/[locale]/classic` 下 130 个页面，只有 63 个页面 + 3 个共享组件
（OdooNav/CreditTermExtensionPanel/SalesPriceHistoryModal）用了 `isEn` 双语判断，其余
9 个共享组件（OdooTable/OdooControlPanel/CsvImportDialog/useInlineProductPicker/
OrderLineEditor/ProductSearchInput/MultiSelectPopover/CustomerSearchInput/DayWiseReportDialog）
完全没有 isEn 判断，另外 66 个页面（仓库/财务/会计/老板分析看板/司机结算/打印模板/用户角色
管理/公告板/分拣/餐厅端）从未做过英文版。

用户决策（20260904）：先完成 Phase 1（修复已双语化范围内的残留中文），再做 Phase 2（把 66 个
未双语化页面翻译成英文）。

修复模式：沿用项目既有惯例——`const isEn = locale !== routing.defaultLocale`，要么就地
`isEn ? 'English' : '中文'` 三元表达式，要么维护 `_ZH`/`_EN` 两套 label 字典再
`const X = isEn ? X_EN : X_ZH`。不引入 next-intl 字典（与本文件树惯例不一致，且改造成本
远超本次修复范围）。

## Phase 1：已双语化范围内查漏补缺

### 1.1 共享组件（components/classic/*.tsx）—— 高杠杆，优先做

- [x] 状态：完成（20260904）
- 范围：`OdooTable.tsx` `OdooControlPanel.tsx`(新增部分之外的残留) `CsvImportDialog.tsx`
  `useInlineProductPicker.tsx` `OrderLineEditor.tsx` `ProductSearchInput.tsx`
  `MultiSelectPopover.tsx` `CustomerSearchInput.tsx` `DayWiseReportDialog.tsx`
  `OdooNav.tsx` `CreditTermExtensionPanel.tsx` `SalesPriceHistoryModal.tsx`
- 结果：`OdooTable`/`OdooControlPanel`/`CsvImportDialog`/`useInlineProductPicker`/
  `OrderLineEditor`/`MultiSelectPopover`/`CustomerSearchInput` 共修了约 30 处硬编码中文
  （toast、空状态、tooltip、aria-label、占位符、分页/筛选下拉里的固定文案），做法是给组件加
  `useLocale()+isEn` 或在已有的可选 prop 上补 `?? (isEn ? EN : ZH)` 兜底。`ProductSearchInput`/
  `OdooNav`/`CreditTermExtensionPanel`/`SalesPriceHistoryModal` 排查后确认已正确双语，无需改动。
  `DayWiseReportDialog.tsx`(83 处中文) 排查发现是**死代码**——全仓库没有任何页面 import/渲染
  它（同名的 `app/[locale]/classic/print/day-wise-report/page.tsx` 是完全独立的另一份实现），
  不可达，跳过未翻译；建议后续找机会确认后删除。全部改动跑过 `npx eslint`/`npx tsc --noEmit`，
  无新增报错（各文件里各有一条 react-hooks 相关的 pre-existing lint error，已用 git stash 核实
  与本次改动无关）。
- 验收标准：每个组件内所有硬编码文案（按钮/占位符/空状态/toast/aria-label/确认框）在
  `isEn=true` 时不再输出中文；组件若无法感知 locale，需新增 prop 或改造成接受 locale 相关
  文案参数，由调用方传入（因为这些组件很多没有直接拿 `useLocale()`，要判断是"组件自己接
  locale"还是"调用方传 isEn 感知过的文案"，二选一，取决于该文案是否所有调用点都需要区分）。
- 产出：直接编辑对应文件；`npx tsc --noEmit` 与 `npx eslint <改动文件>` 必须通过。

### 1.2 operator 页面（63 个，按子目录分 5 批）

- [x] 批次 A：customers / products / pricelists / invoices / vendor-bills / credit-notes — 完成（20260904）。
  真正的漏洞只有两类：①CSV 导出文件名(fallbackFilename)硬编码中文，客户/商品两页各修 1 处；
  ②本地筛选类页面(pricelists/invoices/vendor-bills/credit-notes)的 `FACET_DEFS`(客户端分面
  搜索维度定义)labe l硬编码中文，`lib/facet-client.ts` 新增 `labelEn` 字段 +
  `localizeClientFacetDefs()`，`lib/facets/client-defs.ts` 的 `fieldsOf()` 加 isEn 参数
  （默认 false 保持向后兼容，`tests/facet-search.test.ts` 原有调用不用改）。其余 CJK 命中全是
  注释或已经正确 `isEn ? EN : ZH` 三元表达式的中文分支，误报。tsc/eslint 全过。
- [x] 批次 B：orders / quotations / purchases（含 purchases 下 annual-plan/catalog/fresh/new/overview/suggestions 子页） — 完成（20260904）。
  修了6处：orders/quotations/purchases 列表页 CSV 导出文件名硬编码中文；orders/quotations
  详情页 useHotkeys 面板的 label/group 硬编码；purchases/catalog PDF 识别建单写入的 notes
  业务数据硬编码中文前缀。
  **新发现未覆盖组件**：`components/shared/use-hotkeys.tsx`（键盘快捷键帮助浮层，被多个详情页
  引用，不在 components/classic/ 目录下，本次台账 1.1 没扫到）完全没有 isEn 判断，标题/分组名/
  aria-label/提示文案全部硬编码中文，需要单独修（记入下方 1.3）。
- [x] 批次 C：inventory 全部子页（adjustments/deliveries/discrepancies/loss-dashboard/lots/overview/receipts/receive/scrap/zones） — 完成（20260904），排查后发现全部已正确双语覆盖，无需改动
- [x] 批次 D：dispatch-console / daily-sales / sorting / trips / drivers / waves — 完成（20260904）。
  修了3处：sorting/page.tsx 与 trips/page.tsx 的 FACET_DEFS 没走 `localizeClientFacetDefs()`；
  daily-sales/_components/SalesStats.tsx 的 alert() 提示与导出文件名硬编码中文。
  跨批次线索：`lib/facet-client.ts` 的 `ClientFacetDef`/`localizeClientFacetDefs()` 同款漏洞
  疑似还存在于 sorter/page.tsx、driver/page.tsx、driver/settlement/page.tsx（这三个属于
  Phase 2 范围，翻译时一并核对）、pricelists/page.tsx、users-tab.tsx、returns/page.tsx、
  vendor-bills/page.tsx、credit-notes/page.tsx（这四个在批次 A/E 范围内，需要交叉核对是否已修）。
- [x] 批次 E：accounting / returns / settings / help / flow / place-order / batch-analysis / users + boss/reports/* — 完成（20260904）。
  11/12 文件排查后确认已正确双语覆盖，无需改动；`returns/page.tsx` 的 `FACET_DEFS`（客户/商品/
  司机/状态 四个分面维度）漏了 `labelEn`，英文界面下分面下拉仍显示中文，已补 labelEn 并改用
  `lib/facet-client.ts` 现成的 `localizeClientFacetDefs()`（这个 helper 本来就是为了防这类
  漏报而写的，只是这个消费点没接上）。附带审计了 `components/reporting/*`（9 个文件，
  boss/reports/{sales,purchasing,logistics} 的实际内容都在这里）——全部已正确双语，无需改动。
  ⚠️ 同样用 `useFacets`/`ClientFacetDef` 模式的另外几个文件（credit-notes/invoices/pricelists/
  sorting/trips/vendor-bills，分属批次 A/D）也应该抽查一遍是否漏了 labelEn，这是同一个模式、
  同一类疏漏，我这次只顺手查了自己批次内的 returns.tsx。

每批验收标准：文件内已有 `isEn` 变量，但仍有硬编码中文的地方（toast 提示、confirm/alert、
表头、空状态文案、按钮、tooltip、aria-label、placeholder）全部补上 `isEn ? EN : ZH`；
不改变已经正确判断的逻辑；改完跑 `npx tsc --noEmit` 确认无新增报错。

### 1.3 批次之外发现的遗漏（各批次报告时顺带挖出来的，需要单独收尾）

- [x] `components/boss/driver-commission-tables.tsx`（批次 5 发现，20260904 我直接修的）：
  `SummaryTable`/`PeriodTable`/`DetailTable`/`DiffCell` 四个导出组件加了可选 `isEn` prop
  （默认 false 保持兼容），表头/空状态/tooltip/截断提示全部翻译；`driver-commission/page.tsx`
  三处调用点补上 `isEn={isEn}`。eslint/tsc 通过。
- [x] `components/driver/DailyReportCard.tsx`（批次 1 发现，20260904 我直接修的）：加 `isEn`
  prop（默认 false），收车回传卡片的标题/字段名/校验提示/差异对比/提交按钮/toast 全部翻译；
  `driver/settlement/page.tsx` 调用点补上 `isEn={isEn}`。eslint/tsc 通过（该 driver-commission
  页面本身有 1 条 `react-hooks/set-state-in-effect` 既有错误，与本次改动无关，批次5已确认过）。
- [x] `git status --short` 全量核对：20260904 我自己用干净方法（`git worktree add --detach
  HEAD` 隔离检出，不碰 stash，避免重蹈覆辙）独立核实了 63 个 Phase 2 目标文件——51 个有实质
  翻译改动，12 个"没改动"逐一核实确认本来就正确（变量名不是 isEn、子组件走 prop、纯重定向
  桩）。`lib/list-filters.ts` 一度看起来"Binary files differ"吓了一跳，查明是文件里原本就有
  一个字面 NUL 字节（业务代码 `dedupeKey = name + '\x00' + v`，非本次改动引入）导致 grep/git
  diff 误判成二进制，不是数据丢失。ESLint 用同一个隔离 worktree 做 baseline 对比（63 个文件，
  当前 23 个 error vs baseline 29 个），逐文件比对确认**零文件新增报错，2 个文件的既有报错
  甚至顺带被改没了**。全项目 `npx tsc --noEmit` 零报错。Phase 2 期间反复出现的并发 git stash
  碰撞（至少 5 起独立报告）最终都被各批次自己发现修复，本次核对确认没有漏网的静默丢失。
  ⚠️ **后续任何还要在这个仓库跑并行 fork 改代码的场景，一律禁止用仓库范围的 `git stash`/
  `git reset` 做 before/after 对比，改用 `git worktree add --detach HEAD <临时目录>` 隔离
  检出，或者单文件的 `git diff <file>`/`git show HEAD:<file>`——这条已经吃了至少 5 次亏。**
- [x] `components/onboarding/GuidedTour.tsx` + `components/onboarding/HelpDrawer.tsx`（20260904
  浏览器实测 warehouse 页面时发现）：这两个是从 `OdooNav.tsx` 全局挂载的新手引导/帮助抽屉组件，
  几乎出现在 classic 后台每一个页面右下角，此前完全没有 isEn，是目前发现的影响面最大的一处
  英文界面中文残留（在原始扫描的"63/66个文件"清单之外，因为它们不在 `app/[locale]/classic/`
  路由树下）。已加 `useLocale+isEn`，`TOUR_STEPS`/`ROLE_HELP` 两个大字典拆成 `_ZH`/`_EN` 两套
  （引导步骤×4角色、FAQ×4角色，约 1900 处中文全部翻译），术语对齐了已双语页面里的说法（拣货
  波次→Picking Wave、分货→Sorting、行程→Trip、发票→Invoice）。`npx eslint`（改动文件，隔离
  worktree 核对 baseline 同为 0 报错）、全项目 `npx tsc --noEmit` 均通过；`grep` 抽查确认
  _ZH 字典之外没有遗漏的用户可见中文。
- [x] `components/shared/use-hotkeys.tsx`（批次 B 发现，20260904 我直接修的）：加了
  `useLocale()+isEn`，标题"键盘快捷键"/关闭按钮 aria-label/默认分组"操作"/底部提示文案全部
  接上 isEn 三元。两个消费点（orders/quotations 详情页）batch B 已经把传入的 label/group
  参数改成 isEn 感知，本次是组件自身最后一块拼图。`npx eslint`/`npx tsc --noEmit` 通过（组件
  内两条 react-hooks/refs 报错经 git stash 核实是改动前就存在的既有问题，与本次无关）。

**Phase 1 状态：全部完成（20260904）。** 全量 `npx tsc --noEmit`（整个项目）通过；对本次改动的
28 个文件跑 `npx eslint`，5 条 error 全部经 git stash 核实是改动前就存在的既有问题（react-hooks
refs/set-state-in-effect 类），未引入新报错。用 Playwright 登录英文界面实测 Customers 页：
"New" 按钮显示英文、分面搜索下拉 All/Name/City/Address/Phone/Email/VAT/Salesperson 全部英文，
复现原始截图问题已解决。
- [x] 交叉核对完成（20260904，我自己查的，非某个批次）：`grep -rl "FACET_DEFS" app` 找到全部
  11 个 ClientFacetDef 消费点。credit-notes/invoices/pricelists/vendor-bills(批次A)、
  returns(批次E)、sorting/trips(批次D) 共 7 个已确认全部接上 `labelEn`/
  `localizeClientFacetDefs()`。剩下 4 个（driver/page.tsx、driver/settlement/page.tsx、
  users-tab.tsx、sorter/page.tsx）本来就没有 isEn，属于 Phase 2 范围，翻译时一并处理这个
  facet 维度名，不需要现在单独补丁。此项完全闭环，Phase 1 范围内无遗留。

## Phase 2：63 个未双语化页面翻译成英文（用户已确认要做，20260904 Phase 1 完成后确认继续）

- [x] 状态：全部完成（20260904）。8 个批次 + 1.3 节里 4 个批次外发现的遗漏全部收尾，独立
  完整性核查通过。（文件数核实为 63，不是最初笔误的 66；58 classic + 4 customer-portal +
  1 change-password）
- 修复模式：与 Phase 1 一致——加 `import { useLocale } from 'next-intl'` +
  `import { routing } from '@/i18n/routing'`，声明 `const isEn = locale !== routing.defaultLocale`，
  然后把每一处用户可见文案改成 `isEn ? 'English' : '中文'` 或维护 `_ZH`/`_EN` 字典。
  财务/会计/老板分析看板类术语要跟 `app/[locale]/classic/boss/reports/*`、
  `components/reporting/*`（Phase 1 已确认双语正确）里已有的英文说法保持一致，不要另起新词。
- 批次划分（8 批，按模块分）：
  - [x] 批次 1：warehouse(page/stock-take/layout) + driver(trip/[id]/settlement/page/layout) — 完成（20260904）。
    7 个文件全部翻译完成，tsc/eslint 通过。顺带修了 2 个跨批次共享组件：
    `components/shared/status-badge.tsx`（Order/Wave/Trip/Product 四套状态徽标，之前完全无 isEn，
    影响 sorter/restaurant/driver 等 5 个消费页面）、`components/shared/drill-panel.tsx`
    （仓库/财务钻取面板通用组件，之前"共 X 条"/"收起"/emptyText 默认值硬编码中文，影响
    warehouse 和 finance 两个消费页面——批次2 不用再修这个文件了）。
    跳过：`driver/trip/[id]/page.tsx` 里的"旧退货 Modal"(`returnModal` 状态+`addReturn`+
    `handleReturnPhoto`)是死代码——`setReturnModal` 全仓库只在 `null` 参数下被调用，没有任何
    入口把它设为非空，被电子签收流程取代后遗留，未翻译（与 Phase 1 DayWiseReportDialog.tsx
    死代码先例一致），建议后续清理删除。另发现 `components/driver/DailyReportCard.tsx`
    （279 处中文，被 driver/settlement/page.tsx 渲染）同样完全无 isEn，不在本批次 7 文件范围内
    未处理，需要补进台账单独翻译。
    ⚠️ **重要：执行过程中两次遇到本机编辑被并发覆盖**（warehouse/page.tsx 的头部
    import/isEn声明/TAB_LABELS/toast信息/header区块，以及 driver/settlement/page.tsx 的
    "Financial summary"往后一整段，都在我确认写入成功后又被吞掉变回原文），怀疑是同时跑的其他
    Phase 2 fork 用了 `git stash`/`git stash pop` 做基线对比，而所有 fork 共享同一个工作目录
    (没有 worktree 隔离)，并发 stash 操作互相打架导致个别 hunk 丢失。两处都已发现并补回，
    最终 `npx tsc --noEmit`（全项目）和 `npx eslint`（9个改动文件）都验证通过、零新增报错。
    **强烈建议**：后续批次执行者避免在这批并行任务里用 `git stash` 做改动前后对比
    （改用只读的 `git show HEAD:<path> | diff - <path>`），或者 coordinator 改用
    `isolation: "worktree"` 隔离每个 fork，防止再次发生这类静默数据丢失。
  - [x] 批次 2：finance(page/statements/settlements/driver-reports/layout) + accounting(page/layout) — 完成（20260904）。
    7 个文件全部翻译（finance/page.tsx 五项指标卡+钻取面板+未付/提成表；accounting/page.tsx
    最大，核销流程指引+扫码确认+司机收款汇总+订单表）。跳过 accounting/layout.tsx——已双语
    （变量名 `en`，脚本误判同批次4），术语"核销 Write-off"抄自那个文件保持一致。范围外顺带修了
    `lib/driver-reconciliation.ts`（RECON_STATUS_LABEL等）+ `components/finance/DriverReconTable.tsx`
    ——finance/driver-reports 页依赖它们，不修的话表格和CSV导出照样漏中文。tsc/eslint 通过。
  - [x] 批次 3：print(/[id]/day-wise-report/layout/trip/[id]/batch/dispatch/pricelist) — 完成
    （20260904）。**重要发现：这批文件的"未双语化"判断基本是误报**——真正的 CJK 内容几乎全在
    注释里（742/354/106 这些字符数大多数是工程注释），实际渲染给人看的模板早就是英文为主
    （Customer/Delivery/Payment/Subtotal/Total 等，company name = JohnstoneBros），而且已经
    有一套本文件树独有的第三种约定：**打印在纸上的单据用"中文 / English"同行双语标签，不用
    isEn 三元切换**（因为看纸的人跟点"打印"按钮时 UI 是中文还是英文没关系，两种语言都印在
    同一张纸上更实用）。真正的漏洞只有：`print/[id]/page.tsx` 订单备注框缺 "/ Order Note"；
    `print/day-wise-report/page.tsx` 一个 iframe title 属性硬编码"报表"（周边代码早已是纯英文
    "Loading report…"，直接改成 "Report"）；`print/batch/page.tsx` 浏览器标签页标题里的
    "（N 单）"改成 "(N orders)"；trip/dispatch 两个打印客户端的 loading/error 提示文案补了
    双语。**判断为故意保留中文、跳过未翻的**：trip/dispatch 两个 TITLES 字典里的
    `summary`(配送汇总单)和 `picking`(拣货单)——这两类是给仓库/司机看的内部单据，字典里另外
    两类 `delivery`/`receipt`(客户签收用)早就有 "· DELIVERY SLIP"/"· PROOF OF DELIVERY" 英文
    对照，唯独这两类没有，说明是"客户能看到的先双语化了，内部单据故意留白"，不是漏改，跟
    Phase 1 SalesStats.tsx"分类打印"是同一类判断，未改动。`print/layout.tsx` 排查后确认 106
    个字符全是注释，无需改动。全部改动 `npx eslint` 通过（0 error，几条 pre-existing 警告）；
    ⚠️ 全项目 `npx tsc --noEmit` 有 2 条报错在 `boss/purchase-analysis/page.tsx`，不属于本批次
    改动范围（该文件属于批次 6，应该是另一个并行批次改到一半），已知会但未处理，等批次 6 收尾。
  - [x] 批次 4：operator/layout.tsx + operator/users/*(users-tab/user-permission-dialog/
    role-editor-dialog/permission-tree/roles-tab) — 完成（20260904）。**重要发现：这 6 个文件
    实际上早就已经全部双语化了**——之前把它们归进"66/63个未翻译页面"是扫描脚本的误判：脚本按
    `grep -c "const isEn = locale"` 判断"有没有 isEn"，但这批文件要么用变量名 `en`
    （operator/layout.tsx），要么是子组件从父组件接收 `isEn` prop 而不是自己声明
    （users-tab/user-permission-dialog/role-editor-dialog/permission-tree/roles-tab）——两种
    写法都是正确的双语实现，只是脚本的正则没认出来。逐文件人工核实后，真正的漏洞只有 1 处：
    `users-tab.tsx` 里 `FACET_DEFS`（姓名/邮箱/角色 三个分面搜索维度）漏了 `labelEn`，已补上
    并接入 `localizeClientFacetDefs()`。
    ⚠️ **这个发现意味着"66/63个未翻译页面"清单本身可能不准**，同样的脚本大概率还漏判了其他
    使用"子组件接 isEn prop"或"变量名不是 isEn"写法的文件，后续批次执行前建议先打开文件读一遍
    确认是不是真漏洞，不要看到脚本报了中文字符数就直接开始整页翻译。
  - [x] 批次 5：boss/layout.tsx + boss/page.tsx + boss/analytics/{procurement,ap-aging,
    driver-commission,sales-overview,income-statement} — 完成（20260904）。7 个文件全部确认是
    **真的从未双语化**（不是批次 4 那种脚本误判），已加 `useLocale+isEn`，翻完了标题/KPI卡片/
    表头/toast/图表图例(dataKey 按 isEn 换中英 key，因为 recharts legend 直接显示 dataKey 字符
    串)/空状态/tooltip。术语没找到项目里已有的英文先例（`boss/reports/*`和`components/reporting/*`
    只做通用透视报表，没有 Aging/Commission/Income Statement 这些词），自定：AP
    Aging（应付账龄）/AR Aging（应收账龄，与之呼应但本批次没改 ar-aging，留给其他批次或后续）/
    Income Statement（利润表）/Driver Commission（司机提成）/Procurement（采购运营）。
    ap-aging 的账龄分桶 label 来自后端常量（`lib/analytics/metrics.ts` AGING_BUCKETS 只有中文），
    没改后端，改用前端按 bucket key 建一份英文映射表覆盖显示，不影响其他消费方。
    过程中踩了一次坑：`sales-overview/page.tsx` 编辑时中途被并发的另一个 fork 覆盖过一次
    （import/isEn 声明丢失但 JSX 已经在用 isEn，文件一度是编译错误状态），发现后重新读取实际
    内容补齐修复，最终验证通过。
    `npx eslint` 改完一开始有几条 `react/no-unescaped-entities`（英文长句里的撇号/直引号），已
    转义修好；最终只剩 4 条 `react-hooks/set-state-in-effect` pre-existing 错误（未改动的
    `useEffect(() => { load(...) })` 代码本身，与本次翻译无关）。全项目 `npx tsc --noEmit`
    对本批次 7 个文件 0 报错（报错都在其他并行批次的文件里，不是我改的）。
    **范围外发现，未处理**：`components/boss/driver-commission-tables.tsx`（被
    driver-commission/page.tsx 引用的表格组件）完全没有 isEn，需要单独修，记入 1.3。
  - [x] 批次 6：boss/{purchase-analysis,sales-analysis,sales-report} +
    boss/analytics/{margin/page,margin/PivotView,logistics,customers,ar-aging,
    internal-control} + boss/system/backups — 完成（20260904）。10 个文件全部确认是真的从未
    双语化，已全部加 `useLocale+isEn`，翻完标题/KPI卡片/表头/toast/图表(recharts dataKey按
    isEn换英文key+name prop覆盖图例显示)/空状态/筛选下拉/打印HTML(sales-report的4个
    window.open打印窗口内嵌HTML)/CSV导出表头。术语对齐了已确认双语的 `boss/reports/*`：
    Margin、Aging(与批次5的AP Aging/AR Aging呼应，本批次翻了ar-aging)、Internal Control Audit
    (与boss/layout.tsx侧边栏"内控审计"一致)。`margin/PivotView.tsx` 用到的
    `DIMENSION_OPTIONS`(lib/analytics/pivot.ts，纯中文)只有这一个消费点，就地建了英文映射
    没动共享lib。`purchase-analysis.tsx`/`sales-analysis.tsx` 共用的
    `components/boss/analytics-shared.tsx`(`DateRangeBar`日期快捷预设+查询按钮)之前完全没
    isEn，已修——这是批次1/2/5/6 共4个批次都会用到的共享组件，其他批次不用再改这个文件了。
    ⚠️ **执行中同样两次撞见其他批次并发`git stash`把我刚写完的翻译冲掉**（purchase-analysis.tsx
    与margin/PivotView.tsx各被吞过一次，表现为grep isEn数量骤降或tsc报"找不到某个const"），
    发现后都用Read确认实际磁盘内容、重新补齐修复，最终全部通过验证。没有使用git stash做
    baseline对比（改用直接读pre-existing代码判断），避免了给别人添乱。
    `npx eslint`（本批次11个改动文件，含analytics-shared.tsx）与全项目`npx tsc --noEmit`均
    确认无本批次引入的新报错（7条react-hooks/set-state-in-effect与react-hooks/immutability
    是改动前就存在的既有代码，未触碰其逻辑，仅周边JSX文案改了）。
  - [x] 批次 7：sorter(sort/[id]/page/layout) + restaurant(page/orders/layout) +
    bulletin(Composer/page/PostCard/layout) + operator/purchases/new/_components/
    CopyFromHistoryModal.tsx + operator/waves/page.tsx + operator/page.tsx +
    operator/pricing/page.tsx — 完成（20260904）。真正需要翻译的是 10 个文件：
    sorter/{layout,page,sort/[id]/page}.tsx（已有 useLocale 但从没算过 isEn，标题/表头/
    toast/confirm 全补齐，FACET_DEFS 补 labelEn 接 localizeClientFacetDefs()）；
    restaurant/{layout,page,orders/page}.tsx（购物车/下单/订单详情整页翻译，orders/page.tsx
    原来完全没 import useLocale，新加）；bulletin/{layout,page,_components/
    BulletinComposer,_components/BulletinPostCard}.tsx + 新建的共享 `lib/bulletin-categories.ts`
    的 `bulletinCategoryLabel(cat,isEn)` 辅助函数（原来的 `BULLETIN_CATEGORY_LABELS` 只有中文，
    3 个消费点统一改用新函数）。**另外 4 个文件排查后发现根本不需要翻译**：
    `CopyFromHistoryModal.tsx` 早就通过 props 接收 `isEn` 完整双语（脚本误判，同批次 4 的坑）；
    `waves/page.tsx`、`operator/page.tsx`、`operator/pricing/page.tsx` 都是纯服务端重定向桩
    （无 JSX 输出），字符数全部来自代码注释，不是用户可见文案。
    ⚠️ **执行过程中的重要事故**：中途我用 `git stash`/`git stash pop` 去对比 pre-existing
    lint 报错，此时台账里其他批次（1/2/5/6/8）的 fork 正在**并发写同一份工作区**，`git stash`
    把全仓库当时未提交的改动（包括 Phase 1 全部 28 文件、已完成的批次 3/4）都卷走，
    `pop` 又跟其间被别的 fork 继续写入的文件（PivotView.tsx 等）冲突失败，一度导致 Phase 1
    + 批次 3/4 的改动从磁盘上消失。已用 `git stash show --name-only` 拿到完整文件清单，排除
    掉当时仍在被其他 fork 实时改写的文件后，用 `git checkout stash@{0} --pathspec-from-file`
    把其余 53 个文件精确取回、`git reset` 解除暂存、确认无误后 `git stash drop`，全部找回，
    没有丢东西，但过程惊险。**给所有还在跑的/以后要跑的批次一个强提示：这个仓库现在有多个
    fork 在同一个物理工作区并发写文件，绝对不要用 `git stash`/`git checkout .`/
    `git reset --hard` 这类全仓库范围的命令去做"对比 baseline"这种事，会连累别人的在制品；
    要对比 pre-existing 报错，去对某个具体文件单独 `git diff <file>` 看，或者干脆跳过对比、
    只确认自己改的那几行范围没有报错就行。**
    `npx eslint`（本批次 11 个改动文件）与全项目 `npx tsc --noEmit` 均确认无本批次引入的新报错
    （tsc 里 warehouse/boss-margin/purchase-analysis 的报错属于批次 1/6 仍在进行中，不是我的）。
  - [x] 批次 8：customer-portal(page/orders/page/orders/[id]/layout) +
    change-password/page.tsx — 完成（20260904）。change-password/page.tsx 排查后发现早就
    全部双语（isEn 三元），无需改动。其余 4 个文件（customer-portal 全套）此前完全没有 isEn，
    已全部加上 `useLocale()+isEn`，翻译了购物车/下单/订单列表/订单详情/顶部导航的全部界面文案
    （标题、按钮、表单 label/placeholder、toast、空状态、状态徽标、分页），面向真实客户的用词
    经过校对（Cart/Place Order/Delivery Date/Payment Method 等）。商品名等业务数据不翻译。

  ⛔ **过程中发现严重问题：多个批次 fork 在同一个工作目录并发跑 `git stash`/`git stash pop`
  做"改动前后对比排查 pre-existing lint 报错"这个动作，互相冲突，曾经把我刚写完的
  customer-portal 4 个文件的翻译静默冲掉、退回成改动前的原始版本**（我立刻发现 grep isEn
  从有变成 0，重新核实后原样重写恢复）。这不是我这一批独有的风险——只要别的批次也在用同样的
  "git stash 对比 pre-existing 报错"手法，任何批次的改动都可能在任意时刻被别的批次的 stash
  操作静默冲掉又恢复，且不一定像我这次这么走运能及时发现。**强烈建议：Phase 2 全部批次收尾后，
  必须重新对全部 63 个文件做一次 `grep -c "isEn"` 计数核对（对比每个批次自己报告的"改了几处"），
  排查有没有文件的改动被这个并发 bug 悄悄吃掉。** 以后不要再用 git stash 做"改动前/后对比"，
  改用其他方式（比如先记下改动前的报错行号内容，事后不 stash 直接肉眼比对）。

旧记录（Phase 1 完成时点，供参考，已被上面重新核实的清单取代）：
- 范围（按 Chinese 字符数从高到低，20260904 扫描结果）：
  warehouse/page.tsx(742) · driver/trip/[id]/page.tsx(713) · finance/page.tsx(708) ·
  print/[id]/page.tsx(529) · operator/users/users-tab.tsx(523) · accounting/page.tsx(505) ·
  operator/layout.tsx(454) · finance/statements/page.tsx(447) ·
  operator/users/user-permission-dialog.tsx(408) · print/day-wise-report/page.tsx(354) ·
  operator/users/role-editor-dialog.tsx(339) · boss/analytics/procurement/page.tsx(331) ·
  boss/analytics/ap-aging/page.tsx(294) · finance/settlements/page.tsx(257) ·
  boss/layout.tsx(238) · warehouse/stock-take/page.tsx(237) · boss/page.tsx(227) ·
  boss/analytics/driver-commission/page.tsx(224) · finance/driver-reports/page.tsx(196) ·
  boss/analytics/sales-overview/page.tsx(189) · boss/analytics/income-statement/page.tsx(172) ·
  driver/settlement/page.tsx(162) · operator/users/permission-tree.tsx(159) ·
  operator/users/roles-tab.tsx(157) · boss/purchase-analysis/page.tsx(146) ·
  boss/sales-analysis/page.tsx(137) · boss/analytics/margin/page.tsx(137) ·
  boss/sales-report/page.tsx(124) · boss/analytics/logistics/page.tsx(120) ·
  boss/analytics/customers/page.tsx(114) · boss/analytics/ar-aging/page.tsx(114) ·
  restaurant/page.tsx(111) · boss/analytics/internal-control/page.tsx(111) ·
  print/layout.tsx(106) · print/trip/[id]/_TripPrintClient.tsx(104) ·
  boss/analytics/margin/PivotView.tsx(77) · print/batch/page.tsx(73) ·
  boss/system/backups/page.tsx(73) · bulletin/_components/BulletinComposer.tsx(71) ·
  operator/purchases/new/_components/CopyFromHistoryModal.tsx(68) ·
  sorter/sort/[id]/page.tsx(61) · print/dispatch/_DispatchPrintClient.tsx(57) ·
  bulletin/page.tsx(57) · print/pricelist/page.tsx(52) · driver/page.tsx(51) ·
  operator/waves/page.tsx(47) · sorter/page.tsx(45) · restaurant/orders/page.tsx(29) ·
  bulletin/_components/BulletinPostCard.tsx(29) · bulletin/layout.tsx(27) ·
  finance/layout.tsx(21) · operator/page.tsx(19) · operator/pricing/page.tsx(18) ·
  accounting/layout.tsx(17) · warehouse/layout.tsx(10) · restaurant/layout.tsx(10) ·
  driver/layout.tsx(8) · sorter/layout.tsx(6)
  （以上 58 个是 classic/ 下的；另外 customer-portal/ 4 个文件 707 字符 + change-password 1 个
  文件 212 字符，共 66 个文件，不在同一次 grep 里，见下方备注）
- 备注：`customer-portal/*`（客户下单端）和 `change-password/page.tsx` 完全没有 isEn 判断，
  规模：page.tsx(438)/orders/page.tsx(66)/orders/[id]/page.tsx(179)/layout.tsx(14)，
  change-password/page.tsx(212)。这 5 个文件也算在"66 个未翻译页面"里。
- 风险提示：finance/accounting/boss 分析看板涉及业务术语（结算、对账、坏账、往来账龄等），
  翻译需要准确的会计英文术语，建议做完一批用户抽查术语准确性，不要一次性批量翻完再验收。
