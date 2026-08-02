# 合同功能清单 × 代码核实（复核）— 任务台账

> 起始：2026-08-02
> 目标：把 2026-07-29 那份人工核实（artifact `c0c91d92`）重新用**证据**跑一遍——
> 代码检索 + 数据库实查 + 可重复执行的自动化探针，逐条给出 done/partial/missing 判定，
> 最后更新 artifact 页面。
>
> **本台账是进度的唯一真相，对话不是。** 每个周期结束必须回写本文件并提交。

## 判定口径（不许含糊）

| 判定 | 含义 | 证据要求 |
|---|---|---|
| `done` | 功能在生产代码里存在且**跑得通** | 探针实际调用返回预期结果，或 DB 有真实数据支撑；仅有代码文件不算 |
| `partial` | 主干在、有明确缺口 | 必须写清**缺的是哪一块**，不能只写"部分完成" |
| `missing` | 没有实现 | 必须给出检索命中为零的关键词集合 |
| `deferred` | 合同写明条件触发 | 引用合同条款 |

**规则**：不允许凭"看起来像"下结论。每条都要在 `docs/20260802-contract-audit-evidence.md` 留下可复现的命令或探针 ID。

## 状态汇总

| 周期 | 任务 | 状态 | commit |
|---|---|---|---|
| C0 | T0 探针骨架 + 基线 | [x] | 见 C1 同批 |
| C1 | T1 M01 移动端订货（3 项） | [x] | 见下方提交 |
| C2 | T2 M02 Quotation 销售单（4 项） | [x] | |
| C3 | T3 M03 配送 POD（7 项） | [x] | |
| C4 | T4 M04 司机 CMS（1 项）+ M14 Odoo 平移（1 项） | [x] | |
| C5 | T5 M05 日销售中心（3 项） | [x] | |
| C6 | T6 M06 仓储库存（6 项） | [x] | |
| C7 | T7 M07 采购（4 项） | [x] | |
| C8 | T8 M08 财务（9 项） | [x] | |
| C9 | T9 M09 数据分析 BI（5 项） | [x] | |
| C10 | T10 M10 基础信息与系统管理（6 项） | [x] | |
| C11 | T11 M11 私有化部署双系统（4 项） | [x] | |
| C12 | T12 M12 接口与安全（4 项） | [x] | |
| C13 | T13 重算完成度 + 与 0729 版差异表 | [ ] | |
| C14 | T14 更新并发布 artifact | [ ] | |
| C15 | T15 收尾：提交、记忆、遗留问题 | [ ] | |

---

## 任务明细

### T0 探针骨架 + 基线
- 建 `scripts/audit/` 探针harness：登录取 token、调本地 API、跑 DB 查询，输出结构化 JSON
- 确认 dev server 可用、能登录、库里有真实数据（不是空壳）
- **验收**：`npx tsx scripts/audit/run.ts --list` 能列出全部 check；至少 1 个 check 真实跑通并落 JSON
- **产出**：`scripts/audit/*`, `docs/20260802-contract-audit-evidence.md` 骨架
- **依赖**：无

### T1 M01 B2B 移动端订货（3 项）
清单项：① 常购清单一键复购 ② 账期与专属批发价展示 ③ 订单提交自动校验生成销售订单
- **验收**：③ 必须用探针真实 POST 下一单并确认落库（然后清理）；① 检索 reorder/常购/favorite/frequent 关键词全集；② 查客户端商品接口返回体里是否含 paymentTerm 字段 + 前端是否渲染
- **依赖**：T0

### T2 M02 Quotation 与销售单（4 项）
① 重复/缺货商品提醒 ② 定价与 commission 自动计算 ③ tab/enter 快捷键 ④ 状态切换/批量/退回
- **验收**：② 用探针对同一商品×不同客户取价，验证价格表链路真实生效；④ 探针真实做一次"确认→退回 quotation"往返；①③ 前端代码定位到具体行号
- **依赖**：T0

### T3 M03 配送与司机电子签收（7 项）
① 司机管理 ② 列表页快速派单 ③ 拖拽半自动调度 ④ 司机端 App 导航+电子签名 ⑤ Google 地图路线 ⑥ 现场退改电子退款凭证 ⑦ 对账回传
- **验收**：⑤ 需核实是否已接 Directions API / 地图组件（注意仓库已有 leaflet + @vis.gl/react-google-maps 依赖，0729 结论可能已过时，必须重查）；④ 检索 signature/canvas/sign 全集；⑦ 探针查 Trip 完成后 Invoice/Payment 实际回写情况
- **依赖**：T0

