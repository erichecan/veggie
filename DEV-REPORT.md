# DEV-REPORT：采购运费按数量分摊进成本，确认时联动成本价、取消时回滚

对应 DEV-PLAN.md（2026-10-17）、台账 docs/20261017-采购运费分摊成本联动-tasks.md（T1-T7 全部完成）。

## 给你看的

| 场景 | 来源 | 复现方式 | 状态 |
|---|---|---|---|
| Cost 列不再直接显示金额，换成 ⓘ 悬停提示「历史参考成本」 | 你原话：「如果是历史参考成本,那就旁边有一个information 的图标,鼠标悬停就显示历史参考成本」 | 浏览器打开采购单详情页 Products 栏，Cost 列是一个 ⓘ 图标，鼠标悬停弹出 `Product.standardPrice` | ⚠️ 待你确认（本机 Chrome.app 二进制缺失，未能截图，见下方「已知问题」） |
| 总运费按各行订购数量占比分摊到每行，service 类行不参与分摊 | 客户批注①：「对于storable 或 consumable产品，总的费用除以总箱数 得出每箱的 分摊费用」 | `curl` 复现：见下方验证结果表第 1 条 | ✅ 符合 |
| 操作员可对单行分摊运费手动 +/- 调整；分摊合计必须等于运费总额才能确认 | 客户批注②③：「根据实际需要 每个产品分摊的费用 调整，+或-」「每个产品 分摊费用合计 与 总费用 要对的上」 | `curl` 复现：故意改一行分摊运费后 confirm → 409 带具体差额；清空覆盖后恢复 200 | ✅ 符合 |
| 确认采购这一刻，把分摊后的落地成本（含运费）推到 Product.standardPrice（"public price"） | 客户批注④：「订单确认，新形成的cost,作用到 public price」 | `curl` 复现：见下方验证结果表第 2、3 条 | ✅ 符合 |
| 取消采购单，这次形成的成本也撤销，恢复到确认前的值 | 客户批注⑤：「如订单取消，这次形成的cost也取消。恢复到之前的」 | `curl` 复现：见下方验证结果表第 4 条 | ✅ 符合 |

访问地址：http://localhost:3001/zh/classic/operator/purchases/[id]
测试账号：boss(at)demo.local / test12345（同时具备 purchase.order.update + purchase.order.approve）

**⚠️ 关于 UI 视觉验收的诚实说明**：本机 `/Applications/Google Chrome.app` 二进制缺失（空壳应用），Playwright/
chrome-devtools MCP 均无法启动浏览器，没能做真实点击/截图验证。Cost 列图标、分摊运费可编辑列、校验横幅的
**渲染位置和样式**需要你用浏览器实地打开上面地址确认一遍；它们背后的**计算逻辑**已经在服务端-前端共享同一套
`lib/purchase-landed-cost.ts` 并用接口级测试验证过数字一致（见下表），不是没测，是"测了计算、没测长相"。

## 存档用的（你不用看，出问题时我回来查）

### 验证结果（verify-po-freight-allocation.sh 实跑输出）

```
1/3 — tsc --noEmit                                           ✅
2/3 — prisma migrate status（up to date）                     ✅
3/3 — HTTP 探针：
  无 token confirm → 401                                      ✅
  错 token confirm → 401                                      ✅
  低权限（有 update 无 approve）confirm → 403                  ⚠️ 未验证（seed-rbac.json 里没有这种权限组合的角色）
  分摊合计与运费总额不一致 → 409 且带具体差额                    ✅
  confirm → 200 CONFIRMED                                     ✅
  非 SERVICE 行分摊运费=30、落地成本=5.0，与手算一致              ✅
  SERVICE 行分摊运费恒为 0，不参与分摊                           ✅
  confirm 后 Product.standardPrice 已推到落地成本 5.0            ✅
  cancel → 200 CANCELLED                                      ✅
  cancel 后 Product.standardPrice 回滚到确认前快照                ✅
```

另手工验证（verify 脚本未覆盖的 receive 分支，见下方「code-review 修复」第1条）：
confirm → standardPrice=5.0 → receive → standardPrice 仍是 5.0（未修复前会被加权平均冲回 2.x）。✅

### /code-review high + /security-review（CLAUDE.md §11 门槛，逐条处理）

/security-review 自查结论：无新增漏洞（DB 写入全走 Prisma 参数化调用，鉴权复用既有 `withAuth`+`FINER_GATE`，
无新注入面/无 PII 泄露）。

