# 2026-10-17 生产发布记录：采购运费分摊进成本联动

- 代码提交：`55d7c9ae`（T1-T4 schema+算法+confirm/cancel 分支）、`30eb3258`（T5 UI）、
  `10293a7a`（T6 verify 脚本）、`3ec9e9c6`（code-review 9 条逐条修复）、
  `7ce7a3f7`（T7 DEV-REPORT.md），已推送 `main`，含 1 个迁移（纯新增 3 列，无破坏性变更）。
- GitHub Actions `Deploy to droplet`：<https://github.com/erichecan/veggie/actions/runs/39006747144>，结果 `success`。

## 背景

客户在 PO-00140 截图上手写批注五点要求：①总运费按各行订购数量占比分摊，service 类行排除在外；
②操作员可对单行分摊运费手动 +/- 调整；③分摊合计必须等于运费总额；④确认采购这一刻把分摊后的落地
成本推到 Product.standardPrice（"public price"）；⑤取消采购单时这次形成的成本也要撤销，恢复到之前的值。
需求原话逐字存档见 `docs/20261017-采购运费分摊成本联动-需求原话.md`。

## 改动内容

- `prisma/schema.prisma` + 迁移 `20261017003802_po_line_freight_allocation_cost`：
  `PurchaseOrderLine` 加 3 字段（`allocatedFreightEur`/`landedUnitCostEur`/`standardPriceBeforeConfirmEur`）。
- `lib/purchase-landed-cost.ts`：新增 `computeFreightAllocationForConfirm`（手动覆盖优先，剩余按
  未覆盖行数量占比分摊，尾差由最后一个自动行吸收）+ `computeLandedUnitCost`。
- `app/api/purchase-orders/[id]/route.ts`：confirm 分支校验分摊合计==运费总额（差额>0.01→409，
  任一行分摊为负→409），事务内写入分摊结果并推送 `Product.standardPrice`；cancel 分支按
  确认前快照回滚（仅当当前成本价仍等于确认时写入值才回滚，避免覆盖更晚的单）；reset_to_draft
  分支补上清空分摊快照字段。
- `app/[locale]/classic/operator/purchases/[id]/page.tsx`：Cost 列换成 ⓘ 悬停提示历史参考成本，
  新增可编辑「分摊运费」列（SERVICE 行禁用），分摊合计/运费总额校验横幅，Confirm/Approve 按钮前置
  客户端同款校验。
- `lib/purchase/receive-purchase-order.ts`：收货加权平均改用含运费的 `landedUnitCostEur`（原来用
  不含运费的 `unitCostEur`，会被"确认收货"这个正常下一步把 confirm 刚写入的含运费成本冲掉）。
- 新增 `scripts/verify-po-freight-allocation.{sh,py}`：本功能专属验收探针。

## 验证结果

- `npx tsc --noEmit` 零输出。
- `scripts/verify-po-freight-allocation.sh` 实跑全绿（鉴权 401/401、分摊不一致 409、confirm 写成本、
  cancel 回滚、SERVICE 行排除分摊）；唯一未验证项是低权限 confirm→403（当前 seed-rbac.json 没有
  "有 update 无 approve" 这种权限组合的角色，无法用真实账号跑）。
- 手工补测 confirm→receive 链路：confirm 后 `standardPrice`=5.0（含运费落地成本），receive 后仍是
  5.0（未修复前会被加权平均冲回不含运费的 2.x）——`/code-review high` 发现的最高严重性问题，已修复
  并复测通过。
- `/code-review high` 返回 9 条，7 条已修复、2 条记录为已知限制（详见 DEV-REPORT.md 存档栏）；
  `/security-review` 自查无新增漏洞（无原始 SQL、无新注入面、鉴权复用既有 withAuth+FINER_GATE）。
- 本机 Chrome 可执行文件缺失（已知环境问题，见记忆 `chrome-binary-missing-for-browser-mcp-20261014`），
  Cost 列图标位置/禁用态样式等纯 UI 视觉验收未做真实浏览器点击，接口层计算逻辑已验证一致。
- 部署后 SSH 核对容器镜像：`ghcr.io/erichecan/veggie:7ce7a3f7b4a0103a25c14d4d3c1ea40048dfcf0a`，
  与推送的 HEAD commit hash 完全一致。
- 生产探活：`https://www.johnstonebros.ie/` → HTTP 200；`/api/health` → HTTP 200；
  未登录访问 `/zh/login` → 307 正确跳转 `/zh/enter`（非 500/404）。

## 待观测

