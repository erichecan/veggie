import { prisma } from './db'

/**
 * 客户 / 供应商删除前的"有没有业务单据"检查（20261007）
 * ============================================================================
 * 客户和供应商同一张 Customer 表。下面这些表用的是**软引用**(存了 customerId /
 * supplierId 字符串，但数据库没有外键约束)，物理删掉客户后它们不会报错、也不会级联，
 * 只会留下一堆指向不存在客户的发票/付款/采购单——对账、报表、打印全都会坏。
 * 所以：只要有任何一条这类单据，就不允许删，提示改用「归档」(isActive=false，
 * 历史完整保留、可恢复)。
 *
 * 真正有外键 + onDelete: Cascade 的子表(联系人、挂的价格表、专属价、账期延长、
 * 商品-供应商关联)是这条档案自己的配置，随档案一起删掉是对的，不在这里拦。
 */

export interface DeleteBlocker { zh: string; en: string }

interface RefSource {
  zh: string
  en: string
  count: (ids: string[]) => Promise<Array<{ id: string; n: number }>>
}

function grouped<T extends string>(
  rows: Array<Record<T, string | null> & { _count: { _all: number } }>,
  key: T,
): Array<{ id: string; n: number }> {
  return rows.filter(r => r[key]).map(r => ({ id: r[key] as string, n: r._count._all }))
}

const SOURCES: RefSource[] = [
  {
    zh: '个餐馆端登录账号(订单挂在账号上)', en: 'restaurant login account(s) (orders are linked to them)',
    count: async ids => grouped(await prisma.user.groupBy({ by: ['customerId'], where: { customerId: { in: ids } }, _count: { _all: true } }), 'customerId'),
  },
  {
    zh: '张发票', en: 'invoice(s)',
    count: async ids => grouped(await prisma.invoice.groupBy({ by: ['customerId'], where: { customerId: { in: ids } }, _count: { _all: true } }), 'customerId'),
  },
  {
    zh: '笔收款', en: 'payment(s)',
    count: async ids => grouped(await prisma.payment.groupBy({ by: ['customerId'], where: { customerId: { in: ids } }, _count: { _all: true } }), 'customerId'),
  },
  {
    zh: '张送货单', en: 'delivery slip(s)',
    count: async ids => grouped(await prisma.deliverySlip.groupBy({ by: ['customerId'], where: { customerId: { in: ids } }, _count: { _all: true } }), 'customerId'),
  },
  {
    zh: '张对账单', en: 'statement(s)',
    count: async ids => grouped(await prisma.statement.groupBy({ by: ['customerId'], where: { customerId: { in: ids } }, _count: { _all: true } }), 'customerId'),
  },
  {
    zh: '张贷项通知单', en: 'credit note(s)',
    count: async ids => grouped(await prisma.creditNote.groupBy({ by: ['customerId'], where: { customerId: { in: ids } }, _count: { _all: true } }), 'customerId'),
  },
  {
    zh: '条会计分录', en: 'journal entry line(s)',
    count: async ids => grouped(await prisma.journalEntryLine.groupBy({ by: ['partnerId'], where: { partnerId: { in: ids } }, _count: { _all: true } }), 'partnerId'),
  },
  {
    zh: '张采购单', en: 'purchase order(s)',
    count: async ids => grouped(await prisma.purchaseOrder.groupBy({ by: ['supplierId'], where: { supplierId: { in: ids } }, _count: { _all: true } }), 'supplierId'),
  },
  {
    zh: '张供应商账单', en: 'vendor bill(s)',
    count: async ids => grouped(await prisma.vendorBill.groupBy({ by: ['supplierId'], where: { supplierId: { in: ids } }, _count: { _all: true } }), 'supplierId'),
  },
  {
    zh: '笔供应商付款', en: 'vendor payment(s)',
    count: async ids => grouped(await prisma.vendorPayment.groupBy({ by: ['supplierId'], where: { supplierId: { in: ids } }, _count: { _all: true } }), 'supplierId'),
  },
  {
    zh: '条采购记录', en: 'purchase record(s)',
    count: async ids => grouped(await prisma.purchaseRecord.groupBy({ by: ['supplierId'], where: { supplierId: { in: ids } }, _count: { _all: true } }), 'supplierId'),
  },
]

/** id → 挡住删除的原因列表(没有原因的 id 不在 map 里 = 可以删) */
export async function findDeleteBlockers(ids: string[]): Promise<Map<string, DeleteBlocker[]>> {
  const out = new Map<string, DeleteBlocker[]>()
  if (ids.length === 0) return out
  // 逐个来源串行查：每条都是一次带索引的 groupBy，并发打满 Neon 连接池没有必要
  for (const src of SOURCES) {
    for (const { id, n } of await src.count(ids)) {
      const list = out.get(id) ?? []
      list.push({ zh: `${n} ${src.zh}`, en: `${n} ${src.en}` })
      out.set(id, list)
    }
  }
  return out
}
