# 报价单 / 销售单「发邮件给客户」+ 客户多邮箱收件人选择 —— 台账

> 需求原话：「客户名下有多个邮箱，在 quotation 或 sale order send email 发送给客人，
> 跳出这几个邮件地址，选为主邮件地址，其余为选为 CC。」
>
> 建档：2026-08-08 · 类型：BIG（新增功能模块 + schema 变更 + 多文件）
> 台账是进度的唯一真相，对话不是。每个周期从读本文件开始。

---

## 0. 开工前已核实的事实（不是假设）

| 事实 | 证据 |
|---|---|
| 报价单和销售单是**同一个实体** `Order`，`PENDING`=报价单，确认后=销售单 | quotations/[id]/page.tsx 读的是 `/api/orders/${id}`；schema 无 `model Quotation` |
| 报价单/销售单**当前完全没有发邮件功能** | 全项目 `lib/email.ts` 只有 3 个导出，无一与 Order 相关 |
| 系统里**没有客户多邮箱的数据结构** | `Customer` 只有单个 `email String @default("")`；schema 无任何 Contact 模型 |
| 生产 1407 个客户中仅 **46 个**有邮箱，**0 个**在字段里塞了多地址 | 生产库实测 2026-08-08 |
| Odoo 子联系人**从没导入过** | `import-odoo-customers-20260717.ts` 是 `email: r.email` 一对一；`res_partner.csv` 表头无 `parent_id` |
| ⛔ 生产**所有**邮件功能当前都发不出去 | 生产 key 实测：`veggiesupply.ie` 与 `johnstonebros.ie` 均返回 403 domain is not verified |
| `/api/orders/[id]/pdf` 返回的是 **HTML 打印页**，不是 PDF | route 结尾 `Content-Type: text/html` |
| 采购单 RFQ 已跑通「HTML→PDF→邮件带附件」链路，可照搬 | `purchase-orders/[id]/route.ts:344-354` |

## 1. 已拍板决策

| # | 决策 | 备注 |
|---|---|---|
| D1 | 多邮箱数据来源 = **从 Odoo 12 同步子联系人**（`res.partner.child_ids`） | ⚠️ 需业主提供 Odoo 访问方式，暂未拿到 |
| D2 | 邮件形态 = **PDF 附件 + 简短正文** | 照搬采购单 RFQ |
| D3 | 发件域 = **johnstonebros.ie** | 业主去 Resend 加域 + 配 DNS；代码改为读环境变量 |
| D4 | 存量三处坏掉的邮件功能（订单确认/密码重置/采购 RFQ）**一起修** | 反正都要改 `lib/email.ts` |

## 2. BIG 改动评估（CLAUDE.md 第八节）

**架构**：新增 `CustomerContact` 与 `Customer` 一对多，边界清晰。发信统一收口在 `lib/email.ts`，
不在业务路由里散落 Resend 调用。发件地址从写死改为 `EMAIL_FROM` 环境变量注入 —— 迁到客户自有
服务器后照样可用，不引入任何 GCP/Neon 专有依赖（符合部署目标铁律）。

**质量**：订单 HTML 模板当前内联在 `pdf/route.ts` 里。必须先抽成 `lib/order-pdf.ts`，
否则邮件附件会复制一份模板，两份日后必然腐化（DRY）。

**性能**：联系人按 `customerId` 索引查，单客户联系人数量是个位数，无 N+1 风险。
PDF 渲染走 puppeteer，是重操作，但只在点发送时同步跑一次，不进列表页。

**风险**：D3 未落地前，功能做完在生产仍发不出去（403）。这是业主侧 DNS 依赖，不是代码问题。

---

## 3. 任务清单

- [x] **T1 发件地址可配置 + 存量三处修复** ✅ 2026-08-08
      实测结论推翻了开工前的判断：**三处全是假成功**，不只订单确认那一处。
      根因是 Resend SDK 在 HTTP 非 2xx 时 `return { data:null, error }` 而**不 throw**
      （`node_modules/resend/dist/index.mjs:1074` fetchRequest），所以采购单 RFQ 那个
      写着"不允许假成功"的 try/catch 从来没生效过 —— 403 照样 resolve，单据照样推进到 SENT。
      修复：新增 `dispatch()` 统一出口把 error 翻译成异常；`tests/email-dispatch-failure.test.ts`
      锁住该行为（已验证撤掉修复后 403/429 两条转红）。全量 383 测试 0 失败，build EXIT=0。
      验收：`lib/email.ts` 的 `FROM` 读 `EMAIL_FROM` 环境变量，缺省回退到 `johnstonebros.ie`；
            Resend 返回错误时**抛出异常而不是静默吞掉**；三个既有发信函数全部走同一出口；
            `npm run build` 通过
      产出：`lib/email.ts`、`.env.example`
      依赖：无