### T4 M04 司机绩效 CMS（1 项）+ M14 Odoo 平移（1 项）
- **验收**：M04 用 `lib/commission.ts` 对真实订单算一次提成并核对数值；M14 查 DB 实际客户/商品/订单行数，与 0729 声称的 1529/1718/789/6995 比对
- **依赖**：T0

### T5 M05 日销售管理中心（3 项）
① 打印中心 ② 缺货处理 ③ 销售统计
- **验收**：① 枚举全部打印单据类型并核对合同要求的 6 种（拣货单/汇总单/销售单/司机送货汇总/配送单/客户签收单）逐一对照；② 查是否有缺货原因字段与转单；③ 四项指标各自定位到 API
- **依赖**：T0

### T6 M06 仓储与库存（6 项）
① 多温区 ② 批次效期 FIFO ③ 实时监控+多仓调拨 ④ 盘点 ⑤ 损耗 ⑥ 收货
- **验收**：② 探针验证 FIFO 扣减顺序真实按 expiry/入库时间；③ 确认 Zone vs Warehouse 模型边界；④⑤⑥ 各查一条真实记录
- **依赖**：T0

### T7 M07 采购管理（4 项）
① 采购计划与预测 ② 询价单 ③ 采购订单全流程 ④ 采购质检与验收
- **验收**：① 读 PurchaseSuggestion 生成逻辑，判定是否含季节性/促销；③ 确认退货流程是否存在（CreditNote 是否覆盖采购侧）；④ 检索质检关键词全集
- **依赖**：T0

### T8 M08 财务管理（9 项）
客户结算/供应商结算/收付款/成本核算/5 张报表
- **验收**：5 张报表逐一在 `app/[locale]` 下找页面路由，找不到即 missing；成本核算查是否有 StockMove 计价字段
- **依赖**：T0

### T9 M09 数据分析 BI（5 项）
① 经营看板 ② 客户分析 RFM ③ 商品分析 ABC ④ 销售预测 ML ⑤ 灵活多维分析
- **验收**：⑤ **0729 结论大概率已过时**——20260801 已上线 pivot 透视（`lib/analytics/pivot.ts` + colBy 两维交叉），必须重新判定；②③ 检索 rfm/abc/复购率
- **依赖**：T0

### T10 M10 基础信息与系统管理（6 项）
组织架构/角色权限/商品信息/客户信息/供应商信息/日志与数据安全
- **验收**：角色权限项要对照补充需求那 7 类角色矩阵逐条判定；"数据备份"项注意 `lib/backup.ts` + `BackupJob` 模型已存在，0729 说"系统层面空白"可能不准，必须重查
- **依赖**：T0

### T11 M11 私有化部署与双系统并行（4 项）
① 私有化部署能力 ② 与 Odoo 12 同机并行 ③ 账号资料交接 ④ 自动备份
- **验收**：对照 `docs/20260802-private-deployment-server-enablement-plan.md`；核实 DATABASE_DRIVER 切换是否已实现、`@prisma/adapter-pg` 是否在依赖里；④ 查 BackupJob + `/api/cron/*` 实际状态
- **依赖**：T0

### T12 M12 接口与安全（4 项）
① 第三方标准 API ② 安全性与合规 ③ PDA 扫码（待触发）④ 电子秤（待触发）
- **验收**：① 检索 apiKey/oauth/webhook；② 跑一遍鉴权探针：无 token/错 token/低权限角色对写接口的响应码
- **依赖**：T0

### T13 重算完成度 + 差异表
- **验收**：产出 0729 版 vs 0802 版逐条差异表（升级/降级/维持），加权完成度重算，分母口径写清
- **依赖**：T1–T12

### T14 更新并发布 artifact
- **验收**：用 `url` 参数更新原 artifact（`c0c91d92-8b8b-4c9e-be2d-89579453c2e6`），保持同一链接；页面须包含证据列与复核日期
- **依赖**：T13

### T15 收尾
- **验收**：所有改动提交；`docs/dev-server-info/` 加进 .gitignore（含私钥，禁止入库）；遗留问题写进本台账
- **依赖**：T14

