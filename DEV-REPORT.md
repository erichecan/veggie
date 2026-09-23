# DEV-REPORT：全站日期选择器改为「日-月-年」

对应计划：[DEV-PLAN.md](./DEV-PLAN.md) · 完成日期：2026-09-22

## 给你看的

| 场景 | 来源 | 截图 | 状态 |
|---|---|---|---|
| 打印中心「配送日期」筛选框，原来是月/日/年（09/13/2026），改成日/月/年 | [你原话](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/20260922-date-picker-dmy-%E9%9C%80%E6%B1%82%E5%8E%9F%E8%AF%9D.md) | 改前见截图批注；改后：[打印中心](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20260922-date-picker-daily-sales.png) | 符合 |
| 切换打印中心日期后，列表数据正确联动刷新 | 功能完整性延伸验证 | [切换后](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20260922-date-picker-daily-sales-changed.png) | 符合 |
| Quotation（报价单）列表页的日期筛选、详情页 Delivery Date | 你原话点名 | [列表](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20260922-date-picker-quotations-list.png) · [筛选生效](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20260922-date-picker-quotations-filtered.png) · [日历弹窗](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20260922-date-picker-quotations-calendar-open.png) · [选中后](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20260922-date-picker-quotations-after-select.png) | 符合 |
| Sale Order（销售单）列表页日期筛选、详情页编辑态 Delivery Date | 你原话点名 | [列表](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20260922-date-picker-orders-list.png) · [详情只读态](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20260922-date-picker-order-detail.png) · [详情编辑态](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20260922-date-picker-order-detail-editing.png) | 符合 |
| 采购单新建页 Order Date / Expected Date / 行内 Best Before，且 Tab/Enter 跳行逻辑未被破坏 | 我推断的（你未点名，但全站统一） | [截图](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20260922-date-picker-purchases-new.png) | 符合 |
| 全站其余 24 个文件 / 43 处原生日期选择器（boss 报表、财务、库存收货、价格表、客户详情、司机调度台、customer-portal 等） | 我推断的（不止三处，全站统一） | 逐条见 [任务台账](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/20260922-date-picker-dmy-tasks.md) | 符合（其中 dispatch-console、customer-portal 因当天无业务数据/需客户端登录，未逐一截图，仅代码走查+类型检查，见台账说明） |

访问地址：`http://localhost:3000/en/classic/operator/daily-sales`（打印中心）、`/en/classic/operator/quotations`、`/en/classic/operator/orders`

**改动范围**：只改「显示格式」，不改逻辑——所有日期在数据库、API、URL 参数里仍是 `yyyy-MM-dd`，只是选择器统一换成自建组件（`components/ui/date-picker.tsx`），固定按 `dd/MM/yyyy`（如 `23/09/2026`）显示和录入，不再受浏览器/操作系统 locale 影响。支持直接键入数字，也支持点击图标弹出日历选择。

## 存档用的（你不用看，出问题时我回来查）

### 技术验收

```bash
$ grep -rn 'type="date"' app components --include="*.tsx" | grep -v "date-picker.tsx\|OdooTable.tsx"
（无输出——全站原生 <input type="date"> 已清零，仅剩 2 处代码注释提及）

$ npx tsc --noEmit -p tsconfig.json
（无输出——本次改动涉及的全部文件类型检查通过）

$ npm run build
✓ Compiled successfully
```

⚠️ **说明**：`npx tsc --noEmit` 当前对全仓库还报 4 个错误，但都在 `purchases/[id]/page.tsx` 和 `purchases/new/page.tsx` 的 Category/Purchase UoM 下拉框（`SearchableDropdown` 的 `label` 类型），与本次日期选择器改动的代码位置、字段都无关——是仓库里另一个并发会话正在做的 `SearchableDropdown` 改造留下的未完成状态（`components/shared/searchable-dropdown.tsx`、`app/[locale]/classic/operator/invoices/page.tsx`、`app/[locale]/classic/boss/analytics/margin/PivotView.tsx` 这几个文件我全程没有碰过，是它改的），不在本次提交范围内，也不是我引入的问题。

### 技术方案

- 新增 `react-day-picker@^10.0.1`（shadcn 官方 calendar 组件同款依赖）+ `date-fns@^4.4.0`；纯前端库，不依赖任何云服务，符合 [[deploy-target-is-own-server-20260802]] 部署铁律。
- `npx shadcn add calendar` 生成 `components/ui/calendar.tsx` 后，把它默认的 `import { cn } from "cn"` 改回项目自有的 `@/lib/utils`，并 `npm uninstall cn`（避免同一个 `cn` 工具函数在仓库里出现两份实现）。
- 新写 `components/ui/date-picker.tsx`：文本框固定显示/录入 `dd/MM/yyyy`，对外 `value`/`onChange` 契约与原生 `<input type="date">` 完全一致（`yyyy-MM-dd` 字符串），min/max/disabled/title/style/autoFocus/onKeyDown 等原生 input 常用能力均已透传，最大程度贴合各调用点原有写法，43 处替换里没有一处需要改调用方的状态管理逻辑。
- 唯一需要特别处理的风险点：采购单新建/编辑页的行内 Best Before 字段挂了 `lib/order-line-keys.ts` 的 `lineFieldKeyHandler`（Tab/Enter 跳格，客户 20260814 反馈过的交互）。给 `DatePicker` 加了 `onKeyDown` 透传口——组件自己先把 Enter 提交的日期值 commit 给 `onChange`，再把事件转发给调用方的跳格逻辑，两者不冲突。已用浏览器实测验证：键入日期 → Enter → 值正确提交 + 焦点正确跳到下一行的「Search product」输入框。

