# DEV-PLAN：多 tab 协作不丢数——切回 tab 自动刷新引用数据 + 表单草稿自动保存

日期：2026-10-10（修订版：范围改为全站机械审计结果，不再按对话里举的例子框定）

## 读取了哪些文档

本次无产品文档改动。依据本会话口头对话：

> "客户有这样的一个行为,当前做一个操作(比如创建订单/改商品),改的过程中发现需要去动一下库存/价格表/新增可售单位,就开新 tab 操作，原来的窗口不刷新就不能同步，刷新又会丢已填内容……先把『切回 tab 自动刷新引用数据 + 表单草稿自动保存』这两块出个 DEV-PLAN"
>
> 修订缘由（你的原话）："中途去另一个 tab 去做的事情,和当前这个 tab 做的事情,不仅仅是这几项,不能以我提到例子为准"——第一版按"哪几个页面用了同一个商品选择器"挑了 6 页，这是以我的举例反推范围，确实不对。这一版改成：先定两条跟具体页面/具体数据类型无关的机械规则，再用脚本把全站实际符合规则的页面跑出来，范围由审计结果决定，不是我或你挑的。

## 现状排查 + 全站审计（写在这里，不用你看，是我做技术决策的依据）

**现状**：
- `orders/[id]`、`quotations/[id]`、`place-order` 三个页面已经各自独立写了一份"切回 tab 刷新商品列表"的代码（`window focus` + `visibilitychange` + 30s 节流），三份几乎一字不差——重复代码，该抽成共享 hook；但都只刷新了商品列表本身，页面里其它一起用 `apiGet` 拉回来的数据（价格表、库存提示……）没有一起刷新。
- 全站其余页面**完全没有**这套刷新逻辑，一行都没有。
- 全站**没有任何**页面有"草稿自动保存"或"关闭前未保存提示"（`beforeunload`）——这块是从零建。

**审计方法**（纯脚本扫描，不是我凭印象挑的）：对 `app/[locale]/classic/**/page.tsx` 做了两次结构性扫描——

1. 统计"这个页面里用 `apiGet` 拉过数据"和"这个页面里有 `apiPost/apiPut/apiPatch` 保存动作"的交集 → **44 个页面**既读取数据又有保存动作，这些页面天然存在"数据被别处改了没同步""正在填的内容可能丢"两种风险。
2. 剩下 34 个页面只读不写（报表、看板、打印预览），不存在"丢草稿"的问题，但一样有"数据过时"的问题。

审计口径的局限（诚实写在这，不藏）：这套脚本只扫了 `page.tsx`，没扫组件目录下的大型弹窗（比如上周刚改完的 `PdfExtractDialog.tsx` 那种"页面里弹出来的子表单"）；也只认 `apiGet`/`apiPost` 这几个项目里统一封装的请求函数名，如果哪个页面没用这套封装会被漏统计。这不是"故意漏掉"，是这版审计工具的边界——所以下面两个能力我会做成**随时能挂的通用能力**，不是写死在 44 个页面里，以后发现哪个弹窗/新页面也需要，接入成本是加几行代码，不需要再回来重新审计一遍。

## 模块拆解

### M1：引用数据刷新（规则：不管页面里装的是什么数据，回到这个 tab 就把它"自己原来加载数据那个函数"重新跑一遍）

新增共享 hook `lib/hooks/use-refetch-on-focus.ts`，封装"focus / visibilitychange + 30s 节流"，参数是页面自己已有的"重新加载"函数——**不关心加载的是商品、价格表、库存、客户、司机、设置还是别的什么**，这正是回应"不能按数据类型/页面举例来定"的点：规则只认"这是不是一个数据加载函数"，不认它加载的是哪种数据。

落地分两批，范围由上面的审计结果决定：

- **本轮做（44 个"又读又写"的页面）**：风险最高——正在填东西的同时数据可能过时。按业务区分目录列在附录 B。
- **下一批（34 个只读报表/看板/打印页）**：同一个 hook 直接套用，风险低、不涉及"丢草稿"，归到下一轮做，不是被排除在"全站"范围外，只是优先级靠后——先把会"丢数据"的地方堵住。

### M2：表单草稿自动保存（规则：路由形态是"创建/编辑单条记录"）

新增共享 hook `lib/hooks/use-draft-autosave.ts`。这条不用 useState 数量或我主观判断"重要"，用一条跟具体业务无关的结构规则：**路由是 `.../[id]/page.tsx` 或 `.../new/page.tsx`（以及功能等价的创建页，如 `place-order` 虽然路由没写 new 但就是"新建一条记录"）**——因为只有这种"一次只对着一条记录从头填到尾"的页面，才存在"中途被打断、这一长段输入要不要丢"的问题；列表页/看板页即使状态变量很多，那些大多是筛选器、批量勾选，不是"一份正在写的草稿"。

按这条规则跑出来的清单（附录 B 已标注）：

- `operator/place-order`、`operator/orders/[id]`、`operator/quotations/[id]`
- `operator/purchases/new`、`operator/purchases/[id]`、`operator/purchases/vendors/[id]`
- `operator/pricelists/[id]`、`operator/products/[id]`、`operator/customers/[id]`
- `operator/trips/[id]`、`operator/sorting/[id]`、`driver/trip/[id]`、`sorter/sort/[id]`
- `finance/invoices/[id]`

共 14 个页面，全部接入草稿自动保存。

**机制**（跟第一版方案一致，没有变化）：防抖 2 秒写 `localStorage`，key 带登录用户 id 隔离；新建类页面在首次有内容时生成草稿 id 写进 URL；进页面时如有未过期（3 天）草稿弹条状提示"恢复 / 丢弃"；保存成功立即清掉对应草稿；恢复后的内容照样会被 M1 的刷新校验一遍（比如商品这几天被下架了）。