---

## 逐周期结论

### C0 探针骨架（完成）
- `scripts/audit/harness.ts` + `run.ts` + `checks/*`；证据落 `docs/audit-evidence/20260802-results.json`
- 关键坑：
  - 用户原本跑在 :3000 的 dev server 是**陈旧进程**（`/api/health` 明明在 middleware 白名单里却返回 401，说明它加载的 middleware 与磁盘不一致）。审计另起 :3100 实例，`AUDIT_HOST=http://localhost:3100`。
  - `grep` 必须排除 `lib/generated/`——Prisma 生成物把整份 schema 内联成一行字符串，任何关键词都会假命中。
- 写探针已验证可用：真实下单 → 落库校验 → finally 清理，未污染生产库。

### C1 M01 移动端订货（完成）——**2 条翻案**
| 项 | 0729 判定 | 0802 复核 | 依据 |
|---|---|---|---|
| 常购清单一键复购 | missing | **done** | `GET /api/customer-portal/frequently-ordered` 实测 200 返回 6 个商品；UI `customer-portal/page.tsx:190-208` 有「🔁 常购清单 + 一键复购」。提交 c72e5e4，**在 0729 核实之后落地** |
| 账期与专属批发价 | partial | partial（缺口改写） | 账期已展示（`page.tsx:186` 结算方式），专属价 1735 个商品全部带 customerPrice、1239 条客户↔价格表绑定。真实缺口不是"页面没展示"，而是**信用额度不参与下单阻断、客户端不可见** |
| 订单提交自动校验 | done | **done（实测确认）** | 空订单→400、未登录→401、真实下单→201 落成 `RE-260802-001`，服务端权威定价回写正常 |
| （新增）移动端形态 | 报告称"不是 PWA" | **是可安装 PWA** | `public/manifest.json` display=standalone + 2 个图标 + start_url=/customer-portal；缺 Service Worker（无离线） |

### C2 M02 Quotation 与销售单（完成）——**2 条翻案**
| 项 | 0729 | 0802 | 依据 |
|---|---|---|---|
| 重复/缺货商品提醒 | partial（"缺货提醒还没做"） | **done** | 下单页有缺货 banner + ATP toast（`place-order/page.tsx:1611-1627,737`），报价编辑页有缺货提醒（`quotations/[id]/page.tsx:155,356`，代码注释标日期 20260729——就是核实当天落地的）。缺口改写为「警告不阻断」 |
| 定价与 commission | done | done（实测确认） | 95 张价格表、1239 条客户绑定、实测取价命中 **77 种不同规则**（固定价/基于牌价加价/最小数量/嵌套）；schema 里 commissionRate/commissionFixed/commissionPrice 齐全，171 条订单行已落 commissionPrice |
| tab / enter 快捷键 | partial（"Tab 已回退成浏览器默认行为"） | **done** | Tab 处理 8 处、Enter 10 处；`ProductSearchInput` 的 `selectOnTab/onTabSelect` 自定义跳行**仍在且已接线 5 处**（OrderLineEditor→数量框）。缺口改写为「未做全表格方向键导航」 |
| 状态切换/批量/退回 | done | done（实测确认） | 真实往返：建报价→确认→撤回，库存 **23 → 22 → 23 净变化 0**，终态 PENDING + confirmationDate 清空，审计链 created→confirmed→withdrawn 完整，探针单已清理 |

**探针自身修的两个 bug**（会造成假结论，记下来）：
1. `grepCount` 无条件加 `--include=*.ts`，把点名的 `prisma/schema.prisma` 整个过滤掉 → commission 字段假报 0 命中。已改为「roots 指向具体文件时不加 include」。
2. 库存扣减探针原本随机挑商品，挑到 `qtyOnHand=0` 的就变成 0→0→0 的空测。已改为强制挑 `qtyOnHand > 5` 的商品。

