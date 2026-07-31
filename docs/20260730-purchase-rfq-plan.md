# 询价单发送邮件 + 复制历史采购单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the purchase-order detail page's "发送邮件"(Send by Email) button actually send an RFQ email with a PDF attachment to the supplier, and let users start a new purchase order by copying line items from a past order to the same supplier.

**Architecture:** Extract the existing PO→HTML rendering logic (currently only usable for browser "print") into a pure, unit-testable function shared by the print route and a new email-send path; wire that into the existing `PATCH .../purchase-orders/[id]` `send` action so email success gates the DRAFT→SENT transition. Add a small history-picker modal to the "new purchase order" page that reads the already-existing `GET /api/purchase-orders?supplierId=` list endpoint and copies line data client-side into the draft form — no new DB writes, no schema changes.

**Tech Stack:** Next.js App Router API routes, Prisma, Resend (email), `puppeteer-core` (existing `lib/print/render-pdf.ts` HTML→PDF), `node --test` + `tsx` for unit tests, React/Tailwind for the modal (hand-rolled fixed-overlay style, matching `PriceHistoryModal.tsx`).

## Global Constraints

- No Prisma schema changes in this plan.
- Supplier = `Customer` row with `isVendor=true`; email field is `Customer.email` (plain string, default `""`, never null).
- `GET /api/purchase-orders` already supports `?supplierId=` and `?limit=` query params — do not re-implement.
- The `server-only` npm package is **not installed** in this repo (confirmed: `node -e "require.resolve('server-only')"` → `MODULE_NOT_FOUND`). Existing files that `import 'server-only'` (e.g. `lib/print/render-pdf.ts`) only work inside the Next.js build/dev pipeline, not under plain `node --test`. Any new file that must be importable from a `node --test` unit test **must not** import, directly or transitively, anything that imports `'server-only'`.
- Client API error surfacing: `lib/api.ts`'s `api()` treats `body.error` as a business `code` only if it matches `/^[A-Z_]+$/`, and prefers `body.message` over `body.error` as the display text. Error responses in this plan return both `error` (code) and `message` (human text) for this reason.
- 5xx responses are shown to the user as a generic "server unavailable" string by `lib/api.ts` (by design, see its top comment) — do not rely on the raw 5xx message reaching the UI.
- Follow existing UI convention for purchasing-module dialogs: hand-rolled `<div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">` overlay + white rounded card, not shadcn `Dialog`.

---

### Task 1: Extract PO→HTML rendering into a pure, testable function

**Files:**
- Create: `lib/purchase-order-pdf.ts`
- Modify: `app/api/purchase-orders/[id]/pdf/route.ts`
- Test: `tests/purchase-order-pdf.test.ts`

**Interfaces:**
- Produces: `renderPurchaseOrderHtml(po: PurchaseOrderPdfData, supplier: PurchaseOrderPdfSupplier | null): string` — pure function, no I/O, safe to import from a `node --test` file (does not import `'server-only'` or `puppeteer-core`).
- Produces (types): `PurchaseOrderPdfData`, `PurchaseOrderPdfLine`, `PurchaseOrderPdfSupplier` — consumed by Task 2/3.

- [ ] **Step 1: Write the failing test**

Create `tests/purchase-order-pdf.test.ts`:

