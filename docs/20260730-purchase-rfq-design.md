# 询价单发送邮件 + 复制历史采购单 — 设计文档

> 采购管理中心补全计划 子项目①（共4个，顺序：①询价单发送/复制 → ②采购退货 → ③采购质检验收 → ④预测算法优化）

## 背景

采购订单详情页（`app/[locale]/classic/operator/purchases/[id]/page.tsx`）在 DRAFT 状态下有一个"发送邮件"按钮，调用 `PATCH /api/purchase-orders/[id]` 的 `send` action。实际读代码确认：该 action **只把状态从 DRAFT 翻转到 SENT**，没有任何邮件真正发出——按钮名字和实际行为不符。

同时，采购流程里没有"从历史采购单复制"的能力：每次新建采购单都要从零手填商品和数量，即便是给同一供应商的常订清单也一样。

本子项目解决这两个问题，不涉及数据库 schema 变更。

## 现状（读代码确认）

- **状态机**：`PurchaseOrderStatus` = DRAFT → SENT → TO_APPROVE → CONFIRMED → RECEIVED → INVOICED → LOCKED（+ CANCELLED 分支），定义在 `prisma/schema.prisma`，转换表在 `app/api/purchase-orders/[id]/route.ts` 的 `ALLOWED_TRANSITIONS`。
- **供应商实体**：没有独立 Vendor 表，供应商是 `Customer` 记录里 `isVendor=true` 的那些，已有 `email`/`phone` 字段。
- **邮件基础设施**：`lib/email.ts` 已用 Resend（`RESEND_API_KEY`），已有 `sendOrderConfirmation()`、`sendPasswordReset()` 两个模板可参考风格，尚无 RFQ 模板。
- **PDF 生成**：`app/api/purchase-orders/[id]/pdf/route.ts` 已能把 PO 渲染成 PDF（用于"打印询价单"），逻辑目前只暴露为一个 HTTP route handler。
- **复制历史单**：`app/api/purchase-orders/last-by-group/route.ts` 只返回"每个品类分组最近下单日期"，不是复制整单；`app/api/purchase-orders/import/route.ts` 是 PDF/Excel 导入解析，也不是复制历史单。两者都不能满足"选一张历史单，把商品和数量原样带入新草稿"的需求。

## 目标范围

1. 点击"发送邮件"时，真正给供应商发送一封带 PO PDF 附件的邮件；发送成功才把状态推进到 SENT，失败则保持 DRAFT 并允许重试。
2. 新建采购单页面增加"从历史单复制"入口：选定供应商后，可以从该供应商的历史采购单中选一张，把商品/数量/单价原样复制进当前草稿表单（用户可再改），不产生任何数据库写入，直到用户手动保存。

**不在范围内**：供应商在线确认/拒绝报价（仍是员工手动点确认）、修改状态机、新增 schema 字段。

## 架构与数据流

### 发送邮件

```
用户点击"发送邮件"
  → PATCH /api/purchase-orders/[id] { action: 'send' }
  → 校验 po.supplier.email 是否存在
      为空 → 返回 400 { error: 'SUPPLIER_EMAIL_MISSING' }，状态不变
  → generatePurchaseOrderPdfBuffer(poId)   // 从 pdf/route.ts 抽出的可直接调用的函数
  → sendPurchaseOrderRfq(po, supplier.email, pdfBuffer)   // lib/email.ts 新增
      Resend 报错 → 返回 500 { error: 'EMAIL_SEND_FAILED', detail }，状态不变，允许重试
      成功 → 继续原有逻辑：状态 DRAFT → SENT + writeLog(ActionLog)
```

`generatePurchaseOrderPdfBuffer(poId)` 作为普通函数被 `[id]/pdf/route.ts`（HTTP 场景）和 `[id]/route.ts` 的 send action（内部调用场景）共同复用，避免服务器自己发 HTTP 请求给自己这种反模式。

### 复制历史单

```
purchases/new/page.tsx：选定供应商
  → 出现"从历史单复制"入口（按钮）
  → 点击打开 CopyFromHistoryModal
      → GET /api/purchase-orders?supplierId=xxx&limit=20   （按 orderDate 倒序）
      → 用户选择一张历史单
      → GET /api/purchase-orders/[id]   （拿完整 lines）
      → 把 lines（productId/productName/qty/unitCost/uom等）灌入当前草稿表单的行项目状态
      → 关闭弹窗，用户在表单里继续编辑/保存
```

复制过程不写数据库；新 PO 与历史 PO 是完全独立的记录。

## 组件改动清单

| 文件 | 改动 |
|------|------|
| `lib/email.ts` | 新增 `sendPurchaseOrderRfq(po, supplierEmail, pdfBuffer)`，复用 `getResend()` 与现有模板风格 |
| `app/api/purchase-orders/[id]/pdf/route.ts` | 抽出 `generatePurchaseOrderPdfBuffer(poId)` 供内部复用；route handler 本身改为调用该函数 |
| `app/api/purchase-orders/[id]/route.ts` | `send` action 分支：先校验邮箱、生成 PDF、发邮件，成功后才翻转状态；失败提前 return，不落库 |
| `app/api/purchase-orders/route.ts` | GET 补充/确认支持 `supplierId` 查询参数（用于历史单列表） |
| `app/[locale]/classic/operator/purchases/new/_components/CopyFromHistoryModal.tsx`（新增） | 历史单选择弹窗，沿用现有"固定遮罩+白色圆角卡片"风格，不引入 shadcn Dialog |
| `app/[locale]/classic/operator/purchases/new/page.tsx` | 供应商选定后展示"从历史单复制"入口，接入弹窗选择结果到表单状态 |

## 错误处理

- 供应商邮箱为空 → 400 `SUPPLIER_EMAIL_MISSING`，前端 toast 提示"请先补全供应商邮箱"（如供应商编辑页存在则附跳转链接），状态不变。
- Resend 发送失败 → 500 `EMAIL_SEND_FAILED`，前端 toast 显示失败原因，状态保持 DRAFT，用户可重试，绝不出现"界面显示已发送但实际没发"的假成功。
- 复制来源 PO 无行项目（异常数据）→ 弹窗内显示空状态提示，不报错崩溃。
- 历史单列表为空（该供应商首次合作）→ "从历史单复制"入口可以点开，弹窗显示"暂无历史采购单"。

## 测试验证计划

1. `curl PATCH /api/purchase-orders/[id] { action: 'send' }`：
   - 供应商有邮箱 → 期望 200，状态变 SENT，Resend 测试环境/日志可见一封带 PDF 附件的邮件被发出。
   - 供应商无邮箱 → 期望 400 `SUPPLIER_EMAIL_MISSING`，状态仍为 DRAFT。
   - 模拟 Resend 报错（如临时用错误 API key）→ 期望 500，状态仍为 DRAFT，可重复调用。
2. 浏览器走通复制流程：新建采购单 → 选供应商 → 从历史单复制 → 核对行项目数量/单价原样带入 → 修改后保存 → 确认新 PO 是独立记录（改新单不影响历史单）。
3. `npm run build` 无报错；控制台无红色错误。

## 已知遗留（不在本子项目范围，进入后续子项目/backlog）

- 供应商在线确认/拒绝报价（需要公开页面+token鉴权），本次不做。
- 采购退货、采购质检验收、预测算法优化——见后续子项目②③④。