### C3 M03 配送与司机电子签收（完成）——**2 条升级，0 条降级**
| 项 | 0729 | 0802 | 依据 |
|---|---|---|---|
| 司机管理 | done | done | DriverSlot 70 条（在用 52）：am/pm 双时段、批次 1-4、48/52 已绑定 DRIVER 账号 |
| 列表页快速派单 | done | done | `orders/page.tsx:283` 内嵌 `PUT /api/orders/[id]/batch` |
| 拖拽半自动调度 | partial | partial（缺口写实） | 拖拽在 `dispatch-console/_components/BatchTab.tsx:501`；地理辅助**比 0729 描述的强**——有凸包分组可视化 + "总距离超均值 2 倍"预警。但 autoAssign/optimizeRoute/vrp/kmeans **全部零命中**，确实不生成分派方案 |
| 司机端按序导航 + 电子签名 | missing | **partial** | 有逐点「🧭 导航」按钮跳外部地图（`driver/trip/[id]/page.tsx:75,389`）。但停靠点排序字段全零命中，不构成"按序"；电子签名 signature/签名/toDataURL **全部零命中**，凭证仍是拍照 |
| Google 地图司机路线图 | missing | **partial** | 司机端行程页已内嵌 `BatchMap`（`page.tsx:12,293`，提交 0cb4c52，0729 之后落地），打出各停靠点标记。但 DirectionsService/DirectionsRenderer **零命中**，只画点不画线 |
| 现场退改电子退款凭证 | partial | partial | 现场上报 + 拍照存证在；CreditNote 模型有 1096 条。但 `order-discrepancies` 路由里无 `creditNote.create`，两者不自动衔接 |
| 对账回传 | partial | partial | 完成回写发票/状态/提成冻结确实在。**财务确认交账只翻 `Trip.settlementStatus`，不建 Payment** |

**顺带挖到的生产数据事实**（对后续模块判定有用）：
- `Payment` 表 **0 条**，`Invoice` 148285 张 → 收款侧从未真正落过数据
- `OrderDiscrepancy` **0 条** → 现场退改功能在，但生产上没人用过
- 149874 单里只有 23 单带 `driverSlotId` → 绝大多数是 Odoo 历史导入单，不走派单

### C4 M04 司机绩效 + M14 Odoo 平移（完成）——**首条降级**
| 项 | 0729 | 0802 | 依据 |
|---|---|---|---|
| Product + Customer Commission | done | **partial（降级）** | 引擎完整（`lib/commission.ts` 5 个导出、5479 个商品带提成价、9 个客户配 Rate）。但**生产上冻结提成快照 0 单、已完成行程 0 个**，且找不到任何「带提成价 且 deliveredQty>0」的订单行——三块金额实算不出来。功能建好了，结算链路从未跑通过一次 |
| Odoo 数据平移 | done | done（量级远超报告） | 实测客户 1605、商品模板 5482 / 变体 5479、订单 **149874**、订单行 **1337568**、价格表 95、客户↔价格表 1239；149802/149874 单带 Odoo 原始单号。0729 报告写的"1529客户/1718SKU/一周789单/6995行"是 6 月首批导入的口径，早已被后续全量导入取代 |

**提成基准的技术事实**：`sumCommission` 以 `deliveredQty` 为基数（`lib/commission.ts:62-90`），
未发货订单算出来恒为 0。探针第一版没挑已发货单，差点得出"引擎算错"的假结论。

### C5 M05 日销售管理中心（完成）
| 项 | 0729 | 0802 | 依据 |
|---|---|---|---|
| 打印中心 | partial | partial（缺口更准） | 打印页面实测 **11 个**。合同点名 6 类单据：拣货单✓ 汇总单✓ 销售单✓ 司机送货汇总单✓ 配送单✓ **客户签收单✗**。0729 漏说的一点：**整箱整袋 / 零散货两种拣货策略已分开打印**（合同明确要求），筛选维度 customerId/driverSlotId/productId/categoryId 全在 |
| 缺货处理 | partial | partial（确认） | 批量改量接口在、缺货率分析接口 200。`shortageReason/缺货原因/outOfStockReason` **全零命中**；`转单/transferOrder/splitOrder` 在缺货相关目录内**全零命中**。0729 结论正确 |
| 销售统计 | done | done（口径升级） | 0729 说"四项指标分散在两三个页面、还没合并"——现已由 `/api/analytics/sales-overview` **一次请求返回全部四项**（dailySeries 含 aov、shortage、topProducts），页面 `boss/analytics/sales-overview/page.tsx` |

**探针又修一个 bug**：`findFiles` 原本用 `ls`，`**` 不展开，把嵌套的打印页整片漏掉，
第一次跑出来"6 类单据全部缺失"的假结论。已改用 `find`。

