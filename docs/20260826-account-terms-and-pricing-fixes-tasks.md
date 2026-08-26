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

- [ ] E1. schema：Customer 加 `termExtendedUntil`/`termExtendedNote`；新表 `CustomerTermExtension`；迁移
- [ ] E2. `lib/payment-terms.ts`：5 档账期 + 天数映射 + `computeDueDate`
- [ ] E3. `lib/credit-check.ts`：合并 orders/route.ts 与 customers/[id]/credit/route.ts 的重复校验逻辑，覆盖所有账期类型，接入延期豁免判断
- [ ] E4. API：`POST /api/customers/[id]/term-extension`（新增）；`GET /api/customers/[id]/credit` 和 `POST /api/orders` 改用共享函数；`POST /api/invoices` 的 dueDate 自动推算
- [ ] E5. RBAC：`master.customer.extend_term` 权限点，授予 FINANCE/BOSS
- [ ] E6. 前端：客户详情页账期下拉扩到 5 档 + "延长账期"按钮；下单页信用面板显示延期状态
- [ ] E7. build 通过 + 本地浏览器实测走一遍：造测试客户逾期→拦截→延期→放行→到期恢复拦截；开票不传 dueDate 自动推算

---

进度：模块 A 开始，20260826。
