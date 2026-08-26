# DEV-PLAN：账期灵活化 + 加商品重复行修复

## 背景与结论

客户反馈：现有账期（现结/周结/月结三档）太死板，一旦到期就把客户下单卡死，希望会计能有权限灵活延长 1～2 周。

排查代码后发现现状比预想更粗糙，这次要一起解决：

1. **账期档位不全**：`Customer.paymentTerm` 只有 `cash/weekly/monthly` 三档，客户提到的"两周""两个月"目前都不存在。
2. **逾期检测只覆盖月结客户**：`orders/route.ts`、`customers/[id]/credit/route.ts` 里的拦截逻辑是 `if (overdueAmount > 0 && paymentTerm === 'monthly')`，现结/周结客户完全不检查逾期——这本身是个漏洞，与"账期"这个词的字面意思不符。
3. **到期日从未自动算过**：`Invoice.dueDate` 是手填字符串字段，没有任何"开票日 + 账期天数"的推算逻辑。
4. **⚠️ 关键事实（已用生产库核实，20260826）**：生产库 148,285 条 `Invoice` 全部是 2026-07-18 那次 Odoo 迁移一次性导入的历史快照（`createdAt` 精确落在每月 1 日 00:00:00，是批量写入的痕迹），**本月（8月）及此后，Invoice/Statement/Payment 三张表新增记录数都是 0**。也就是说，现在这套"逾期 → 拦截下单"机制，判断依据是一份从生产上线后就没再更新过的历史快照——不管客户是否已经把陈年欠款还清，系统都不知道，因为没有新的开票/收款记录进来刷新它。
   → 这次做的"会计延期"，本质是在这份可能已经过时的自动判断之上，给会计一个**可控、留痕的手动豁免入口**，不是把整条开票/收款流程修好（那是另一个大得多的项目，不在本次范围）。这点必须让你知道，避免做完了才发现"拦截其实很久没真正拦过"。
5. **会计"绕过"目前不是正式功能**：`orders/route.ts:239` 硬编码 `['BOSS', 'FINANCE'].includes(user.role)` 就能无条件绕过所有信用检查，没有审批记录、没有时效——本次要把它换成一个真正的"延期审批"操作。

## 本次范围（已与你确认）

- 延期作用对象：**客户整体**（不是单张发票）——延长后这段时间内该客户所有订单都不因逾期/超额度被拦，到期自动恢复
- 放宽范围：**逾期拦截 + 信用额度超限拦截，一起放宽**
- 延长时长：**+1周 / +2周 预设按钮 + 自定义天数输入**，都要求填备注
- 账期档位：**扩展为现结 / 周结 / 双周结 / 月结 / 双月结 五档**，到期日按固定天数（0/7/14/30/60）自动从开票日推算，不按自然月对齐
- 逾期检测覆盖所有账期类型（不再只查月结）

**明确不做**：
- 不重建开票/收款（Invoice/Statement/Payment）自动生成流程——这是本次发现的更大的问题，先记录，不在本轮解决
- 不改 `Order.paymentTerm`（订单级覆盖，目前是自由文本、不参与信用拦截）——继续保持纯展示用途
- 不做到期提醒/通知（到期自动发消息给会计之类）

## 模块拆解

### 1. 数据层（schema 改动）
- `Customer` 新增：`termExtendedUntil DateTime?`、`termExtendedNote String?`（当前生效的延期状态，用于下单时快速判断，不用每次查历史表）
- 新表 `CustomerTermExtension`（审计履历，谁在什么时候批了多少天、备注）：`id / customerId / days / until / note / createdBy / createdByName / createdAt`
- `paymentTerm` 保持 `String` 类型不变（不改数据库层枚举，改动小），但收敛前端可选值为 5 档，并在 `lib/payment-terms.ts` 里定义唯一口径的天数映射表