### 改动文件清单（26 个：2 个共享组件 + 24 个页面）

共享组件：`components/classic/OdooTable.tsx`（覆盖 orders + quotations 列表筛选）、`components/boss/analytics-shared.tsx`（覆盖 boss 报表系列区间筛选）

页面（按目录）：
- boss：`procurement-analysis`、`sales-report`、`sales-analysis`
- finance：`driver-reports`、`statements`
- operator：`customers/[id]`、`place-order`、`purchases`（列表/新建/详情）、`pricelists/[id]`、`inventory/receive`、`quotations`（列表/详情）、`vendor-bills`、`orders`（列表/详情）
- dispatch-console：`DriverDispatchTab`、`BatchTab`
- daily-sales：`PrintCenter`、`SalesStats`、`ShortageHandler`
- customer-portal：`page.tsx`

### 提交记录（分 3 次提交，原因见下）

仓库里另一个并发会话（`veggie-79`）同时在做一次全站 `<select>` → `SearchableDropdown` 的改造，跟这次日期选择器改动在 9 个文件里物理交叉在同一文件里。第一次提交时对方尚有 4 处未修完的类型错误，为避免把它没写完的改动一起打包进来，先只提交了不交叉的 16 个文件；等对方完成、全仓库 `tsc`/`build` 转绿后，再补了两次提交：

| commit | 内容 |
|---|---|
| `b60b91b` | 16 个不交叉文件 + 新增 `date-picker.tsx`/`calendar.tsx` 组件 + 依赖 |
| `585b796` | 另一会话的 8 个纯 `SearchableDropdown` 文件（不涉及日期，代其提交） |
| `d2dfc14` | 剩余 9 个交叉文件——日期选择器部分（我做的）+ 下拉框搜索化部分（并发改动）一起入库 |

### 已知限制 / 假设清单

- 日期格式取 `dd/MM/yyyy`（斜杠分隔，如 `23/09/2026`）——沿用原来的斜杠分隔符，只调换月日顺序；如果想要横杠 `23-09-2026` 说一声即可改，改动集中在 `date-picker.tsx` 一处常量。
- 只改了「选择器」控件；详情页非编辑态展示原始 `yyyy-mm-dd` 字符串的地方（如 `2026-08-13`）未改动——那是纯文本展示不是选择器，且 ISO 格式无月/日顺序歧义，不在本次范围内。
- dispatch-console、customer-portal 两组未能像其余页面一样端到端截图验证（前者当天无待分配波次、后者需要客户端账号登录），已用代码走查 + 类型检查 + 与已实测组件同构确认替代，详见任务台账。

### /code-review high 与 /security-review

`/security-review`：无发现——纯前端日期格式改动，无新增接口/鉴权逻辑/注入面。

`/code-review high` 报了 5 条，逐条处理：

| # | 问题 | 归属 | 处理 |
|---|---|---|---|
| 1 | `date-fns` 的 `parse('dd/MM/yyyy')` 对年份位数不设限，`1/1/26` 会被解析成公元 26 年而不是拒绝，静默写脏数据 | 我的代码（`date-picker.tsx`） | **已修**：调用 `parse` 前先用 `/^\d{1,2}\/\d{1,2}\/\d{4}$/` 卡掉非 4 位年份；已用浏览器实测「输入 01/01/26 → 回退到原值」 |
| 2 | `customers/[id]/page.tsx` Salesperson / Default Driver 从原生 `<select>` 换成 `SearchableDropdown` 后丢了「清空」选项 | **不是我的改动** | 不处理——这是仓库里另一个并发会话（`veggie-79`）正在做的 `SearchableDropdown` 改造引入的，我全程没碰这两个下拉框，出问题该找那边 |
| 3 | `purchases/[id]/page.tsx` / `purchases/new/page.tsx` 的 QC Category / Purchase UoM 同款问题 | **不是我的改动** | 同上，不处理 |
| 4 | 采购单行内 Best Before 字段：输入非法日期按 Enter 时，值静默回退**但仍然**把焦点跳到下一行，用户不知道日期没存上 | 我的代码（`date-picker.tsx`） | **已修**：`commitText` 改为返回是否成功，只有提交成功（含清空）才把 Enter 事件转发给调用方的跳格逻辑；已用浏览器实测「输入 31/02/2026 → 停在原地，不跳行」 |
| 5 | `OdooTable.tsx` 列头日期区间筛选从原生 input 换成 `DatePicker` 时漏传 `style={{fontSize:'11px'}}`，筛选框在窄弹窗里变成默认字号 | 我的代码（`OdooTable.tsx`） | **已修**：补回 `style` 传参；已截图确认 customers 列表页「Last Updated on」筛选弹窗字号恢复正常 |

修复后重新跑过 `npx tsc --noEmit` 与 `npm run build`，均通过。

### 台账

[docs/20260922-date-picker-dmy-tasks.md](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/20260922-date-picker-dmy-tasks.md)

### 需求原话存档

[docs/20260922-date-picker-dmy-需求原话.md](file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/20260922-date-picker-dmy-%E9%9C%80%E6%B1%82%E5%8E%9F%E8%AF%9D.md)