- 定性观测：请打开一张有运费的采购单（采购单详情页），确认 Cost 列的 ⓘ 悬停提示、分摊运费可编辑列、
  分摊合计/运费总额校验横幅的**长相和位置**符合预期（本次只验证了计算逻辑，没验证过视觉效果，见上方
  Chrome 环境限制）；另外请确认"确认采购后 standardPrice 立即变成含运费成本"这个效果是不是你/客户
  想要的那种"立即生效"，而不是"等到真正收货才生效"。状态：待你确认。
- 技术观测：无需额外观测窗口——verify 脚本+手工补测已覆盖 confirm/cancel/receive 全链路核心路径，
  发布即生效，生产探活已通过。状态：已达成（技术侧）。

## 2026-10-17 追加发布：ⓘ列查看态空白 + 分摊基数按基础单位换算（T8）

- 代码提交：`4b5d6f30`，已推送 `main`，无新增迁移。
- GitHub Actions `Deploy to droplet`：databaseId `39037781119`，结果 `success`。

### 背景

上一轮发布后的两处跟进问题（见上方"待观测"）：
1. 客户反馈 ⓘ 参考成本列查看态（不点 Edit）是空白的，只有编辑态才有数据——根因是
   `loadPurchaseProducts()` 只在进编辑态时才调用，查看态挂载时从未调用。
2. 用户复述需求①把"总箱数"改成"基础单位"，经 `AskUserQuestion` 确认：同一单里下单单位不统一
   （部分 CASE、部分 KG）时，分摊基数要先按各商品自己的换算系数折算成基础单位再比例分，不能直接
   用下单数量裸数字比。详见 `docs/20261017-采购运费分摊成本联动-需求原话.md` 新增段落。

### 改动内容

- `app/[locale]/classic/operator/purchases/[id]/page.tsx`：挂载时无条件调用 `loadPurchaseProducts()`
  （不再只在进编辑态时加载）。
- `app/api/purchase-orders/[id]/route.ts` confirm 分支 + `app/api/products/route.ts`（`?slim=1`）+
  `lib/purchase-landed-cost.ts`：分摊基数换算改用 `ProductSaleUom.factor`（按 productId+uomId 维度）。
  ⚠️ 实现过程中一度错用全局 `Uom.factor`，读到 `app/api/uoms/route.ts` 自带的文档注释才发现该字段
  自 20260823 起已是恒为 1 的中性默认值，真实系数挂在 `ProductSaleUom` 上，已改正，**未上线前就发现
  并修复，未推送过错误版本**。

### 验证结果

- `npx tsc --noEmit` 零输出；`npm run lint` 对本次改动的文件零新增问题。
- 真实混合单位端到端验证：开发库找到同一商品下真实存在两种 `ProductSaleUom`（CASE factor=1、
  PKT factor=0.025）的商品，建测试单一行 10 CASE 一行 400 PKT（换算后基础量均为 10），confirm 后
  两行 `allocatedFreightEur` 均为 €50（运费 €100 对半分）——若退化成直接用裸 `orderedQty` 比例分
  会是 10:400≈€2.43:€97.57，与实测结果明显不同，证明基础单位换算确实生效。验证后 cancel 清理测试单。
- `scripts/verify-po-freight-allocation.sh` 全绿（单一单位场景行为未受影响，无回归）。
- 部署后 SSH 核对容器镜像：`ghcr.io/erichecan/veggie:4b5d6f303f0b089291f287ea5a06528ab0f0b2b6`，
  与推送的 HEAD commit hash 完全一致。
- 生产探活：`https://www.johnstonebros.ie/` → HTTP 200；`/api/health` → HTTP 200
  （`"status":"ok","db":"ok"`，`uptimeSec` 个位数，确认是本次部署刚重启的容器而非旧容器缓存）。
- `CI` 工作流本次失败（`39037781131`），读日志确认是既有的权限可达性快照测试
  （`tests/role-reachability.test.ts`：匿名可达路由多出 `/api/auth/register`、`/api/cron/ledger-check`
  两条），与本次改动的文件（purchases 详情页、products/purchase-orders 路由、运费分摊算法）完全无关——
  上一个提交 `e990a493`（本次改动之前）同一个测试同样失败，证明是已存在、未被本次引入的问题。
  本次未修，留作已知技术债，不在本轮范围内处理。

### 待观测

- 定性观测：真实浏览器打开一张混用 CASE/KG 等不同采购单位的采购单，确认页面上"分摊运费"列显示的
  数字跟上述 curl 验证结果一致（本机 Chrome 二进制缺失，未能做真实点击/截图，接口层已验证）。
  状态：待你确认。
- 技术观测：已通过（SSH 核对镜像 tag + 生产探活 + 混合单位真实 confirm 测试）。
- ⚠️ 遗留技术债（非本次引入，不阻塞本次发布）：CI `role-reachability` 测试检测到匿名可达路由多了
  `/api/auth/register`、`/api/cron/ledger-check` 两条，跟之前"客户名册匿名泄露"是同一类风险模式
  （见记忆 `api-customers-public-leak-fixed-20260802`），建议找时间单独核实这两条是否该匿名可达。

