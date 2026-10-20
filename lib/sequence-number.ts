/**
 * 单据编号发号(VB-00001 / STK-00001 / DISC-00001 / CN-20261013-0001 …)—— 20261013
 * ============================================================================
 * 这些编号都是唯一键，以前一律 `count() + 1`：只要删过一张(或编号有空号)，count+1 就撞上已有的号，
 * 之后每次新建都 500(采购单编号、收货批次号已先后出过这个事故)。统一改为「同前缀下现有最大号 + 1」。
 * 表名/列名只能取下面白名单里的(拼进 SQL 的标识符不接受外部输入)；前缀走参数绑定。
 */
const NUMBERED_COLUMNS = {
  PurchaseOrder: 'name',
  VendorBill: 'name',
  StockTake: 'name',
  CreditNote: 'name',
  OrderDiscrepancy: 'code',
  Lot: 'lotNumber',
  Invoice: 'name',
} as const

export type NumberedTable = keyof typeof NUMBERED_COLUMNS

/** 同前缀下现有最大数字 + 1(没有则 1) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function nextSequenceNumber(client: any, table: NumberedTable, prefix: string): Promise<number> {
  const col = NUMBERED_COLUMNS[table]
  const rows: Array<{ max: number | null }> = await client.$queryRawUnsafe(
    `SELECT MAX(CAST(SUBSTRING("${col}" FROM ${prefix.length + 1}) AS INTEGER)) AS "max"
       FROM "${table}"
      WHERE LEFT("${col}", ${prefix.length}) = $1
        AND SUBSTRING("${col}" FROM ${prefix.length + 1}) ~ '^[0-9]{1,9}$'`,
    prefix,
  )
  return Number(rows[0]?.max ?? 0) + 1
}

/** 生成完整编号，如 nextSequenceName(tx, 'VendorBill', 'VB-', 5) → 'VB-00012' */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function nextSequenceName(client: any, table: NumberedTable, prefix: string, pad: number): Promise<string> {
  return `${prefix}${String(await nextSequenceNumber(client, table, prefix)).padStart(pad, '0')}`
}