- [ ] **T2 CustomerContact 表 + 迁移**
      验收：`npx prisma migrate status` 显示新迁移已应用；字段含
            `customerId / name / email / role标签 / isPrimary / isActive`；
            同一客户下 `isPrimary` 至多一条；`Customer.email` 非空的存量数据回填为一条主联系人
      产出：`prisma/schema.prisma`、`prisma/migrations/20260808*/`
      依赖：无

- [ ] **T3 联系人 CRUD API**
      验收：`GET/POST /api/customers/[id]/contacts`、`PATCH/DELETE .../contacts/[cid]`；
            全部带鉴权（写操作 `customer.manage` 级）；无 token 返回 401；
            邮箱格式非法返回 400；删除最后一个主联系人不报 500
      产出：`app/api/customers/[id]/contacts/route.ts` 及 `[cid]/route.ts`
      依赖：T2

- [ ] **T4 客户详情页联系人管理 UI**
      验收：浏览器实点 —— 能增/删/改联系人、能切换主联系人，列表为空有空状态提示，
            不是空白页；改完刷新仍在
      产出：`app/[locale]/classic/operator/customers/[id]/page.tsx` + 联系人组件
      依赖：T3

- [ ] **T5 抽取订单单据 HTML 模板**
      验收：`lib/order-pdf.ts` 导出 `renderOrderHtml(order, customer)`；
            `/api/orders/[id]/pdf` 改为调用它，打印页输出与改动前**逐字节一致**（diff 验证）
      产出：`lib/order-pdf.ts`、`app/api/orders/[id]/pdf/route.ts`
      依赖：无

- [ ] **T6 发送接口**
      验收：`POST /api/orders/[id]/send-email`，入参 `{ to, cc[] }`；
            带鉴权；`to` 不在该客户名下的邮箱要拒（防越权发信）；
            收件人为空返回 400 且**不发信**；Resend 失败返回 5xx 且**不写成功日志**
            （即不允许"界面显示已发送但实际没发"的假成功）；成功后写 ActionLog 留痕
      产出：`app/api/orders/[id]/send-email/route.ts`、`lib/email.ts` 新增 `sendOrderDocument`
      依赖：T1、T5

- [ ] **T7 前端 Send Email 弹窗**
      验收：报价单页与销售单页**共用同一组件**；弹窗列出该客户名下全部邮箱；
            单选主收件人（To）、多选 CC；默认勾中主联系人；CC 不能与 To 重复；
            客户一个邮箱都没有时给明确提示并禁用发送按钮，而不是弹空列表；
            发送中按钮禁用防重复提交；成功/失败都有可见反馈
      产出：`components/orders/send-email-dialog.tsx` + 两个页面的入口按钮
      依赖：T6

- [ ] **T8 Odoo 子联系人导入脚本**
      验收：脚本支持 dry-run 与 `--apply`；能从 `res.partner` 拉 `parent_id` 非空且 email 非空的记录，
            按 `parent_id → Customer.externalId` 挂到对应客户下；重复运行幂等
      产出：`scripts/import-odoo-contacts-20260808.ts`
      依赖：T2；⛔ **实际跑需要业主提供 Odoo 访问方式（当前未拿到）**

- [ ] **T9 端到端验证 + 报告**
      验收：按 CLAUDE.md 完成标准逐条走通（含未登录、错误入参、空数据三类边界）；
            用 Resend 测试域实际收到一封带 PDF 附件、含 CC 的邮件；服务器日志无 error
      产出：`DEV-REPORT.md`
      依赖：T1–T7

---

## 4. 未解决 / 卡住的问题

- **U1（阻塞 T8）**：Odoo 12 的访问方式未提供。`scripts/odoo-migration/config.env` 被 gitignore，
  本地无 Odoo 镜像库残留。需要业主给 SSH+PG 或 XML-RPC API key 其中之一。
- **U2（阻塞生产真实发信）**：`johnstonebros.ie` 需在 Resend 加域并配 SPF/DKIM DNS 记录。
  只有业主能做。未完成前生产发信恒 403。
- ~~**U3**：采购单 RFQ 发失败是否被吞成"假成功"~~ → **已查证：是**，且三处全中。见 T1。
  ⚠️ 推论：生产上历史状态为 `SENT` 的采购单，供应商**实际从未收到过邮件**。
  这批单据需要业主确认是否要重发 —— 属于数据层面的既成事实，代码修复救不回来。