### 2. 共享逻辑（新增 lib）
- `lib/payment-terms.ts`：`PAYMENT_TERM_OPTIONS`（5 档 value/label/days）+ `computeDueDate(baseDate, paymentTerm)`
- `lib/credit-check.ts`：把现在重复在 `orders/route.ts` 和 `customers/[id]/credit/route.ts` 里的两份信用校验代码合并成一个函数，覆盖所有账期类型（非 cash 即检查），并加入 `termExtendedUntil` 判断——今天 ≤ `termExtendedUntil` 时两类拦截都跳过

### 3. API
- `POST /api/customers/[id]/term-extension`（新增）：写 `CustomerTermExtension` + 更新 `Customer.termExtendedUntil/termExtendedNote`，写 action-log，需要新权限点
- `GET /api/customers/[id]/credit`：改用 `lib/credit-check.ts`，返回里加 `termExtendedUntil`
- `POST /api/orders`：信用校验部分改用共享函数，去掉硬编码的角色绕过（改成"是否在延期豁免窗口内"这一条件，BOSS 仍保留特批能力但走同一套函数，不再是裸角色判断）
- `POST /api/invoices`：`dueDate` 未显式传入时，按 `customer.paymentTerm` 自动推算

### 4. 权限（RBAC）
- `lib/rbac/catalog.ts` 的 `master.customer` 模块加一个新 action：`extend_term`（"延长账期"）
- `prisma/seed-rbac.json`：默认授予 `FINANCE`、`BOSS`

### 5. 前端
- 客户详情页（`.../customers/[id]/page.tsx`）：`paymentTerm` 下拉从 3 档扩到 5 档；有生效延期时显示"账期已临时延长至 X，操作人 Y"；新增"延长账期"按钮（仅持有 `master.customer.extend_term` 的用户可见），弹出 +1周/+2周/自定义天数 + 备注
- 下单页信用面板（place-order / quotations 里展示 Outstanding Balance / Credit Limit / Payment Terms 的那块）：有生效延期时加一行提示，说明当前是"临时豁免中"

## 路由/文件清单

新增：
- `lib/payment-terms.ts`
- `lib/credit-check.ts`
- `app/api/customers/[id]/term-extension/route.ts`
- 一条 Prisma 迁移

修改：
- `prisma/schema.prisma`
- `app/api/customers/[id]/credit/route.ts`
- `app/api/orders/route.ts`
- `app/api/invoices/route.ts`
- `lib/rbac/catalog.ts`、`prisma/seed-rbac.json`
- `app/[locale]/classic/operator/customers/[id]/page.tsx`
- `app/[locale]/classic/operator/place-order/page.tsx`
- `app/[locale]/classic/operator/quotations/[id]/page.tsx`（如有同款信用面板）

预计 11 个文件。

## 验收标准

- `npm run build` 无报错，迁移在本地 dev 库跑通
- 客户详情页能看到 5 档账期下拉；"延长账期"按钮只有 FINANCE/BOSS 可见，其他角色调用接口应返回 403
- 造一个测试客户：置为逾期 + 超额度 → 验证下单被拦截 → 会计延期 2 周 → 验证下单放行，且欠款数字仍如实显示（不是隐藏，只是不拦）→ 手动把 `termExtendedUntil` 改到过去 → 验证恢复拦截
- 开一张新发票不传 `dueDate` → 验证按客户账期自动推算出正确日期
- 现结/周结客户在有逾期发票时也会被正常检测到（验证之前的漏洞已堵上）

---

# 追加模块：Quotation / Sales Order 加商品出现重复行、价格不一致

客户反馈：改了商品库之后，去建 Quotation / Sales Order 选品经常出问题；截图具体现象：
1. 同一个商品（Broccoli 6KG CASE，internalRef BRC）在订单里出现两行：Row1 单价 €6.33（来源 Manual），Row2 单价 €17.50（来源 Default），系统弹出 "Duplicate product alert" 提示需要手动 Merge
2. 商品搜索下拉里 "Broccoli 5KG CASE 5kg [BRKG]" 这一项看起来是灰置/不可选状态，客户说"重新进入、也刷新过"依然如此

## 现状核实（已排查代码，20260826）

