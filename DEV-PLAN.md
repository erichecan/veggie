# DEV-PLAN：全站日期选择器格式改为「日-月-年」

## 读取的文档

无独立产品文档。需求来自 2026-09-22 用户发来的截图批注（打印中心「配送日期」筛选框显示 `09/13/2026`，即月-日-年），批注原文：

> 配送中心、quotation、sale order 日期格式
> 日月年
> 请你检查全站的日期选择器，现在的格式是月-日-年，请全部都改成 日-月-年

已存档：`docs/20260922-date-picker-dmy-需求原话.md`（原始截图批注逐字记录）。

---

## 根因

全站的日期选择器全部是原生 `<input type="date">`。这类控件的显示格式（月-日-年 还是 日-月-年）由**浏览器/操作系统的 locale** 决定，页面代码（HTML、CSS、`<html lang>` 属性）**无法覆盖**——已核实全项目 14 个 layout 文件都没有设置过 `lang`，也没有任何代码尝试 hack 这个格式。

结论：唯一可行路径是放弃原生 `<input type="date">`，换成自己渲染的日期选择器组件（文本框固定显示 `DD/MM/YYYY` + 点击弹出日历选择），格式完全由前端代码控制、不再受用户浏览器/系统设置影响。

## 调研结果：全站分布

全项目搜出 **43 处**原生 `type="date"`，分布在 **24 个页面文件 + 2 个共享组件**：

| 分组 | 文件 | 处数 |
|---|---|---|
| **共享组件（改一处惠及多页）** | `components/classic/OdooTable.tsx`（列头日期区间筛选，orders + quotations 列表页共用） | 2 |
| | `components/boss/analytics-shared.tsx`（boss 报表系列的 DateRangePicker） | 2 |
| boss 报表 | `procurement-analysis/page.tsx`、`sales-report/page.tsx`、`sales-analysis/page.tsx` | 2+2+4=8 |
| finance | `driver-reports/page.tsx`、`statements/page.tsx` | 2+2=4 |
| operator | `customers/[id]/page.tsx`、`place-order/page.tsx`、`purchases/page.tsx`、`purchases/new/page.tsx`、`purchases/[id]/page.tsx`、`pricelists/[id]/page.tsx`、`inventory/receive/page.tsx`、`quotations/page.tsx`、`quotations/[id]/page.tsx`、`vendor-bills/page.tsx`、`orders/page.tsx`、`orders/[id]/page.tsx` | 2+1+2+3+2+2+2+3+1+1+2+1=22 |
| dispatch-console | `DriverDispatchTab.tsx`、`BatchTab.tsx` | 2+1=3 |
| daily-sales（**截图那处在这里**：`PrintCenter.tsx:962` 配送日期筛选） | `PrintCenter.tsx`、`SalesStats.tsx`、`ShortageHandler.tsx` | 1+2+1=4 |
| customer-portal | `page.tsx` | 1 |

现状确认：`components/ui/` 下**没有**任何自定义日期组件（shadcn 的 `calendar.tsx` 从未生成过）；`package.json` 也**没有**装 `react-day-picker`/`date-fns` 等日期库。这次要从零建组件。

---

## 模块拆解

### M1 · 基础组件（前置，其余模块都依赖它）

- `npm install react-day-picker`（React 19.2.4 / Next 16.2.3 均兼容 v9；纯前端包，不依赖任何云服务，符合项目部署铁律——迁到客户服务器后原样能跑）
- 新增 `components/ui/calendar.tsx`：shadcn 标准 calendar 封装（基于 react-day-picker + 现有 `popover.tsx`）
- 新增 `components/ui/date-picker.tsx`：单日期选择器。对外接口刻意贴近原生 input，最小化调用方改动：
  ```ts
  <DatePicker value={string /* yyyy-mm-dd，与原生 input.value 完全一致 */}
              onChange={(value: string) => void}
              min?: string; max?: string; disabled?: boolean; className?: string />
  ```
  内部文本框固定按 `DD/MM/YYYY` 显示和录入（支持直接键入数字，不强制只能点日历——采购单/价格表这类要选一年前日期的场景，纯点日历翻页体验很差）；对外暴露值、写库/传参格式完全不变（仍是 `yyyy-mm-dd`），后端和现有 state 逻辑零改动。

