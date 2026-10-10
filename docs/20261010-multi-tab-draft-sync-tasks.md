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

## U4 司机/分拣/其他 operator 组（7 页，含 2 个 M2）

- [ ] trips/[id]（M1+M2）
- [ ] trips/page（M1）
- [ ] sorting/[id]（M1+M2）
- [ ] drivers/page（M1）
- [ ] settings/page（M1）
- [ ] credit-notes/page（M1）
- [ ] returns/page（M1）
      验收命令：`npx tsc --noEmit`
      可看物：`docs/shots/20261010-u4-*.png`
      定性状态：待你确认
      证据：（回填）
      依赖：U0

## U5 库存组（5 页，无 M2）

- [ ] inventory/receive（M1）
- [ ] inventory/discrepancies（M1）
- [ ] inventory/adjustments（M1）
- [ ] inventory/scrap（M1）
- [ ] inventory/zones（M1）
      验收命令：`npx tsc --noEmit`
      可看物：`docs/shots/20261010-u5-*.png`
      定性状态：待你确认
      证据：（回填）
      依赖：U0

## U6 财务组（4 页，含 1 个 M2）

- [ ] finance/invoices/[id]（M1+M2）
- [ ] finance/invoices/page（M1）
- [ ] finance/statements/page（M1）
- [ ] finance/vendor-bills/page（M1）
      验收命令：`npx tsc --noEmit`
      可看物：`docs/shots/20261010-u6-*.png`
      定性状态：待你确认
      证据：（回填）
      依赖：U0

## U7 其余角色组（7 页，含 2 个 M2）

- [ ] driver/trip/[id]（M1+M2）
- [ ] sorter/sort/[id]（M1+M2）
- [ ] warehouse/page（M1）
- [ ] warehouse/stock-take/page（M1）
- [ ] boss/overview/page（M1）
- [ ] boss/system/backups/page（M1）
- [ ] restaurant/page（M1）
      验收命令：`npx tsc --noEmit`
      可看物：`docs/shots/20261010-u7-*.png`
      定性状态：待你确认
      证据：（回填）
      依赖：U0

## U8 收尾

- [ ] 全量 `npm run build` + verify.sh 新增段落跑通
- [ ] DEV-REPORT.md 出报告（给你看的 + 存档用的两栏）
      依赖：U0-U7 全部完成