- **两个页面代码其实早就统一了**：20260818（commit `9053868`）已经把 Quotation 和 Sales Order 的"加商品"交互合并成同一个共享组件 `useInlineProductPicker` + `OrderLineEditor`，两页此后用的是**同一份代码**，商品列表都是"打开页面时拉一次 + 切回 tab 时最多 30 秒节流重拉"，没有发现 Sales Order 缺 Quotation 特有的刷新机制——用户"sales order 没有像 quotation 一样修改加载机制"这个判断，从当前代码看不成立，两页现在是同构的。
- **候选项"灰置"在现有源码里找不到对应实现**：下拉列表渲染代码（`components/classic/useInlineProductPicker.tsx:262-277`）里所有候选项样式一致，没有基于 `canBeSold`/`active`/库存状态的禁用渲染；`internalRef` 那行小字固定是灰色，但这是所有候选项统一的样式，不是单独禁用某一项。不可售商品会被 API 整条过滤掉，不会以"灰色可见但不可点"的形式出现。**这一点需要用浏览器实测复现才能确认到底是什么——现有源码里定位不到对应逻辑**，怀疑要么是把统一的灰色小字误认成禁用态，要么是浏览器裝了旧的静态资源缓存（不是代码 bug）。
- **⚠️ 但排查过程中找到一个真实、可复现的 bug**（跟用户截图现象吻合）：`selectProductIntoLine`（`orders/[id]/page.tsx:495-537`、`quotations/[id]/page.tsx:459` 起，两页逻辑一致）在把选中的商品塞进订单行时，**完全不检查这个商品是不是已经在当前订单里有一行了**——每次选中都无条件新增一行，价格现算（走 `resolveCustomerPrice` 或客户价目表）。所以如果订单里已经有一行 Broccoli（比如之前手动改过价 →`Manual` €6.33），操作员再从下拉里选一次同一个商品，就会凭空多出一行、用当前定价规则重新算出一个新价格（`Default` €17.50）——这正是截图里 Row1/Row2 的由来。现有的"Duplicate alert + 手动 Merge"只是**事后**提醒，不能阻止重复行产生，也不能保证 Merge 之后价格是对的（两行价格来源都不一样，Merge 该保留哪个价格也没定义）。

## 补充范围（20260826 二次修正：识别键要带上单位）

客户指出一个我最初漏想的点：**同一个商品选两个不同可售单位（比如 2×CASE + 5×1KG）是合法的两行，不该被当成重复、也不该被合并**——"重复"与否的判断依据必须是"**商品 + 可售单位**"这个组合，不能只看商品。这也意味着现有的 `duplicateCounts` 检测逻辑本身还有一个既有 bug：目前只按 `productId` 计数（`orders/[id]/page.tsx:193-198`、`quotations/[id]/page.tsx:102-107`），今天如果有人正常地给同一商品配两个不同单位下单，系统就会误报"重复"——这个要一并修掉，不只是"选择时合并"这一半。

- 修 `duplicateCounts`：识别键从 `productId` 改成 `` `${productId}__${uomId}` ``，避免同商品不同单位被误判重复
- 修 `selectProductIntoLine`：选中一个订单里已存在（**同 `productId` 且同 `uomId`**）的行时，不再新增一行，直接给已有行数量 +1；商品相同但单位不同则正常新增一行，不触发合并、不触发 Duplicate 提示
- 涉及文件：`components/classic/useInlineProductPicker.tsx`（或调用它的三个页面各自的 `selectProductIntoLine`，具体由实现时确认是否已经在共享 hook 里）、`orders/[id]/page.tsx`、`quotations/[id]/page.tsx`、下单新建页（如同样受影响）
- "候选项灰置不刷新"这一条**先不写修复代码**，开发时用浏览器实测复现一次（改个商品名/单位 → 立刻去下单页搜索 → 观察是否真的显示旧数据/灰置），确认现象后再决定是缓存问题还是别的；如果实测复现不了，就在报告里如实说明，不能凭代码推测就说"已修复"