/code-review high 返回 9 条，逐条处理：

| # | 文件:行 | 问题 | 处理 |
|---|---|---|---|
| 1 | receive-purchase-order.ts:74 | 收货加权平均用不含运费的 `unitCostEur`，confirm 刚写入的含运费成本会被"确认收货"这个**正常下一步**悄悄冲掉，不是边缘情况 | ✅ 已修：改用 `landedUnitCostEur ?? unitCostEur ?? 0` |
| 2 | purchases/[id]/page.tsx:948 | 前端预览用原币 `freightAmount`，服务端用 `freightAmountEur`，非欧元供应商两边算的不是同一个数，手动覆盖还会被按错误汇率曲解 | ✅ 已修：前端先按汇率折算成欧元再喂同一套分摊函数 |
| 3 | route.ts:502 | 取消回滚靠"当前成本价数值上等于确认时写入值"判断有没被覆盖过，不是显式血缘字段 | ⛔ 接受，不处理——触发需要运费=0 + 部分收货进零库存 + 之后取消三者同时成立，真正加血缘字段是另一轮 schema 改动，记为已知限制 |
| 4 | purchase-landed-cost.ts:84 | 手动覆盖合计超运费总额时，剩余分给其它行会算出负数分摊/负落地成本 | ✅ 已修：加 409 校验，任何一行分摊为负直接拒绝 |
| 5 | route.ts:391 | `include:{lines:true}` 无 orderBy，分摊"尾差给最后一行"可能跟前端按 sequence 显示的"最后一行"不是同一行 | ✅ 已修：加 `orderBy:{sequence:'asc'}` |
| 6 | route.ts:529 | reset_to_draft 没清分摊快照字段，取消→reset→改→重新确认时旧快照被误当"本轮手动覆盖" | ✅ 已修：reset_to_draft 分支补 `purchaseOrderLine.updateMany` 清空三个字段 |
| 7 | purchases/new/page.tsx:612 | 新建页草稿预览仍用旧公式（金额占比、不排除 SERVICE），跟确认时真正落库的算法不一致 | ⛔ 接受，不处理——只影响起草阶段预览数字，不影响落库数据（确认时永远重算），且不在本次 DEV-PLAN 范围 |
| 8 | purchases/[id]/page.tsx:1189 | Approve 按钮没经过跟 Confirm 按钮一致的客户端分摊校验 | ✅ 已修：补上同款 guard |
| 9 | route.ts:585 | 新代码 `tx as any` 违反 CLAUDE.md"不用 any" | ✅ 已修：改用项目既有先例 `Prisma.TransactionClient` |

修复后 `npx tsc --noEmit` 零输出，verify-po-freight-allocation.sh 重跑全绿。

### 架构张力（DEV-PLAN 已提前说明，用户已拍板）

客户字面要求"确认采购"这一步把成本写进 Product.standardPrice（"public price"），而系统原有的"确认收货"
环节也会按加权平均改写同一个字段——两套机制叠在一起。用户原话「按客户要求去改」，这次按字面实现；
code-review 额外发现并堵上了其中一个具体的坑（上表第1条：确认后立即收货会把刚写的含运费成本冲掉），
但"两个动作都想改同一个字段"这个根本张力本身没有被消除，只是让"确认→收货"这条最常见路径不再互相打架。

### 已知不可用/未验证功能

- 低权限（有 `purchase.order.update` 无 `purchase.order.approve`）confirm → 403：当前 `seed-rbac.json`
  没有这种权限组合的角色（BOSS/OPERATOR 两者皆有，其余角色两者皆无），无法用真实账号跑这条探针。
- 取消回滚的"数值重合"判断（见上表第3条）：运费=0 且部分收货后取消的极端组合下，可能误判"未被覆盖"而
  回滚掉已经被收货环节更新过的成本价。概率低但存在，接受为已知限制。
- 新建采购单页的草稿预览公式（见上表第7条）跟确认时真实算法不一致，只影响起草阶段看到的预览数字。
- UI 视觉验收（图标位置/禁用态样式）未经真实浏览器验证，见上方「给你看的」栏说明。

### 技术栈/部署

本地开发库 Neon PostgreSQL（`.env.local`），迁移 `20261017003802_po_line_freight_allocation_cost`
纯新增 3 列，无破坏性变更。生产部署走 push main → GitHub Actions → droplet 自动部署，部署后将按
veggie 项目 CLAUDE.md 第九节「部署后效果闭环」补一条 `docs/20261017-veggie-deploy-log.md`。
