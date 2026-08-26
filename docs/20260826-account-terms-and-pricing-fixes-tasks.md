# 20260826 账期灵活化 + 商品/定价修复 —— 任务台账

来源：DEV-PLAN.md（同日）。按模块拆成可独立验证单元，一个周期做一条，做完验证、提交、回写状态再进下一条。

## 模块 A：商品选择器缓存刷新 + 价格来源标签 ✅ 20260826 完成

- [x] A1. 打开商品选择下拉框时强制重新拉取商品列表，不再只依赖 30 秒节流
  - 实现：`useInlineProductPicker` 加 `onActivate` 回调，`OrderLineEditor` 透传为 `onPickerActivate`，三个页面（place-order/quotations/[id]/orders/[id]）都接了 `fetchLatestProducts`
- [x] A2. `switchLineUnit` 切单位后不再把 `priceSourceType` 清空/放着不管，如实标成 PRICELIST 或 DEFAULT
  - 更正：原计划以为空值会显示成误导性的"Default"，实测代码 `lib/price-source.ts` 空值其实显示"—"（诚实但没信息量）；orders 页更严重——原来完全不碰这三个字段，切完单位还留着旧单位的来源描述，价格已经变了、来源却还说着旧规则。两处都已修，按 uomScoped 命中与否标成 PRICELIST/DEFAULT
- [x] A3. `npx tsc --noEmit` + `npm run build` 通过

## 模块 B：加商品重复行去重（按 productId+uomId）✅ 20260826 完成

- [x] B1. `duplicateCounts` 识别键从 `productId` 改成 `` `${productId}__${uomId}` ``（三个页面：place-order/quotations/[id]/orders/[id]）
- [x] B2. `selectProductIntoLine`/`selectProduct` 选中已存在的同商品同单位行时合并数量+1并丢弃空白草稿行；同商品不同单位正常新增，不误判重复
- [x] B3. build 通过 + 本地浏览器实测（place-order 页，Playwright）：同商品(vest)选两次 → 只剩一行、数量从1变2、总额€1→€2，无 Duplicate 提示 —— 确认生效

## 模块 C：scaleAuthoritativePrice 公式对齐 priceOf ✅ 20260826 完成

- [x] C1. `lib/server-pricing.ts` 的 `scaleAuthoritativePrice` 改成直接调用 `lib/sale-uom.ts:priceOf()`，不再自己维护一份只算 `basePrice×factor`、完全没管 `priceDiscountPct`/`priceSurcharge` 的公式
- [x] C2. build 通过 + 本地 dev 库端到端验证：造一个 FORMULA 模式(factor=0.5, surcharge=€2)的可售单位，真实 POST /api/orders 提交单价 €12.00（=20×0.5+2，公式完整值）——修复前权威价会算成 €10.00（漏了 surcharge）导致提交价被判"超出容差"强制打回；修复后 `authoritativePrice: 12, priceMatched: true, pricingWarnings: []`，验证通过。测试数据已清理

## 模块 D：Pricelist Items 页面显示实际售价 ✅ 20260826 完成

- [x] D1. 导出 `lib/pricing-engine.ts` 的 `computeItemPrice`；`pricelists/[id]/page.tsx` 在渲染每一行时调用它算出 `estimatedPrice`，formula 行显示"≈ €X.XX (公式文字)"，拿不到商品(如已归档)时优雅降级只显示公式文字
- [x] D2. build 通过 + 本地浏览器实测（Playwright，Wholesale Pricelist 56）：formula 行正确显示"≈ €19.50 (0.0% discount and -1.0 surcharge)"，跟 Public Price(20.50)+surcharge(-1.0) 手算对上；商品解析不到的一行（Applicable On 显示"—"）正确降级只显示公式文字、无崩溃

## 模块 E：账期灵活化 + 会计延期审批（最大，最后做）

- [x] E1. schema：Customer 加 `termExtendedUntil`/`termExtendedNote`；新表 `CustomerTermExtension`；迁移 `20260826000001_customer_term_extension`（本地已用 `prisma db execute` 精确应用，未用 `db push`——开发库跨 worktree 共享，`db push` 会因为别的分支加的 `settlementCycle` 列触发数据丢失警告）
- [x] E2. `lib/payment-terms.ts`：5 档账期 + 天数映射 + `computeDueDate`
- [x] E3. `lib/credit-check.ts`：合并 orders/route.ts 与 customers/[id]/credit/route.ts 的重复校验逻辑，覆盖所有账期类型，接入延期豁免判断
- [x] E4. API：`POST /api/customers/[id]/term-extension`（新增）；`GET /api/customers/[id]/credit` 和 `POST /api/orders` 改用共享函数（BOSS/FINANCE 角色特批保留，跟延期机制并存不是互相替代）；`POST /api/invoices` 的 dueDate 自动推算
- [x] E5. RBAC：`master.customer.extend_term` 权限点（sortKey 184，`sync-sortkeys.ts` 分配），迁移 `20260826000002_customer_extend_term_permission` 幂等追加给 boss/finance 两个预置角色 + bump permVersion。⚠️ 踩坑：光这样还不够，`lib/rbac/route-map.ts` 是 middleware 层单独一张静态权限表，新路由不登记会被默认拒绝——已补登记，详见记忆 `new-protected-api-route-needs-route-map-registration-20260826.md`
- [x] E6. 前端：客户详情页账期下拉扩到 5 档（新组件 `CreditTermExtensionPanel`，+1周/+2周/自定义天数+备注，按 `master.customer.extend_term` 权限门禁显隐）；place-order 与 quotations/[id] 两个信用面板都加了"账期已临时延长至 X"提示。浏览器实测（Playwright，双角色 FINANCE+OPERATOR 测试账号，真实点击"Extend Term"→+1 week）：客户详情页 Term Extension 面板正确显示"Temporarily extended until 2026-09-01"、⛔ Credit frozen 标签消失；place-order 页信用面板同步显示延期提示、颜色从红变琥珀（不再拦截）。测试数据已清理（延期记录、客户字段回滚、临时账号删除）
- [x] E1-E5 端到端验证（本地 dev 库真实 HTTP 调用，造测试客户+测试 FINANCE 账号）：
  - weekly 客户造出逾期发票 → `GET credit` 返回 `canOrder:false`（改造前这类客户不会被拦，验证了漏洞已堵上）
  - OPERATOR 账号调用延期接口 → 403（权限门禁生效）
  - FINANCE 测试账号延期 7 天 → 200，`CustomerTermExtension` 表落库一条审批履历
  - 延期后再查 `GET credit` → `canOrder:true`，欠款/逾期金额仍如实返回（€100，没被隐藏）
  - `POST /api/invoices` 不传 dueDate → 按客户账期(weekly)自动推出 7 天后的到期日，`paymentTerms` 也正确回填
  - 测试数据（客户/发票/延期记录/测试账号）已清理

---

进度：模块 A 开始，20260826。