## 3KG 规格价格算错（20260826 新增，已用生产库坐实是缓存问题）

客户截图：商品 "Broccoli 5KG CASE 5kg" 在一张未保存的订单里切到 3KG 规格，界面显示 Unit Price = €11.98，客户质疑算错了。

**排查过程**：先查清楚"切换单位"这一步真正调用的代码——`quotations/[id]/page.tsx:231-274` 的 `switchLineUnit`：先查价格表链有没有专门限定这个单位的规则（命中就直接用价格表的价，不叠加换算系数），没命中才退回 `priceOf(rows, newUomId, basePrice)` 按 `ProductSaleUom.factor + 加价/折扣` 换算。用生产库把这条链上所有数据都查了一遍坐实：
- 这个商品当前 `listPrice=15.00`、3KG 那行 `factor=0.59988、surcharge=1.50`——按公式应该是 15×0.59988+1.50≈**€10.50**
- 客户绑定的价格表 "CITY CENTREtest"（含它链式引用的备用表 "M7N3M1test"）逐条查过，**都没有一条规则是配给这个商品的**，所以确定走的是 `priceOf` 这条换算路径，不是价格表命中
- 但 €10.50 ≠ 客户看到的 €11.98，两个数都对不上——于是查了这个商品的操作日志（`ActionLog`）：**这个商品今天（20260826）被连续编辑了 7 次，主档和可售单位交替改了 00:35 / 01:24 / 01:25 / 01:42 / 01:43 五个时间点**，跟客户截图的时间高度重合

**结论**：€11.98 用现在数据库里的"最终版"数值反推不出来，但从操作日志看，这个商品在客户截图前后正被反复编辑——**€11.98 极可能是订单页缓存的旧版本商品/可售单位数据（编辑到一半的中间值）算出来的，客户编辑商品之后没有等订单页刷新缓存就去切单位**，这跟前面"候选项灰置不刷新"怀疑的是同一个根因，现在有了更硬的证据（操作日志时间线），不再是纯猜测。

**补充范围**：把"候选项灰置不刷新"和这条合并成一个问题来修——现有"打开页面拉一次 + tab 切回 30 秒节流"这套缓存策略，对客户"编辑商品 → 马上回订单页测试"这种同一浏览器会话内的高频操作根本不够用。开发时要做的：
1. 打开商品选择下拉框时，强制重新拉一次最新商品列表（不再依赖 30 秒节流），从源头避免用旧数据
2. `switchLineUnit` 这类直接使用 `saleUomOptions` 缓存算价的地方，评估要不要在切换单位时也顺带刷新一下这个商品的最新 `ProductSaleUom` 配置，而不是全程信任页面打开时那一份
3. 附带发现一个小 bug：切换单位后 `priceSourceType` 被强制清空成 `null`（`quotations/[id]/page.tsx:270`），`lib/price-source.ts` 把空值渲染成灰色文字，看起来很像"Default"来源，但其实只是"来源信息被清掉了"，不是真的重新判定过来源——这个也顺手修，切完单位应该如实反映这行价格到底是通过 pricelist 命中的还是走 factor 换算的，不能显示一个假来源标签误导操作员

## 价格表 ↔ 可售单位关系（20260826 已核实并与客户对齐，不需要开发）

客户原本担心"新增可售单位后价格没同步回价格表"。核实代码后确认：这套级联机制**已经是现在的真实实现**，不需要额外开发——

- 价格表(Pricelist)规则默认不限定单位（`uomId` 留空），对该商品**所有**可售单位都生效，等于只维护一份"基础价"
- 新增可售单位并配好换算系数(factor)后，下单选这个新单位时，系统会自动拿"价格表基础价 × 该单位 factor"实时算出最终价（`lib/server-pricing.ts` 的 `scaleAuthoritativePrice`），标签仍是 Plist，不需要、也不应该反向写回价格表
- 只有价格表对某个单位**单独配了专属规则**（`PricelistItem.uomId` 显式指定）时，那条规则的价格才会原样生效、不再叠加 factor——这是刻意的"精确覆盖优先于公式换算"设计，同样不需要同步
- "Manual"标签只在"人工改价 + 有改价权限"时出现，跟新增可售单位无关；客户截图里那两行 Manual/Default 价格不一致，成因是选品重复新增了一行（见上一节），不是价格表和可售单位没同步

