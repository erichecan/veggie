/**
 * 条形码取值。CODE128 只能编码 ASCII——单号含中文(如创建者缩写"运营"→"运营-260701-001")时
 * JsBarcode CODE128 会抛错，导致条形码整块空白。此处：单号为纯 ASCII 则用它，否则回退到
 * fallback(通常是 order.id / invoice.id，全局唯一且 ASCII)。可见文字仍显示原单号，仅条形码取值回退。
 */
export function barcodeValue(code: string | null | undefined, fallback: string): string {
  const c = (code ?? '').trim()
  return c && /^[\x00-\x7F]+$/.test(c) ? c : fallback
}
