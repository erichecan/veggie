# 计量单位体系重整 + 采购导入收口 — 任务台账

> 起于 20260819 客户提出的 5 项要求（+ 会话中追加 1 项）。
> **台账是进度的唯一真相，对话不是。** 每完成一条回写状态与 commit hash。

## 背景事实（20260819 生产库实测，非推断）

| 事实 | 数字 | 出处 |
|---|---|---|
| 商品名末词是纯字母单位词 | 93.9%（5145/5477） | 生产库 |
| ACTIVE 可售商品 | 1736 / 5477 | 生产库 |
| 末词分布 | CASE 1002 · PKT 325 · BAG 50 · KG 50 · LOOSE 33 · DRUM 19 · PACKET 17 · JAR 17 · Bottle 17 | 生产库 |
| **同一基名 + 不同包装被拆成多个商品的组数** | **67 组** | 生产库 |
| 用了 ProductSaleUom 多规格的商品 | **2 个**（其中 1 个是客户 0819 手工试配的） | 生产库 |
| 商品名含连续空格 | 69 个 | 生产库 |
| 生产 Uom 表 | 52 个单位，Unit 类目 factor **全是 1**；Weight 类目 1KG/3kg/1.5KG 同时是 REFERENCE 且 factor=1 | 生产库 |
| ACTIVE 模板没设销售单位(锚点) | 152 / 1739 | 生产库 |

**核心矛盾**：实际仓库里 `Courgette CASE`(库存 64.4) 和 `Courgette LOOSE`(库存 0) 是**同一批货**，
拆箱就能散卖，但系统里是两个独立商品、两本独立库存，只能靠人工拆分调账。
67 组商品都是这个形态。

## 客户已拍板的决策（20260819，不要再改）

1. **需要换算系数，且系数记在商品基础资料上**——记录该商品入库时是多少箱、里面多少袋、多少公斤。
   目标：实际仓库里的一个商品，在系统里也是一个商品，不再靠人工拆分。
   → 全局 `Uom.factor` 不能承担这个职责（`10*700g CASE` 与 `20*500g CASE` 同名不同量）。
2. **保留「一个商品挂多规格」功能**，修好 4 个卡点。
3. **商品管理页默认隐藏归档商品**，只显示 ACTIVE——避免"编辑了半天，报价时找不到"。
4. 采购 PDF 导入**只走路径 A**（确定性解析），尽量不用 AI 兜底。
5. **删除路径 B**（列表页那套自动建单的导入）。
6. 计量单位**从商品名提炼**，不再自造。

---

## 任务清单

### T1 采购 PDF：加强确定性解析，移除 AI 兜底 ✅ [8bdbd7b]
- [x] 验收：
  - 用 `pic/发票的 PDF 格式Sales-Order-D120827.pdf` 及新造样本，解析器能识别供应商名与币种（现在恒为 null，必须手填）
  - `tests/pdf-line-parser.test.ts` 全绿且新增用例覆盖新识别项
  - 无 `ANTHROPIC_API_KEY` 时功能完整可用，界面不再出现"未配置 AI"字样的降级提示
- 产出：`lib/purchase/pdf-line-parser.ts`、`app/api/purchase-orders/pdf-extract/route.ts`、`tests/pdf-line-parser.test.ts`
- 依赖：无

### T2 删除路径 B（`/api/purchase-orders/import` + 列表页导入入口）✅ [8bdbd7b]
- [x] 验收：
  - `app/api/purchase-orders/import/route.ts` 删除；`lib/import-parser.ts` 若仅此处引用则一并删（vendor-bills 也在用，需先核实）
  - 采购列表页 `purchases/page.tsx` 导入按钮与对话框移除
  - `lib/rbac/route-map.ts` / `parity-baseline.json` 同步，权限点 `purchase.order.import` 若无引用则清理
  - `npm run build` + 权限可达性 parity 零 diff
- 产出：同上
- 依赖：无
- 理由：实测该路径把 `Harvest Beans` 误配成商品 `vest` 并**直接落库建单**，未匹配行静默丢弃