## schema 设计

无数据库改动，纯前端行为。

## 路由清单

不新增 API 路由。M1 只是把页面已有的 `load()` 调用多一个触发时机（焦点回来时），不新增网络层；M2 完全不碰后端。

## 风险点

- **规模**：M1 本轮涉及 44 个页面、M2 涉及 14 个页面（有重叠），全部是"接入一个现成 hook"这种重复性改动，不是逐页定制逻辑——用一个脚本辅助批量接入 + 人工过一遍每个接入点确认接的是正确的"加载函数"，而不是真的手写 44 次。
- **审计口径漏掉的部分**：组件级大弹窗（如采购单导入弹窗那种）这轮不扫，但两个 hook 是通用能力，后续接入成本低，发现需要随时加。
- **草稿恢复 vs 别处已保存的最新数据冲突**：本轮只解决"我自己没保存的内容不会丢"，不解决"两人同时编辑同一条记录"的并发冲突，那是另一个问题。
- **localStorage 堆积**：3 天自动过期 + 保存成功即清，避免无限堆积。
- **价格表/库存刷新后，已经填进订单行里的单价不会自动重算**——沿用你之前拍板的"换客户要求重新询价"同一条业务规则，这轮不碰。
- **44 个页面全部改动后的回归面很大**：`tsc`/`build` 能挡住类型和编译错误，但"每个页面的焦点刷新接对了函数"这种逐页正确性，无法用一次全局单测覆盖，验收时会抽样用 Playwright 走几个不同业务线的页面（订单/采购/库存/司机各挑一个），其余页面靠代码审查（确认接入的是读取函数、不是误接了别的回调）+ 开发自测，不是每页都录屏。

## 一次性告知（不同意就说）

**歧义清单**：无（这版范围由脚本审计决定，不是靠解读你的话猜的）。

**假设清单**：
- 草稿过期时间取 3 天，按经验值定，没有 PRD 依据。
- 34 个只读报表/看板页面的焦点刷新放下一轮做，不在这轮 44+14 的范围内——如果你觉得这些也该一起做，告诉我，工作量会从"44+14"变成"78+14"。
- 恢复提示用条状通知 + 恢复/丢弃按钮，不用阻断式弹窗，具体长相会先截图确认再接数据。

---

## 附录A：技术验收标准与 verify.sh

**我负责，你不用看。** 退出码即结论，不过不许写完成报告。

```bash
#!/usr/bin/env bash
set -euo pipefail
# scripts/verify.sh --scope multi-tab-sync（追加到现有 verify.sh）

echo "== tsc（覆盖全部 46 个改动文件：44 个页面 + 2 个共享 hook，M2 的 14 页是 44 页的子集） =="
npx tsc --noEmit

echo "== build =="
npm run build

echo "== 单测：useRefetchOnFocus 节流判定（纯函数，项目用 node:test，没有 vitest/jsdom） =="
node --test --import=tsx tests/use-refetch-on-focus.test.ts

echo "== 单测：useDraftAutosave 读写/过期/清除（纯函数，注入 storage 不依赖 DOM） =="
node --test --import=tsx tests/use-draft-autosave.test.ts

echo "== Playwright 抽样：订单/采购/库存/司机各挑一页，走一遍
     『填一半→另开tab改数据→切回来→内容没丢+数据已刷新→不保存直接刷新→
     草稿恢复提示出现→恢复后内容一致』 =="
npx playwright test e2e/multi-tab-draft-sync.spec.ts

echo "== 代码审查清单：44+14 个接入点逐个核对接的是页面自身的加载函数 =="
# 人工过一遍 git diff，不是自动化步骤，但作为验收条目列出，逐条打勾
```

验收口径：
- `tsc`/`build` 全绿是硬门槛。
- 两个共享 hook 必须有单测覆盖节流、localStorage 读写、过期清理，不只靠肉眼判断。
- 抽样页面用 Playwright 跑关键路径，作为能截图/录屏给你看的"可看物"；其余页面的接入正确性靠代码审查记录在案，不是每页都有录屏证据——这点诚实标注，不包装成"全覆盖"。
- 无命令输出的条目标 ⚠️ 未验证，不标 ✅。

---

## 附录B：M1/M2 覆盖清单（按业务线分组，[M2] 标记同时接草稿自动保存的 14 页）

**operator/**
- orders/[id] [M2]、orders/page
- quotations/[id] [M2]、quotations/page
- place-order [M2]
- purchases/[id] [M2]、purchases/new [M2]、purchases/page、purchases/suggestions
- purchases/vendors/[id] [M2]、purchases/vendors/page、purchases/catalog、purchases/annual-plan、purchases/fresh
- pricelists/[id] [M2]、pricelists/page
- products/[id] [M2]、products/page、products/by-sale-unit
- customers/[id] [M2]、customers/page
- trips/[id] [M2]、trips/page
- sorting/[id] [M2]
- drivers/page、settings/page、credit-notes/page、returns/page
- inventory/receive、inventory/discrepancies、inventory/adjustments、inventory/scrap、inventory/zones

**finance/**
- invoices/[id] [M2]、invoices/page、statements/page、vendor-bills/page

**driver/**
- trip/[id] [M2]

**sorter/**
- sort/[id] [M2]

**warehouse/**
- page、stock-take/page

**boss/**
- overview/page、system/backups/page

**restaurant/**
- page

共 44 个页面接 M1，其中 14 个同时接 M2（见上方加粗标记）。

---

回复"确认"后我按这份计划执行，中途不再就实现细节打断你。