### C6 M06 仓储与库存（完成）——判定全部维持 0729
| 项 | 判定 | 实测证据 |
|---|---|---|
| 多温区 | done | 4 个温区实存：FROZEN(-18°C以下)/CHILLED(0~4°C)/DRY/AMBIENT；1669/5479 商品已归温区 |
| 批次效期 FIFO | done | Lot 45 个；`lib/inventory.ts:73` 消耗按 `arrivedAt asc`、回补按 `desc`；临期接口返回 12 条；StockMove 带 lotId 59/1983 |
| 实时监控 + 多仓调拨 | partial | **schema 里没有 Warehouse 模型**；调拨/warehouseTransfer/stockTransfer 全零命中。单仓内监控完整（safetyStock 16 处、库存预警 5 处），负库存商品 28 个 |
| 库存盘点 | done | StockTake 2 单 / 17 行；差异调整会生成 `StockMove(ADJUSTMENT)` 并同步 qtyOnHand + 批次余量。**循环盘点零命中**（合同提了但没做） |
| 损耗管理 | done | SCRAP 移动 6 条；`SCRAP_REASON` 结构化原因码在；`/api/analytics/loss-dashboard` 返回 kpis/trend/dispositionSplit/reasonBreakdown/topLoss |
| 收货管理 | done | GoodsReceipt 23 单；`photos` 字段存 base64 取证照片（1/23 有照片）；良品/damaged 验货状态位在；收货自动建批次并写实际保质期 |

**探针踩坑**：`/api/analytics/loss` 猜错路径返回 404，差点误判损耗模块降级——真实路径是
`loss-dashboard`。教训：接口 404 必须先确认路径存在，不能直接当成"功能缺失"。

### C7 M07 采购管理（完成）——判定全部维持，但缺口描述有一条要更正
| 项 | 判定 | 实测证据 |
|---|---|---|
| 采购计划与预测 | partial | 两条规则都跑得通并产出 13 条建议：生鲜 `max(0, 近3日日均出货 + 已确认未来订单 − 现有库存 − 在途采购)`；干货 `近12月采购量 ×(1+同比增长率)`。**季节性 seasonal/季节性 零命中**，promotion 命中 6 处但均非采购算法用途 |
| 询价单 | partial（**缺口要更正**） | 0729 说"没有复制历史采购单功能"——**已实现**：`purchases/new/_components/CopyFromHistoryModal.tsx`，按供应商列历史单、选中后行项目原样带入草稿（0729 之后落地）。PDF 识别、历史报价也在。真正只缺**线上询价**（sendRfq/发起询价/rfqEmail 全零命中） |
| 采购订单全流程 | partial | 状态分布实测 DRAFT=1 SENT=1 RECEIVED=2 LOCKED=21 CANCELLED=5；VendorBill 25 条。创建/审核/跟踪/入库/发票全 ✓，**退货 ✗**（purchaseReturn/采购退货/returnToVendor 全零命中） |
| 采购质检与验收 | missing | 质检/农残/新鲜度/freshness/pesticide/inspection/不合格 **9 个关键词全部零命中**。现有验收粒度只到收货行 `condition: 'ok'｜'damaged'` 二值 |

### C8 M08 财务管理（完成）——判定全维持，但挖出 2 条死链 + 3 个空壳
| 项 | 判定 | 实测证据 |
|---|---|---|
| 客户结算 | partial | 结算方式 cash/weekly/monthly 口径在客户档案里；但 **Statement 生产库 0 张**（0729 说"已实现"指的是代码），无日/周/月结自动触发 cron，预付款零模型，`PaymentMethod.ONLINE` 只是标签（stripe/paypal 全零命中） |
| 供应商结算 | partial | VendorBill 25 条，可由 PO 自动生成草稿（`lib/vendor-bill-from-po.ts`）。与 GoodsReceipt 无自动核销（`goodsReceiptId` 零命中） |
| 收付款管理 | partial | **Payment 生产库 0 条**（Invoice 148285 张）；银行账户/流水模型零命中；「其他收支」零命中 |
| 成本核算 | partial | 批次成本 **45/45 已回填**；但 `movingAverage/costMethod/standardCost` 全零命中，出库不做成本结转 |
| 销售毛利分析表 | done | 页面 + `/api/analytics/margin` 返回 803 行；已带透视（`PivotView.tsx` colBy 两维交叉） |
| 应收应付汇总表 | partial | 应收账龄完整（6 个账龄桶 / 658 个客户）；**应付账龄页面与 API 都不存在，接口实测 404** |
| 利润表 | missing | 页面与 API **实测 404**。底层 Account 10 个，但 **JournalEntry 0 条 / Line 0 行**——复式记账是空壳 |
| 资产负债表 | missing | 资产负债/balanceSheet/所有者权益全零命中 |
| 费用分析表 | missing | 费用分析/expenseReport/费用科目全零命中；且无「其他支出」录入口，费用数据没有来源 |