```ts
/**
 * renderPurchaseOrderHtml 是 PO 打印页和"发送邮件"PDF 附件共用的渲染函数，
 * 纯字符串输出，不碰 DB/文件系统，用假数据直接测。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderPurchaseOrderHtml, type PurchaseOrderPdfData, type PurchaseOrderPdfSupplier } from '../lib/purchase-order-pdf'

function samplePo(status: string): PurchaseOrderPdfData {
  return {
    name: 'PO-00042',
    status,
    supplierId: 'sup_1',
    orderDate: '2026-07-30T00:00:00.000Z',
    createdAt: '2026-07-30T00:00:00.000Z',
    expectedDate: null,
    notes: null,
    subtotalExTax: 100,
    totalTax: 10,
    totalIncTax: 110,
    lines: [
      { productName: '西兰花', uomName: 'kg', orderedQty: 20, unitCost: 5, taxRate: 10, subtotalIncTax: 110 },
    ],
  }
}

const sampleSupplier: PurchaseOrderPdfSupplier = {
  name: 'Green Farm Ltd', street: '1 Market St', city: 'Dublin', zip: 'D01', phone: '011', vatNumber: 'IE123',
}

test('DRAFT 状态 → 文档标题为 REQUEST FOR QUOTATION', () => {
  const html = renderPurchaseOrderHtml(samplePo('DRAFT'), sampleSupplier)
  assert.match(html, /REQUEST FOR QUOTATION/)
})

test('非 DRAFT 状态（如 SENT）→ 文档标题为 PURCHASE ORDER', () => {
  const html = renderPurchaseOrderHtml(samplePo('SENT'), sampleSupplier)
  assert.match(html, /PURCHASE ORDER/)
  assert.doesNotMatch(html, /REQUEST FOR QUOTATION/)
})

test('包含供应商名称与行项目商品名', () => {
  const html = renderPurchaseOrderHtml(samplePo('DRAFT'), sampleSupplier)
  assert.match(html, /Green Farm Ltd/)
  assert.match(html, /西兰花/)
})

test('supplier 为 null 时不抛错，用 supplierId 兜底展示', () => {
  const po = samplePo('DRAFT')
  assert.doesNotThrow(() => renderPurchaseOrderHtml(po, null))
  assert.match(renderPurchaseOrderHtml(po, null), /sup_1/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/purchase-order-pdf.test.ts` (or `node --test --import=tsx tests/purchase-order-pdf.test.ts`)
Expected: FAIL — `Cannot find module '../lib/purchase-order-pdf'`

- [ ] **Step 3: Create `lib/purchase-order-pdf.ts`**

Move the HTML-building logic out of `app/api/purchase-orders/[id]/pdf/route.ts` (currently lines 39–192) into this new file, parameterized on `po`/`supplier` instead of fetching them:

```ts
/**
 * 采购单 → HTML 渲染（纯函数，无 I/O）
 * ============================================================================
 * 供两处复用：
 *   1. GET /api/purchase-orders/[id]/pdf —— 浏览器打印(window.print())
 *   2. PATCH /api/purchase-orders/[id] 的 send action —— 生成 PDF 附件发邮件
 * 不 import 'server-only' 或 puppeteer-core，保持可被 node --test 直接单测。
 */
import { formatDateOnly } from '@/lib/format-date'
import { eur } from '@/lib/format-money'

export interface PurchaseOrderPdfLine {
  productName: string
  uomName?: string | null
  orderedQty: unknown
  unitCost: unknown
  taxRate: unknown
  subtotalIncTax: unknown
}

export interface PurchaseOrderPdfData {
  name: string
  status: string
  supplierId: string
  orderDate: unknown
  createdAt: unknown
  expectedDate: unknown
  notes?: string | null
  subtotalExTax: unknown
  totalTax: unknown
  totalIncTax: unknown
  lines: PurchaseOrderPdfLine[]
}

export interface PurchaseOrderPdfSupplier {
  name: string
  street?: string | null
  street2?: string | null
  city?: string | null
  zip?: string | null
  address?: string | null
  phone?: string | null
  vatNumber?: string | null
}

export function renderPurchaseOrderHtml(
  po: PurchaseOrderPdfData,
  supplier: PurchaseOrderPdfSupplier | null,
): string {
  const supplierAddr = [
    supplier?.street || supplier?.address,
    supplier?.street2,
    supplier?.city,
    supplier?.zip,
  ].filter(Boolean).join(', ')

  const orderDate = formatDateOnly((po.orderDate ?? po.createdAt) as never)
  const expectedDate = formatDateOnly(po.expectedDate as never)

  const linesHtml = po.lines.map((l, i) => {
    const taxRate = Number(l.taxRate ?? 0)
    return `
      <tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
        <td class="col-qty">${Number(l.orderedQty).toFixed(3)}</td>
        <td class="col-unit">${l.uomName ?? ''}</td>
        <td class="col-desc">${l.productName}</td>
        <td class="col-price">${eur(l.unitCost)}</td>
        <td class="col-vat">${taxRate > 0 ? taxRate.toFixed(0) + '%' : '0%'}</td>
        <td class="col-incl">${eur(l.subtotalIncTax)}</td>
      </tr>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${po.status === 'DRAFT' ? 'RFQ' : 'Purchase Order'} ${po.name}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #111; background:#fff; }
  .page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 12mm 12mm 10mm; }

  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8mm; border-bottom: 2px solid #333; padding-bottom: 4mm; }
  .company-name { font-size: 22pt; font-weight: bold; color: #111; }
  .company-sub  { font-size: 8pt; color: #555; margin-top: 2px; }
  .doc-title { text-align: right; font-size: 16pt; font-weight: bold; color: #875A7B; }
  .doc-sub { text-align: right; font-size: 9pt; color: #555; margin-top: 2px; }

  .info-table { width: 100%; border-collapse: collapse; margin-bottom: 7mm; }
  .info-table td { border: 1px solid #bbb; padding: 3mm 4mm; vertical-align: top; width: 33.33%; }
  .info-head { font-size: 7.5pt; font-weight: bold; color: #555; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2mm; border-bottom: 1px solid #ddd; padding-bottom: 1mm; }
  .info-val  { font-size: 9pt; color: #111; line-height: 1.5; }

  .lines-table { width: 100%; border-collapse: collapse; margin-bottom: 5mm; }
  .lines-table thead tr { background: #333; color: #fff; }
  .lines-table thead th { padding: 2.5mm 3mm; font-size: 8pt; font-weight: bold; text-transform: uppercase; letter-spacing: 0.3px; }
  .lines-table tbody tr.row-even { background: #fff; }
  .lines-table tbody tr.row-odd  { background: #f7f7f7; }
  .lines-table tbody td { padding: 2mm 3mm; font-size: 9pt; border-bottom: 1px solid #e8e8e8; vertical-align: top; }

  .col-qty   { text-align: right; width: 10%; }
  .col-unit  { text-align: left;  width: 10%; }
  .col-desc  { text-align: left;  width: 40%; }
  .col-price { text-align: right; width: 13%; }
  .col-vat   { text-align: center; width: 7%; }
  .col-incl  { text-align: right; width: 13%; }

  .totals-wrap { display: flex; justify-content: flex-end; margin-bottom: 6mm; }
  .totals-table { width: 220px; border-collapse: collapse; }
  .totals-table tr td { padding: 2mm 3mm; font-size: 9.5pt; border-top: 1px solid #e0e0e0; }
  .total-label { color: #555; }
  .total-value { text-align: right; font-weight: 600; }
  .total-grand .total-label, .total-grand .total-value { font-weight: bold; font-size: 11pt; color: #111; border-top: 2px solid #333; }

  .notes { margin-top: 4mm; font-size: 9pt; color: #333; }
  .notes .info-head { margin-bottom: 1mm; }

  .footer { position: fixed; bottom: 8mm; left: 12mm; right: 12mm; border-top: 1px solid #ccc; padding-top: 2mm; display: flex; justify-content: space-between; font-size: 7.5pt; color: #666; }

  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { padding: 8mm 10mm 18mm; }
  }
</style>
</head>
<body>
<div class="page">

  <div class="header">
    <div>
      <div class="company-name">JohnstoneBros</div>
      <div class="company-sub">Wholesale Fresh Produce &amp; Grocery</div>
    </div>
    <div>
      <div class="doc-title">${po.status === 'DRAFT' ? 'REQUEST FOR QUOTATION' : 'PURCHASE ORDER'}</div>
      <div class="doc-sub">${po.name}</div>
    </div>
  </div>

  <table class="info-table">
    <tr>
      <td>
        <div class="info-head">Supplier</div>
        <div class="info-val">
          <strong>${supplier?.name ?? po.supplierId}</strong><br/>
          ${supplierAddr ? supplierAddr + '<br/>' : ''}
          ${supplier?.phone ? 'Tel: ' + supplier.phone + '<br/>' : ''}
          ${supplier?.vatNumber ? 'VAT: ' + supplier.vatNumber : ''}
        </div>
      </td>
      <td>
        <div class="info-head">Order Date</div>
        <div class="info-val">${orderDate}</div>
      </td>
      <td>
        <div class="info-head">Expected Date</div>
        <div class="info-val">${expectedDate || '—'}</div>
      </td>
    </tr>
  </table>

  <table class="lines-table">
    <thead>
      <tr>
        <th class="col-qty">QTY</th>
        <th class="col-unit">UNIT</th>
        <th class="col-desc">DESCRIPTION</th>
        <th class="col-price">UNIT COST</th>
        <th class="col-vat">VAT</th>
        <th class="col-incl">TOTAL</th>
      </tr>
    </thead>
    <tbody>
      ${linesHtml || '<tr><td colspan="6" style="text-align:center;padding:6mm;color:#999">No items</td></tr>'}
    </tbody>
  </table>

  <div class="totals-wrap">
    <table class="totals-table">
      <tr>
        <td class="total-label">Subtotal</td>
        <td class="total-value">${eur(po.subtotalExTax)}</td>
      </tr>
      <tr>
        <td class="total-label">Tax</td>
        <td class="total-value">${eur(po.totalTax)}</td>
      </tr>
      <tr class="total-grand">
        <td class="total-label">Total</td>
        <td class="total-value">${eur(po.totalIncTax)}</td>
      </tr>
    </table>
  </div>

  ${po.notes ? `<div class="notes"><div class="info-head">Notes</div><div>${po.notes}</div></div>` : ''}

</div>

<div class="footer">
  <span>Tel: +353 1 234 5678 &nbsp;|&nbsp; info@johnstonebros.ie &nbsp;|&nbsp; www.johnstonebros.ie &nbsp;|&nbsp; VAT: IE1234567T</span>
  <span>Page 1/1 &nbsp;|&nbsp; Printed: <span id="print-ts"></span></span>
</div>

<script>
  var ts = new Date();
  var pad = function(n){ return n < 10 ? '0'+n : ''+n; };
  document.getElementById('print-ts').textContent =
    pad(ts.getDate()) + '/' + pad(ts.getMonth()+1) + '/' + ts.getFullYear() +
    ' ' + pad(ts.getHours()) + ':' + pad(ts.getMinutes());
</script>
</body>
</html>`
}
```

- [ ] **Step 4: Update `app/api/purchase-orders/[id]/pdf/route.ts` to use it**

Replace the whole file with:

```ts
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { renderPurchaseOrderHtml } from '@/lib/purchase-order-pdf'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const po = await p.purchaseOrder.findUnique({
      where: { id },
      include: { lines: { orderBy: { sequence: 'asc' } } },
    })
    if (!po) return NextResponse.json({ error: '采购单不存在' }, { status: 404 })

    const supplier = await prisma.customer.findUnique({ where: { id: po.supplierId } })
    const html = renderPurchaseOrderHtml(po, supplier)

    return new NextResponse(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  } catch (error) {
    console.error('[GET /api/purchase-orders/[id]/pdf]', error)
    return NextResponse.json({ error: 'PDF generation failed' }, { status: 500 })
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/purchase-order-pdf.test.ts`
Expected: PASS, 4/4 tests green.

- [ ] **Step 6: Manually re-verify the print route still works**

Run: `npm run dev`, open an existing DRAFT purchase order's detail page, click "📄 View PDF"/print — confirm the browser shows the same layout as before (RFQ title, supplier block, line items, totals).

- [ ] **Step 7: Commit**

```bash
git add lib/purchase-order-pdf.ts tests/purchase-order-pdf.test.ts "app/api/purchase-orders/[id]/pdf/route.ts"
git commit -m "$(cat <<'EOF'
refactor(purchase-orders): extract PO PDF rendering into a testable pure function

Sub-project ① step 1/4 — the send-RFQ-email flow (next task) needs the same
HTML template to build a PDF attachment; extracting it also gives the
template its first unit test coverage.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Add the RFQ email template

**Files:**
- Modify: `lib/email.ts`

**Interfaces:**
- Consumes: none (standalone, uses existing `getResend()`/`FROM` from the same file).
- Produces: `sendPurchaseOrderRfq(params: { to: string; poName: string; supplierName: string; pdfBuffer: Buffer }): Promise<void>` — consumed by Task 3.

- [ ] **Step 1: Implement `sendPurchaseOrderRfq`**

No automated test for this step — the two existing functions in this file (`sendOrderConfirmation`, `sendPasswordReset`) also have no unit tests, since testing them would require mocking the Resend network client; verification happens via Task 3's manual email-delivery check instead.

Append to `lib/email.ts`:

```ts
export async function sendPurchaseOrderRfq(params: {
  to: string
  poName: string
  supplierName: string
  pdfBuffer: Buffer
}) {
  const { to, poName, supplierName, pdfBuffer } = params

  await getResend().emails.send({
    from: FROM,
    to,
    subject: `Request for Quotation ${poName} — VeggieSupply`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <h2 style="color:#16a34a">VeggieSupply — Request for Quotation</h2>
        <p>Dear ${supplierName},</p>
        <p>Please find attached our request for quotation <strong>${poName}</strong>. Kindly review the items and quantities and let us know your confirmed pricing and availability at your earliest convenience.</p>
        <p>If you have any questions, please reply to this email or contact your usual VeggieSupply contact.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
        <p style="color:#9ca3af;font-size:12px">VeggieSupply Ireland</p>
      </div>
    `,
    attachments: [
      { filename: `${poName}.pdf`, content: pdfBuffer },
    ],
  })
}
```

(`EmailApiAttachment.content` accepts `string | Buffer` per `node_modules/resend/dist/index.d.mts` — confirmed, no base64 conversion needed.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors introduced by `lib/email.ts`.

- [ ] **Step 3: Commit**

```bash
git add lib/email.ts
git commit -m "$(cat <<'EOF'
feat(email): add sendPurchaseOrderRfq template

Sub-project ① step 2/4. Reuses the existing Resend client/FROM address;
wired into the send action in the next task.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire real email sending into the PATCH `send` action

**Files:**
- Modify: `app/api/purchase-orders/[id]/route.ts:1-23` (imports + no other constant changes), and the `PATCH` handler body around lines 311–315 (right after the `ALLOWED_TRANSITIONS` check, before the `P0-1: Cancel check` block).

**Interfaces:**
- Consumes: `renderPurchaseOrderHtml` from `@/lib/purchase-order-pdf` (Task 1), `renderHtmlToPdf` from `@/lib/print/render-pdf` (pre-existing), `sendPurchaseOrderRfq` from `@/lib/email` (Task 2).
- Produces: on `PATCH { action: 'send' }` — `400 { error: 'SUPPLIER_EMAIL_MISSING', message }` if the supplier has no email; `502 { error: 'EMAIL_SEND_FAILED', message }` if Resend throws (status stays unchanged in both cases); otherwise proceeds exactly as before (status → SENT).

- [ ] **Step 1: Add imports**

In `app/api/purchase-orders/[id]/route.ts`, add after the existing `import { eurAmount, resolveExchangeRate } from '@/lib/fx-eur'` line:

```ts
import { renderPurchaseOrderHtml } from '@/lib/purchase-order-pdf'
import { renderHtmlToPdf } from '@/lib/print/render-pdf'
import { sendPurchaseOrderRfq } from '@/lib/email'
```

- [ ] **Step 2: Insert the send-email gate in the PATCH handler**

Find this existing block (currently lines 311–315):

```ts
      if (!(ALLOWED_TRANSITIONS[po.status] ?? []).includes(targetStatus)) {
        return NextResponse.json({
          error: `状态转换不合法: ${po.status} → ${targetStatus}`,
        }, { status: 409 })
      }

      // P0-1: Cancel check — reject if related documents exist
```

Insert a new block between them:

```ts
      if (!(ALLOWED_TRANSITIONS[po.status] ?? []).includes(targetStatus)) {
        return NextResponse.json({
          error: `状态转换不合法: ${po.status} → ${targetStatus}`,
        }, { status: 409 })
      }

      // 真正把询价单发给供应商：邮箱缺失/邮件发送失败都在这里挡住，
      // 不允许出现"界面显示已发送但实际没发邮件"的假成功(20260730)
      if (action === 'send') {
        const supplier = await p.customer.findUnique({ where: { id: po.supplierId } })
        if (!supplier?.email) {
          return NextResponse.json({
            error: 'SUPPLIER_EMAIL_MISSING',
            message: '该供应商未设置邮箱地址，请先在客户资料中补全邮箱后再发送',
          }, { status: 400 })
        }
        try {
          // po.lines 在本函数开头是无序 include 出来的（不像 pdf/route.ts 那样 orderBy sequence），
          // 邮件附件要展示跟详情页/打印页一致的行顺序，这里补一次排序，不用为此多打一次 DB
          const orderedLines = [...po.lines].sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0))
          const pdfBuffer = await renderHtmlToPdf(renderPurchaseOrderHtml({ ...po, lines: orderedLines }, supplier))
          await sendPurchaseOrderRfq({
            to: supplier.email,
            poName: po.name,
            supplierName: supplier.name,
            pdfBuffer,
          })
        } catch (err) {
          console.error('[PATCH /api/purchase-orders/:id] send RFQ email failed', err)
          return NextResponse.json({
            error: 'EMAIL_SEND_FAILED',
            message: '邮件发送失败，请稍后重试',
          }, { status: 502 })
        }
      }

      // P0-1: Cancel check — reject if related documents exist
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Manual verification — missing supplier email**

Pick (or temporarily create) a DRAFT purchase order whose supplier has `email = ''`. Run:

```bash
TOKEN="<a valid OPERATOR/BOSS/WAREHOUSE JWT>"
curl -s -w "\n--- STATUS: %{http_code} ---\n" \
  -X PATCH "http://localhost:3000/api/purchase-orders/<PO_ID>" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"send"}'
```

Expected: `STATUS: 400`, body contains `"error":"SUPPLIER_EMAIL_MISSING"`; re-fetch the PO and confirm `status` is still `DRAFT`.

- [ ] **Step 5: Manual verification — successful send**

Set that supplier's `email` to a real inbox you can check (via the customer edit page), then repeat the same `curl` call.

Expected: `STATUS: 200`, `status` in the response body is `SENT`; the mailbox receives an email titled "Request for Quotation PO-xxxxx — VeggieSupply" with a PDF attachment; opening the PDF shows "REQUEST FOR QUOTATION" and the correct line items.

- [ ] **Step 6: Manual verification — email failure doesn't corrupt state**

Temporarily set `RESEND_API_KEY` to an invalid value in your local `.env.local`, restart `npm run dev`, repeat the same `curl` call against a DRAFT PO with a valid supplier email.

Expected: `STATUS: 502`, body contains `"error":"EMAIL_SEND_FAILED"`; PO status remains `DRAFT`. Restore the real `RESEND_API_KEY` afterward.

- [ ] **Step 7: Commit**

```bash
git add "app/api/purchase-orders/[id]/route.ts"
git commit -m "$(cat <<'EOF'
fix(purchase-orders): send action now actually emails the supplier

Previously "发送邮件"/Send by Email only flipped DRAFT->SENT with no email
ever sent. Now it generates a PDF via the shared renderer and sends it
through Resend before flipping status; a missing supplier email or a
Resend failure blocks the transition instead of silently no-op'ing.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `CopyFromHistoryModal` component

**Files:**
- Create: `app/[locale]/classic/operator/purchases/new/_components/CopyFromHistoryModal.tsx`

**Interfaces:**
- Produces: `export interface HistoryPOLine { productId: string; productName: string; uomId: string | null; orderedQty: number; unitCost: number; taxRate: number }`, `export interface HistoryPO { id: string; name: string; orderDate: string; status: string; totalIncTax: number; lines: HistoryPOLine[] }`, and the default-exported component `CopyFromHistoryModal({ supplierId, isEn, onClose, onPick }: { supplierId: string; isEn: boolean; onClose: () => void; onPick: (po: HistoryPO) => void })` — consumed by Task 5.
- Consumes: `apiGet` from `@/lib/api`, `formatDateOnly` from `@/lib/format-date`, `GET /api/purchase-orders?supplierId=...&limit=20` (pre-existing endpoint, already returns `lines` and a computed `totalIncTax`/`status`/`orderDate`/`name`).

No automated test — no existing `.test.tsx` convention in this repo (confirmed via `find . -iname "*.test.tsx"` → empty); verified manually in Task 5's browser walkthrough.

- [ ] **Step 1: Implement the component**

```tsx
'use client'
import { useEffect, useState } from 'react'
import { apiGet } from '@/lib/api'
import { formatDateOnly } from '@/lib/format-date'

const PURPLE = '#875A7B'

export interface HistoryPOLine {
  productId: string
  productName: string
  uomId: string | null
  orderedQty: number
  unitCost: number
  taxRate: number
}

export interface HistoryPO {
  id: string
  name: string
  orderDate: string
  status: string
  totalIncTax: number
  lines: HistoryPOLine[]
}

/** 新建采购单页"从历史单复制"：按供应商列出历史采购单，选中后把行项目原样带入当前草稿 */
export default function CopyFromHistoryModal({
  supplierId,
  isEn,
  onClose,
  onPick,
}: {
  supplierId: string
  isEn: boolean
  onClose: () => void
  onPick: (po: HistoryPO) => void
}) {
  const [loading, setLoading] = useState(true)
  const [orders, setOrders] = useState<HistoryPO[]>([])

  useEffect(() => {
    setLoading(true)
    apiGet<HistoryPO[]>(`/api/purchase-orders?supplierId=${encodeURIComponent(supplierId)}&limit=20`)
      .then(setOrders)
      .catch(() => setOrders([]))
      .finally(() => setLoading(false))
  }, [supplierId])

  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[80vh] overflow-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-800">{isEn ? 'Copy from Historical Order' : '从历史单复制'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
        </div>

        {loading ? (
          <p className="text-sm text-gray-400 py-8 text-center">{isEn ? 'Loading…' : '加载中…'}</p>
        ) : orders.length === 0 ? (
          <p className="text-sm text-gray-400 py-8 text-center">
            {isEn ? 'No historical purchase orders for this supplier yet' : '该供应商暂无历史采购单'}
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400">
                <th className="text-left font-normal py-1">{isEn ? 'Order' : '单号'}</th>
                <th className="text-left font-normal py-1">{isEn ? 'Date' : '日期'}</th>
                <th className="text-left font-normal py-1">{isEn ? 'Status' : '状态'}</th>
                <th className="text-right font-normal py-1">{isEn ? 'Total' : '金额'}</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {orders.map(po => (
                <tr key={po.id} className="border-t border-gray-100">
                  <td className="py-1.5 font-medium" style={{ color: PURPLE }}>{po.name}</td>
                  <td className="py-1.5 text-gray-500">{formatDateOnly(po.orderDate)}</td>
                  <td className="py-1.5 text-gray-500">{po.status}</td>
                  <td className="py-1.5 text-right">{po.totalIncTax.toFixed(2)}</td>
                  <td className="py-1.5 text-right">
                    <button
                      onClick={() => { onPick(po); onClose() }}
                      className="text-xs hover:underline"
                      style={{ color: PURPLE }}
                    >
                      {isEn ? 'Copy' : '复制'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add "app/[locale]/classic/operator/purchases/new/_components/CopyFromHistoryModal.tsx"
git commit -m "$(cat <<'EOF'
feat(purchases): add CopyFromHistoryModal component

Sub-project ① step 3/4. Lists a supplier's past purchase orders via the
existing GET /api/purchase-orders?supplierId= endpoint; wired into the
new-PO page in the next task.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Wire "从历史单复制" into the new-PO page

**Files:**
- Modify: `app/[locale]/classic/operator/purchases/new/page.tsx`

**Interfaces:**
- Consumes: `CopyFromHistoryModal`, `HistoryPO` from Task 4 (`./_components/CopyFromHistoryModal`); reads/writes the page's existing `lines: DraftLine[]` state, `lineSeq` ref, `purchaseProducts` state (all pre-existing in this file).

- [ ] **Step 1: Import the new component and add state**

Add to the import block (near the other `_components` imports):

```ts
import CopyFromHistoryModal, { type HistoryPO } from './_components/CopyFromHistoryModal'
```

Add alongside the other `useState` declarations (near `priceHistoryTarget`):

```ts
  const [showCopyFromHistory, setShowCopyFromHistory] = useState(false)
```

- [ ] **Step 2: Add the copy handler**

Add this function near `addProductLine` (it deliberately does not touch `bestBefore` — a copied historical shipment date isn't meaningful for a brand-new order, so lines start with `bestBefore: null`, same as a freshly added product line):

```ts
  /** 从历史采购单复制行项目：数量/单价原样带入，供应商已由弹窗的调用方（当前 supplierId）限定 */
  function handleCopyFromHistory(historyPo: HistoryPO) {
    if (historyPo.lines.length === 0) {
      toast.info(isEn ? `${historyPo.name} has no line items to copy` : `${historyPo.name} 没有可复制的行项目`)
      return
    }
    const newLines: DraftLine[] = historyPo.lines.map(hl => {
      lineSeq.current += 1
      const product = purchaseProducts.find(p => p.id === hl.productId)
      const qty = Number(hl.orderedQty)
      const unitCost = Number(hl.unitCost)
      const taxRate = Number(hl.taxRate)
      const subtotalExTax = qty * unitCost
      const taxAmount = subtotalExTax * taxRate / 100
      return {
        id: `new-${lineSeq.current}`,
        productId: hl.productId,
        productName: hl.productName,
        spec: product?.category ?? null,
        uomId: hl.uomId,
        uomName: product?.uomName ?? null,
        orderedQty: qty,
        unitCost,
        taxRate,
        bestBefore: null,
        subtotalExTax,
        taxAmount,
        subtotalIncTax: subtotalExTax + taxAmount,
      }
    })
    setLines(prev => [...prev, ...newLines])
    toast.success(isEn
      ? `Copied ${newLines.length} line(s) from ${historyPo.name}`
      : `已从 ${historyPo.name} 复制 ${newLines.length} 行`)
  }
```

- [ ] **Step 3: Add the entry point next to the Supplier field**

Find this block:

```tsx
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Supplier *' : '供应商 *'}</label>
                  <select
                    value={supplierId}
                    onChange={e => setSupplierId(e.target.value)}
                    className={`flex-1 ${inputCls}`}
                  >
                    <option value="">{isEn ? 'Please select a supplier...' : '请选择供应商...'}</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
```

Replace with:

```tsx
                <div className="flex items-center min-h-[32px]">
                  <label className="w-36 text-sm text-gray-500 flex-shrink-0">{isEn ? 'Supplier *' : '供应商 *'}</label>
                  <select
                    value={supplierId}
                    onChange={e => setSupplierId(e.target.value)}
                    className={`flex-1 ${inputCls}`}
                  >
                    <option value="">{isEn ? 'Please select a supplier...' : '请选择供应商...'}</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {supplierId && (
                    <button
                      onClick={() => setShowCopyFromHistory(true)}
                      className="ml-3 text-xs whitespace-nowrap hover:underline flex-shrink-0"
                      style={{ color: PURPLE }}
                    >
                      {isEn ? 'Copy from history' : '从历史单复制'}
                    </button>
                  )}
                </div>
```

- [ ] **Step 4: Render the modal**

Add next to the existing `{priceHistoryTarget && (...)}` block (same parent, right before or after it):

```tsx
      {showCopyFromHistory && (
        <CopyFromHistoryModal
          supplierId={supplierId}
          isEn={isEn}
          onClose={() => setShowCopyFromHistory(false)}
          onPick={handleCopyFromHistory}
        />
      )}
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Manual browser verification**

Run `npm run dev`, then:
1. Go to New Purchase Order, select a supplier that has at least one past purchase order (any status).
2. Confirm "从历史单复制"/"Copy from history" link appears only after a supplier is selected.
3. Click it, confirm the modal lists that supplier's past orders with correct date/status/total.
4. Click "复制"/"Copy" on one — confirm the modal closes and the line table now shows those products with the same quantities/unit prices as the historical order (verify against the historical order's detail page).
5. Edit a copied quantity, save the new PO, then re-open the historical PO and confirm its own quantities are unchanged (independent records).
6. Select a supplier with no history — confirm the modal shows the empty state instead of erroring.

- [ ] **Step 7: Commit**

```bash
git add "app/[locale]/classic/operator/purchases/new/page.tsx"
git commit -m "$(cat <<'EOF'
feat(purchases): wire copy-from-history into the new purchase order page

Sub-project ① step 4/4. Completes the purchase RFQ sub-project: send now
really emails the supplier (Task 3), and a new PO can now be seeded from
an existing one for the same supplier.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Full-plan verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the 4 new ones from Task 1.

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 3: Re-run the Task 3 manual checks end-to-end once more** on top of the finished branch (missing-email block, successful send + email received, email-failure-doesn't-corrupt-state), plus the Task 5 browser walkthrough, to catch any regression introduced by later tasks.

- [ ] **Step 4: Update the design doc's "已知遗留" section if anything changed during implementation**

Read `docs/20260730-purchase-rfq-design.md` and confirm it still matches what was built; if any decision changed during implementation (e.g. a different HTTP status code), update the doc to match reality.