### M2 · 共享筛选组件（一次改动覆盖多页）

- `components/classic/OdooTable.tsx:381-397` 列头日期区间筛选 → 换成两个 `DatePicker`（From/To）。**这一处改完，orders 列表页和 quotations 列表页的日期筛选自动一起改好**。
- `components/boss/analytics-shared.tsx:60-66` 的 `DateRangePicker` → 内部两个原生 input 换成两个 `DatePicker`。**boss 报表系列的区间筛选自动一起改好**（procurement-analysis、sales-report、sales-analysis 里凡是调用这个组件的地方不用再单独改）。

### M3 · 逐页替换剩余内联 input（21 个文件，约 39 处）

按目录分批执行，每批做完跑一次 `tsc --noEmit`：

1. **daily-sales**（优先，截图点名）：`PrintCenter.tsx`、`SalesStats.tsx`、`ShortageHandler.tsx`
2. **orders / quotations 详情页**（截图点名）：`orders/[id]/page.tsx`、`quotations/page.tsx`（表单内联那处）、`quotations/[id]/page.tsx`
3. **operator 其余表单/筛选**：`customers/[id]`、`place-order`、`purchases`×3、`pricelists/[id]`、`inventory/receive`、`vendor-bills`
4. **dispatch-console**：`DriverDispatchTab.tsx`、`BatchTab.tsx`
5. **customer-portal**：`page.tsx`
6. **boss/finance 剩余非区间用法**（如有单日期而非区间的遗漏点）复查一遍 M2 是否已全覆盖

---

## 风险点

1. **交互习惯改变**：原生 date input 支持方向键微调数值、移动端弹出系统原生日历；换自定义组件后要保证「可直接键入 8 位数字」+「点击弹出日历」两条路都通，否则选历史日期（如价格表生效日期、库存到货日期）体验会变差甚至更慢。
2. **对外契约不能破**：43 处调用方目前都是 `value`/`onChange(e.target.value)` 读写 `yyyy-mm-dd` 字符串；新组件必须保持这个契约，否则会牵连到 state 管理、URL 查询参数、API 请求体等大量下游代码。**只换 UI，不碰数据流。**
3. **遗漏风险**：43 处分散在 26 个文件，人工替换容易漏改；用 `grep -rn 'type="date"'` 计数归零作为 verify.sh 断言项，机器兜底。
4. **新依赖**：`react-day-picker` 是新增 npm 包，纯前端、无云服务依赖，符合 [[deploy-target-is-own-server-20260802]] 铁律，不在禁止清单内。

---

## 附录 A · 技术验收标准（我负责，用户不用看）

`scripts/verify.sh` 追加以下断言：

```bash
# 1. 全站原生 date input 必须清零
count=$(grep -rn 'type="date"' app components --include="*.tsx" | wc -l)
[ "$count" -eq 0 ] || { echo "❌ 仍有 $count 处原生 type=date 未替换"; exit 1; }

# 2. 类型检查
npx tsc --noEmit

# 3. 构建
npm run build

# 4. 抽样浏览器实测（Playwright，人工触发一次，非 CI 常驻）
# 覆盖：PrintCenter 配送日期、orders 列表筛选、orders/[id] 详情、
#      quotations 列表筛选、quotations/[id] 详情、purchases/new
# 断言：① 文本框显示 DD/MM/YYYY ② 选中日期后原有筛选/表单逻辑正常触发
#      ③ 键盘直接输入 8 位数字能改日期，不是必须点日历
```

铁律：以上跑不通不出 DEV-REPORT.md；截图/浏览器实测没做的点位，报告里标 ⚠️ 未验证，不写 ✅。

---

## 任务台账

大于 30 分钟，按第十二节协议建台账：`docs/20260922-date-picker-dmy-tasks.md`（确认后创建，逐条勾选）。