## 2026-10-17 追加发布：价格表「可售」开关 + 隐藏重复成本列

- 代码提交：`cf376761`，已推送 `main`，无新增迁移（`items` 是 Json 字段，加字段不用改 schema）。
- GitHub Actions `Deploy to droplet`：结果 `success`。

### 背景

客户在价格表详情页截图（"M7M1N3干货-2"）手写批注：①Variant Cost/Template Cost 两列是否需要、
建议隐藏；②每个产品需要一个可售/不可售开关，不可售时不出现在价格表输出里、下单也不按这张表的价
格算；③背景说明——季节性/运输原因导致商品时有时没有，不是按库存判断能不能按这张表卖。需求原话逐
字存档见 `docs/20261017-价格表可售开关与成本列精简-需求原话.md`。用户明确指示本次跳过 DEV-PLAN
确认环节，直接实现+提交+部署。

### 改动内容

- `lib/types.ts`：`OdooPricelistItem` 新增 `selectable?: boolean`，缺省/未设视为 `true`。
- `lib/pricelist-item.ts`：`validateAndNormalizeItem()`（PUT 与批量导入共用的唯一校验/归一化入口）
  补上 `selectable` 的归一化。
- `lib/pricing-engine.ts`：`matchesItem()` 对 `selectable===false` 的规则直接判不命中，下单定价
  自动回退到下一条匹配规则/最终牌价——所有下单/客户门户定价调用链都经过这个函数，一处改全覆盖。
- `app/api/pricelists/print/route.ts`：打印/导出结果过滤掉 `selectable===false` 的规则行。
- `app/[locale]/classic/operator/pricelists/[id]/page.tsx`：表格删掉 Variant Cost/Template Cost
  两列重复成本列（三列渲染的本就是同一个 `cost` 变量），只保留 Public Cost Price；表格行内+弹窗
  都加了「可售」勾选框，复用既有 `onInlineChange`/`persistItems()` 保存路径。
- `lib/pricelist-diff.ts`：`/code-review high` 发现 `RULE_PRICE_FIELDS`（改价留痕用的字段白名单）
  漏了 `selectable`——切换可售状态效果等同于删规则，却不会在价格表 chatter / 商品页改价历史里
  留痕，已补上。

### 验证结果

- `npx tsc --noEmit` 零输出；`npm run lint` 对本次改动的文件零新增问题（与改动前的基线逐一比对）。
- 本机 dev server 实测前后对比（改动前先备份该价格表原始 JSON，验证后原样还原）：
  把某条 `fixedPrice:0` 规则设为 `selectable=false` 后，`GET /api/products/[id]/pricelist-rules`
  返回的该价格表 `effectivePrice` 从命中值变为 `null`（跳过生效，直接证明 `matchesItem()` 的新判断
  在真实 `resolvePrice()` 调用链里生效）；`GET /api/pricelists/print?ids=...` 返回的 `items` 数量
  从 2 条降为 1 条（直接证明打印/导出过滤生效）。
- `/code-review high` 返回 1 条（上述 `RULE_PRICE_FIELDS` 漏字段），已修复并复测 tsc/lint 通过。
- `/security-review` 自查无新增漏洞：新增字段全程只是布尔值，未进入 SQL/shell/模板，未改动任何
  鉴权逻辑；唯一的数据可见性变化是打印接口"过滤掉更多行"（收窄暴露面，非扩大）。
- 部署后 SSH 核对容器镜像：`ghcr.io/erichecan/veggie:cf37676162ed5f536e0d24d6a61bee68959dd032`，
  与推送的 HEAD commit hash 完全一致，容器状态 `healthy`。
- 生产探活：`https://www.johnstonebros.ie/` → HTTP 200；`/api/health` → `{"status":"ok","db":"ok"}`，
  `uptimeSec` 个位数分钟级（刚重启容器，非旧容器缓存）。

### 待观测

- 定性观测：请打开任意一张价格表详情页，确认①Variant Cost/Template Cost 两列确实消失、只留
  Public Cost Price；②表格行+弹窗里的「可售」勾选框长相和位置符合预期；③实际取消勾选某条规则后
  打印/导出该价格表，确认那一行真的不出现了。本机 Chrome 可执行文件缺失（已知环境问题，见记忆
  `chrome-binary-missing-for-browser-mcp-20261014`），本次只做了接口层验证，未做真实浏览器点击/
  截图核对视觉效果。状态：待你确认。
- 技术观测：已达成（SSH 核对镜像 tag + 生产探活 + 接口层前后对比实测）。
