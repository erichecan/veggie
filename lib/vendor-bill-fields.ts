/** VendorBill 字段规整规则，POST /api/vendor-bills 与 PUT /api/vendor-bills/[id] 共用——
 *  20260922 code review 指出两处各写一份会让长度上限/trim 规则悄悄分叉。 */
export const SUPPLIER_INVOICE_REF_MAX_LEN = 100

export function normalizeSupplierInvoiceRef(value: unknown): string | null {
  if (!value) return null
  const trimmed = String(value).trim()
  return trimmed ? trimmed.slice(0, SUPPLIER_INVOICE_REF_MAX_LEN) : null
}