⚠️ **但排查过程中发现级联这一层本身有真 bug，需要修**：算"基础价 × 该单位 factor"这件事，代码里其实有两份不同实现，算出来的结果不一样——
- `lib/sale-uom.ts` 的 `priceOf()`（前端实时预览用）：`priceMode='FORMULA'` 时是 `基础价 × factor × (1+折扣%) + 加价`，把可售单位自己配的加价/折扣算进去了
- `lib/server-pricing.ts` 的 `scaleAuthoritativePrice()`（后端保存订单时的权威算价）：只算 `基础价 × factor`，**完全没有管 `priceDiscountPct`/`priceSurcharge`**，同一个可售单位保存前后能算出两个不同数字
- 影响面：只要某个可售单位配的是 FORMULA 模式、且 discount%或surcharge 不是 0（从抽查的几个商品看这很常见，比如前面 Broccoli 系列的 1KG/3KG 都配了 surcharge），保存后的价格就会跟界面上预览/操作员看到的对不上——这可能是客户反馈"价格不对"的一个共同成因，需要修 `scaleAuthoritativePrice` 让它跟 `priceOf` 用同一套公式（或者干脆直接复用 `priceOf`，别再维护两份）

## Pricelist Items 页面未显示实际售价（20260826 新增）

客户反馈：价格表详情页（`app/[locale]/classic/operator/pricelists/[id]/page.tsx`）的商品明细表格，大部分行的"Price"列（表头是空白的，容易被忽略）显示的是"0.0% discount and 5.0 surcharge"这种公式描述文字，看不出这个商品在这张价格表下实际卖多少钱，只有配了固定价(`computeType='fixed'`)的少数行才直接显示数字。

**现状核实**：`page.tsx:811-815` 的 `ItemRow` 组件，`computeType==='fixed'` 才显示 `€${fixedPrice}`，`computeType==='formula'`（大多数行）只是把 `priceDiscount`/`priceSurcharge` 原样拼成文字，从未调用任何函数把它解析成具体金额。折扣/加价的计算基准由 `formulaBase`（`list_price`=Public Price 列 / `standard_price`=Cost 列）决定，真正的计算公式在 `lib/pricing-engine.ts` 的 `computeItemPrice`（162-232行，内部函数未导出）：`基准×(1-折扣%) → 按舍入规则取整 → +加价 → 按 min/max 利润夹取`。Cost/Public Price 两列是页面实时联查 `Product.standardPrice`/`Product.listPrice` 显示的，不是快照。

**补充范围**：把 `computeItemPrice` 导出（或包一层同名调用），在 formula 模式的行里也算出并显示一个"预计售价 ≈ €X.XX"，公式文字作为补充说明保留，不删——这样运营一眼就能看出实际卖多少钱，不用自己拿 Cost/Public Price 手算。**必须复用 `computeItemPrice` 这同一份计算逻辑**，不能照公式抄一份新的，否则又会重蹈上面 `scaleAuthoritativePrice` 那种"两份实现算出两个数字"的覆辙。

---

📋 计划已生成，请确认：账期模块「本次范围」和「⚠️ 关键事实」两节，尤其第 4 点（逾期拦截吃的是停更的历史快照）你是否知情。商品/订单相关的四个补充模块（重复行识别键、价格表关系、3KG 缓存问题、Pricelist Items 未显示实际售价）都已核实清楚，不再需要额外拍板。

确认无误后回复"确认，开始开发"，我按 数据层 → API → 页面 顺序开发（模块分开提交，账期模块改动最大，先做；商品选择器缓存刷新那个改动最小、影响客户最直接，可以考虑最先上）。