> ⛔ **本次审计发现的真实缺陷（非判定问题，是 bug）**
> `app/[locale]/classic/boss/layout.tsx:22,24` 挂了两条导航入口：
> `/classic/boss/analytics/income-statement`（利润表）与 `/classic/boss/analytics/ap-aging`（应付账龄），
> **两个页面目录和对应 API 都不存在，BOSS 点进去就是 404**。
> 演示给甲方时会当场翻车。已记入遗留问题，等用户决定是修还是摘掉入口。

**0729 报告在 M08 的系统性偏差**：它说的"已实现"多数指**代码存在**，
但生产库里 Statement 0 张、Payment 0 条、JournalEntry 0 条——功能是空跑的。

### C9 M09 数据分析与 BI（完成）——灵活分析那条的核心论断被推翻
| 项 | 判定 | 实测证据 |
|---|---|---|
| 经营看板 | done | `/api/analytics/overview` 返回 yesterday/today/todayOps/redFlags/ar；快照表 **136 天**数据。注：最新一天（08-01）销售额与单数都是 0 |
| 客户分析 RFM | partial | 接口返回 summary/abc(437)/churn(226)，分层与流失预警是真的。`rfm/recency.*frequency/复购率/repurchaseRate` **全零命中**——现有分层是按销售额排序做 ABC，不是 R/F/M 三维打分 |
| 商品分析 | partial | 毛利排行 ✓（803 行）、畅销滞销 ✓。**商品 ABC ✗**——现有 ABC 在 `analytics/customers/route.ts`，是**客户维度**不是商品维度；价格敏感度 ✗（elasticity 零命中） |
| 销售预测 ML | missing | ML/regression/arima/时间序列/prophet/tensorflow/onnx/neural/训练集/backtest **10 个关键词全零命中**。现有"预测"是两条确定性公式 |
| 灵活数据分析 | partial（**核心论断被推翻**） | 0729 说"一次只能选一个维度、做不到客户×月份交叉"——**实测两维交叉可用**：`groupBy=customer&colBy=month` 返回 `rows[437] cols[1] cells[437] grandTotal`，引擎 `lib/analytics/pivot.ts`（10 个白名单维度），UI 有 `PivotView`。真实缺口收窄为：**只有毛利分析一张表接了透视**，其余分析页仍是预设报表 |

### C10 M10 基础信息与系统管理（完成）——**审计过程中修掉一个生产泄露**
| 项 | 判定 | 实测证据 |
|---|---|---|
| 组织架构 | missing | Company/Department/Store/Branch/Warehouse/Organization **6 个模型全不存在**；只有 Notification 等表上一个默认值 `"test-company"` 的 tenantId，未成体系 |
| 精细化角色权限 | partial（缺口更严重） | 销售行级隔离代码在，但 **19 个 SALES 用户全部兼任 OPERATOR，实际受约束人数 = 0**，规则形同虚设。采购员供应商隔离零命中；配送/打印中心只按角色大类放行 |
| 商品信息管理 | partial | 分类 33 / 计量单位 43 / 商品 5479；分类·多规格·多单位·批次·保质期·图片·条码全 ✓，**只缺产地溯源**。注：条码字段在 ProductTemplate 上且 **0/5482 有值**（M12 的 PDA 条件触发项因此还不成立） |
| 客户信息管理 | partial | 信用额度·账期·历史价格协议 ✓；缺分级、多地址（street/street2/city/zip/country 一组平铺字段，一客户只能一个地址）、合同管理 |
| 供应商信息管理 | partial | 供应商 207 个、ProductSupplierInfo 192 条（价格/交期/起订量 ✓）；缺资质证件、评级、合同管理。**无独立 Vendor 模型**，与客户共用 Customer 表靠 isVendor 布尔位区分 |
| 系统日志与数据安全 | partial（**0729 结论已过时**） | ActionLog **5295 条**（LOGIN 963 / UPDATE 4007 / CREATE 308 / DELETE 17）。备份不再是"系统层面完全空白"——pg_dump 模块 + 每日 cron + BOSS 管理页 + 签名下载都已落地。**但 3 次任务成功 0 次**：两次栽在 pg_dump 版本不匹配（已修），最近一次栽在 GCS bucket 不存在。从未成功产出过一份备份 |