### T3 多规格 4 个卡点
#### T3-1 换算系数改挂商品（schema 变更）
- [ ] 验收：
  - `ProductSaleUom` 新增 `factor`（该商品下 1 个此单位 = factor 个基础单位），迁移文件手写
  - 计价（`place-order` / `quotations/[id]`）与库存换算（`lib/inventory.ts:toStockQty`）改读 `ProductSaleUom.factor`，不再读全局 `Uom.factor`
  - 商品档案页「可售单位」块能编辑该系数
  - 端到端：一个商品挂 PKT(1) + CASE(10)，卖 1 CASE 扣 10 个基础单位，StockMove 数字正确
- 产出：`prisma/schema.prisma`、迁移、`lib/inventory.ts`、`lib/sale-uom.ts`、三个订单页、商品档案页
- 依赖：无

#### T3-2 销售单编辑页补单位下拉
- [ ] 验收：`orders/[id]` 编辑态 UoM 列是下拉（与 `quotations/[id]` 一致）；切换后单价按 T3-1 的系数重算；新加行也能选非基础单位
- 产出：`app/[locale]/classic/operator/orders/[id]/page.tsx`
- 依赖：T3-1

#### T3-3 锚点单位缺失时不静默失效
- [ ] 验收：模板 `uomId` 为空的商品，配置多规格时前端明确拦截并提示先设基础单位；已存在的 152 个 ACTIVE 无锚点模板有诊断脚本可列出
- 产出：商品档案页、`scripts/audit/`
- 依赖：T3-1

#### T3-4 下拉里默认单位重复
- [ ] 验收：单位下拉中每个 uomId 只出现一次（现在锚点单位出现两次：一次英文 name、一次中文 nameZh）
- 产出：三个订单页的 UoM `<select>` 渲染
- 依赖：无

### T4 商品搜不到（tiger shrimp）
- [ ] 验收：
  - 商品名连续空格清洗脚本（69 个）+ 搜索时空白归一，输入单空格能匹配到双空格商品名
  - 客户报的 `ASIAN CHOICE  Black Tiger Shrimp HOSO 31/40 700g PKT` 能被搜到（前提是它不再是归档，见 T6）
- 产出：`lib/search-rank.ts`、清洗脚本
- 依赖：无

### T5 计量单位从商品名提炼
- [ ] 验收：
  - 提炼脚本产出「商品名末词 → 规范单位」映射表，含大小写归一（JAR/Jar、BAG/Bag、KG/Kg/kg）与拼写修正（PUNNUT/PUNNT → PUNNET）
  - 生成的单位表覆盖 ACTIVE 可售商品 ≥95%
  - 旧的中文自造单位（箱/袋/头/盒/板/筐/把/扎…）设为 inactive 而非删除（历史 OrderLine 存的是 uomName 快照，但 uomId 不能变悬空）
  - 提供 dry-run 与 --apply 两种模式，先在本地测试库跑通再上生产
- 产出：`scripts/uom/extract-uoms-from-product-names.ts`、迁移或数据脚本
- 依赖：T3-1（系数不再挂全局 Uom，提炼出来的单位才可以只有名字）

### T6 商品管理页默认隐藏归档商品
- [ ] 验收：商品列表默认只显示 ACTIVE；有显式开关可查看归档；归档商品的编辑页顶部明确提示"已归档，不会出现在下单/报价选品中"
- 产出：`app/[locale]/classic/operator/products/`
- 依赖：无

---

## 执行顺序

无依赖可先行：**T2 → T4 → T6 → T1 → T3-4**
需 schema 变更：**T3-1 → T3-2 / T3-3 → T5**

## 进度

- [x] **T1 + T2** [8bdbd7b] 采购识别收口到 `/api/purchase-orders/parse` 一条路径
      - 新增 `lib/purchase/product-match.ts`（21 单测）取代 includes 匹配
      - 解析器补 `detectCurrency` / `detectSupplier`，AI 兜底整体移除
      - 删 `/api/purchase-orders/import` 与 `/pdf-extract`
      - `purchase.order.import` 权限点作废（序号 137 进 retired）
      - 实测：PDF 币种 null→EUR；`Harvest Beans` 不再配成 `vest`；`Courgette` 标歧义
      - ⚠️ **catalog 页与新建页的 UI 尚未用浏览器点过**，接口层已实测

### 遗留待办（本轮新发现）
- [ ] `lib/import-parser.ts` 的 `matchProducts` 仍被 `/api/vendor-bills/import` 使用，
      那条路径有**同样的 includes 误配 bug**。本轮未动（超出客户要求范围），
      但供应商账单导入会把 `Harvest Beans` 配成 `vest` 这件事依然成立。
