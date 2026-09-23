# 任务台账：全站日期选择器改为「日-月-年」

对应 `DEV-PLAN.md`（2026-09-22）。全部单元一次性周期内完成，验收证据见下。

- [x] M1 基础组件：`components/ui/calendar.tsx` + `components/ui/date-picker.tsx`
      验收命令：`npx tsc --noEmit` 通过
      可看物：见 DEV-REPORT.md 截图
      定性状态：符合
      证据：新增 `react-day-picker@^10.0.1` + `date-fns@^4.4.0`；`npm uninstall cn`（shadcn CLI 误装的多余包，改用项目自有 `lib/utils.ts` 的 `cn`）
      依赖：无

- [x] M2 共享筛选组件：`components/classic/OdooTable.tsx`（覆盖 orders + quotations 列表筛选）、`components/boss/analytics-shared.tsx`（覆盖 boss 报表系列区间筛选）
      验收命令：`npx tsc --noEmit`
      可看物：quotations 列表截图（见 DEV-REPORT）
      定性状态：符合
      证据：浏览器实测列表筛选联动正常（11→10 条），日历弹窗选中后正确写回

- [x] M3-1 daily-sales（打印中心 = 截图原问题）：`PrintCenter.tsx`、`SalesStats.tsx`、`ShortageHandler.tsx`
      验收命令：浏览器实测
      可看物：打印中心截图（09/23/2026 → 23/09/2026）
      定性状态：符合
      证据：切换日期后 "No fully assigned waves for 2026-08-13" 正确联动刷新

- [x] M3-2 orders / quotations 详情页：`orders/[id]/page.tsx`、`quotations/page.tsx`（行内编辑）、`quotations/[id]/page.tsx`
      验收命令：浏览器实测（Edit 态截图）
      可看物：订单详情编辑态截图，Delivery Date 显示 13/08/2026
      定性状态：符合
      证据：见 DEV-REPORT

- [x] M3-3 operator 其余表单/筛选：`customers/[id]`、`place-order`、`purchases`×3、`pricelists/[id]`、`inventory/receive`、`vendor-bills`
      验收命令：`npx tsc --noEmit`、`npm run build`
      可看物：purchases/new 截图
      定性状态：符合
      证据：purchases/new 行内 Best Before 字段验证 Tab/Enter 跳格逻辑（`lib/order-line-keys.ts`）未被破坏——键入日期后按 Enter，值提交为 01/12/2026 且焦点正确跳到下一行「Search product」输入框

- [x] M3-4 dispatch-console：`DriverDispatchTab.tsx`、`BatchTab.tsx`
      验收命令：`npx tsc --noEmit`
      定性状态：符合（代码走查，样式与其余筛选栏一致）
      证据：类型检查通过，模式与已实测的 SalesStats/OdooTable 完全一致

- [x] M3-5 customer-portal：`page.tsx`
      验收命令：`npx tsc --noEmit`
      定性状态：符合（代码走查）

- [x] 全站扫描收口：`grep -rn 'type="date"' app components --include="*.tsx"` 仅剩 2 处注释提及，0 处真实 `<input type="date">`
      验收命令见下
      定性状态：符合

## 验收命令与输出

```bash
$ grep -rn 'type="date"' app components --include="*.tsx" | grep -v "date-picker.tsx\|OdooTable.tsx"
（无输出——全站原生 date input 已清零）

$ npx tsc --noEmit -p tsconfig.json
（无输出——类型检查通过）

$ npm run build
✓ Compiled successfully
```

- [x] `/code-review high` + `/security-review`（大改前必跑）
      验收命令：见 DEV-REPORT.md「/code-review high 与 /security-review」一节
      定性状态：符合
      证据：security-review 无发现；code-review 5 条里 3 条修复（年份位数校验、Enter 静默跳行、OdooTable 字号），2 条确认属于并发会话 `veggie-79` 的 SearchableDropdown 改动，不在本次范围内不处理；修复后 tsc/build 复跑通过

## 已知限制（写进假设清单，未做的事）

- 只替换了「日期选择器」控件本身；订单/报价单详情页非编辑态展示原始 `yyyy-mm-dd` 字符串（如 `2026-08-13`）的地方未改——那是纯文本展示，不是选择器，且 ISO 格式本身无月/日顺序歧义，不在本次「选择器格式」需求范围内。
- dispatch-console、customer-portal 两组因业务数据当天为空（dispatch 无当日波次、customer-portal 需要客户端登录态），未能像 quotations/orders/打印中心那样做到端到端浏览器实测，仅代码走查 + 类型检查 + 与已实测组件完全同构确认，DEV-REPORT 标注为「符合（未逐一截图）」。