> ⛔ **审计过程中发现并已修复的生产安全问题**（详见 commit 588357a）
> `GET /api/customers` 在 middleware 白名单里，**匿名可拉走全量客户名册**：
> 生产实测 200 / 1,311,883 bytes / 1605 个客户，含地址、电话、邮箱、VAT 税号、
> 信用额度、提成率。已移除白名单；同时修掉 SALES 行级隔离在 `includeArchived=1`
> 路径下的授权绕过（条件 push 在 `where` 构造之后，`where` 已退化成 `{}`）。
> 已 push 部署（用户批准）。

### C11 M11 私有化部署与双系统并行（完成）——1 条升级
| 项 | 0729 | 0802 | 依据 |
|---|---|---|---|
| 私有化部署能力 | missing | missing | `DATABASE_DRIVER` 与 `@prisma/adapter-pg` **零命中**，`lib/db.ts:12` 写死 `PrismaNeon`；有 Dockerfile 但无 docker-compose / 部署脚本；`@google-cloud/storage` 仍残留 3 处。方案文档 2 份但未实施 |
| 与 Odoo 12 同机并行 | missing | missing | 同机隔离方案停在纸面。20260802 计划已识别阻塞：数据居留（库在法兰克福↔机在伦敦）、无 swap 时峰值 3.5–3.7GB 逼近 3.8GB 会 OOM、Odoo 12 需 py3.5-3.7 撞系统 py3.14 |
| 账号与资料交接 | missing | missing | `交接清单/管理员账号/账号移交` 关键词零命中；账号仍全在开发方 GCP 项目 supply-491510 |
| 自动备份 | missing | **partial** | 备份模块、每日 cron、BOSS 管理页、签名下载全已落地，且 cron 是「HTTP + CRON_SECRET」形状（迁服务器后 systemd timer 可直接接）。但 **0/3 次成功**、只备库不备上传文件、无自动恢复验证、落点绑 GCS |

### C12 M12 接口与安全（完成）
| 项 | 判定 | 实测证据 |
|---|---|---|
| 第三方标准 API | missing | 157 个路由全服务自家前端。apiKeyAuth/oauth/clientSecret/webhook//api/v1 **全零命中**（唯一的 x-api-key 是本系统去调 Anthropic）。电子秤/税控/ERP对接/物流平台全零命中 |
| 安全性与合规 | partial | **鉴权闸门实测通过**：无 token→401、错 token→401、低权限 DRIVER 访问备份→403、写操作无 token→401。bcrypt/登录限流/TOTP/操作审计/批次追溯全 ✓。缺静态加密、缺《食品安全法》专项合规设计 |
| PDA 扫码 | deferred | 条码生成能力在（jsbarcode 20 处），但**条码覆盖率 0/5482**，合同的触发条件尚未成就 |
| 电子秤 | deferred | 电子秤/过秤关键词零命中，属条件触发项 |

## 遗留问题 / 决策记录

- 用户跑在 :3000 的 dev server 已陈旧，审计不动它，另起 :3100。审计结束需提醒用户重启 :3000。
- 生产库写探针已获用户授权（带 `AUDIT-PROBE-20260802` 标记 + finally 清理）。
- ⛔ **待用户决策**：备份从未成功产出过一份（3/3 失败，最近一次是 GCS bucket 不存在）。
  按项目部署铁律不该为将要拆掉的架构新建 GCS 桶，备份落点应改 S3 兼容存储（DO Spaces）。
  本次审计只记录不修改。
- ⛔ **待用户决策**：BOSS 导航两条死链（利润表 / 应付账龄，`boss/layout.tsx:22,24` → 404）。
  选项：(a) 补出这两张报表；(b) 先把导航入口摘掉避免演示翻车；(c) 保持现状。
  本次审计只记录不修改。

## 硬停止触发记录

- （待填）
