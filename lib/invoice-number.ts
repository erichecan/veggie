/**
 * 销售单发票号（20260920）
 * ============================================================================
 * 客户要求销售单上印「Invoice No.」，号与 Odoo 历史发票同一序列（V#####），
 * 从 V59086 接着往下排（客户 20260920 拍板的方案 B）。
 *
 * 号池是**两张表共用**的：
 *   - `Invoice.name` —— Odoo 迁移进来的 14.8 万张历史发票（V1 ~ V59085 + INV/... 格式）
 *   - `Order.invoiceNo` —— 本模块发出去的新号
 * 发号时两张表都要避开，否则新号会撞上历史发票。
 *
 * ⚠️ 未验证的前提：如果 Odoo 12 现在仍在开票，它那边也会继续发 V59086、V59087…，
 * 和这里撞号。`Order.invoiceNo` 的 UNIQUE 只拦得住本系统内部重复，拦不住 Odoo。
 * 真要发生，把 SERIES_START 挪到一个不重叠的区间（例如 90000）即可，改这一行就够。
 *
 * ⚠️ 已知行为（20260920 code review 后确认保留）：打开打印页就会发号，
 * 因此「打开预览又取消打印」会在号段里留下一个空洞。改成「点了打印才发号」需要把
 * 取数接口改 POST 并改动 4 个调用方与两处权限表，而现有调用方**全部**是真打印意图
 * （打印中心的三个按钮 + 打印页本身），收益不抵风险。跳号本身不影响对账：
 * 号是唯一且单调的，只是不连续。
 */
import 'server-only'
import { prisma } from '@/lib/db'
import type { Prisma } from '@/lib/generated/prisma/client'

/** 号段起点：接着生产库现有最大 V 号（V59085）往下排 */
const SERIES_START = 59086
const PREFIX = 'V'

/** 一次发号最多重试几次 —— advisory lock 之外的兜底 */
const MAX_RETRY = 8

/**
 * 批量发号的事务超时。默认 5s 是按「单张单」定的，一次打一整车（20+ 张）时
 * 算 max + 逐单写号会顶到上限，而超时抛的是 P2028，**不是**唯一约束冲突，
 * 下面的重试认不出来，会直接变成 500。给足时间比事后猜错误码可靠。
 */
const BATCH_TX_TIMEOUT_MS = 20_000

/**
 * 发号用的 advisory lock key（任意常量，全库唯一即可）。
 *
 * 为什么要锁：发号是「读当前最大号 → +1 → 写回」，这是典型的读-改-写。
 * 只靠唯一约束 + 重试，在打印中心一次打一整车（20+ 张单）时会大量互撞，
 * 实测 20 路并发直接把重试打爆。pg_advisory_xact_lock 把这一小段串行化，
 * 事务结束自动释放，不需要手工解锁，也不会留下悬挂的锁。
 * 发号频率很低（一天几十张单），串行完全不构成瓶颈。
 */
const LOCK_KEY = 202609200001

/** 唯一约束冲突的识别：兼容 Prisma 原生错误码与 driver adapter 包装后的形态 */
function isUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const code = (e as { code?: string }).code
  if (code === 'P2002' || code === '23505') return true
  const text = `${(e as { message?: string }).message ?? ''}${String((e as { cause?: unknown }).cause ?? '')}`
  return /UniqueConstraintViolation|duplicate key value|P2002/i.test(text)
}

function format(n: number): string {
  return `${PREFIX}${n}`
}

/**
 * 当前号池里用掉的最大序号。
 *
 * 生产实测（20260920，Invoice 148285 行 / 其中 V 格式 25223 行）：
 * 第一条走 `Invoice_name_key` 的 Index Only Scan，**43.5ms**；第二条 **0.66ms**。
 * 所以不需要为它另建表达式索引 —— 真正该省的是**调用次数**，见 allocateBatch：
 * 一次事务里只算一次，整车 20 单从 20×43ms 降到 1×43ms。
 *
 * ⛔ 两条查询必须**顺序**跑，不能 Promise.all：它们共用同一个 interactive
 * transaction client，Prisma 不保证同一个 tx 上的并发请求安全。
 */
async function currentMax(tx: Prisma.TransactionClient): Promise<number> {
  const invoiceRows = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(CAST(SUBSTRING(name FROM 2) AS INTEGER)) AS max
    FROM "Invoice" WHERE name ~ '^V[0-9]+$'
  `
  const orderRows = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(CAST(SUBSTRING("invoiceNo" FROM 2) AS INTEGER)) AS max
    FROM "Order" WHERE "invoiceNo" ~ '^V[0-9]+$'
  `
  const a = Number(invoiceRows[0]?.max ?? 0)
  const b = Number(orderRows[0]?.max ?? 0)
  return Math.max(a, b, SERIES_START - 1)
}

/** 这个号是不是已经被 Invoice 表占了（Odoo 历史发票里可能有断号回填） */
async function takenByInvoice(tx: Prisma.TransactionClient, name: string): Promise<boolean> {
  const hit = await tx.invoice.findUnique({ where: { name }, select: { id: true } })
  return !!hit
}

/**
 * 这些订单里，哪些已经被财务开出的**真实发票**覆盖了。
 *
 * ⛔ 已开票的订单**不能**再发自己的号：真发票号才是纸上要印的（见 lib/print/invoice-lookup.ts），
 * 给它发一个永远印不出来的 V 号，只会在号段里白占一个坑。
 * Invoice.saleOrderIds 是字符串数组不是外键，一张票可合并多单。
 */
async function coveredByRealInvoice(orderIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (orderIds.length === 0) return out
  const invoices = await prisma.invoice.findMany({
    where: { saleOrderIds: { hasSome: orderIds } },
    select: { name: true, saleOrderIds: true },
  })
  const wanted = new Set(orderIds)
  for (const inv of invoices) {
    for (const orderId of inv.saleOrderIds) {
      if (!wanted.has(orderId)) continue
      const existing = out.get(orderId)
      out.set(orderId, existing ? `${existing}, ${inv.name}` : inv.name)
    }
  }
  return out
}

/**
 * 在**一个事务**里给若干订单连续发号：拿一次锁、算一次 max、逐个写。
 * 调用方必须已经滤掉「已有号」和「已被真实发票覆盖」的订单。
 */
async function allocateBatch(orderIds: string[]): Promise<Map<string, string>> {
  for (let attempt = 0; attempt < MAX_RETRY; attempt += 1) {
    try {
      return await prisma.$transaction(async tx => {
        // 串行化发号，见 LOCK_KEY 注释
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY}::bigint)`

        // 等锁期间另一个请求可能刚把号占掉，事务内重查一次
        const fresh = await tx.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, invoiceNo: true },
        })
        const out = new Map<string, string>()
        const pending: string[] = []
        for (const o of fresh) {
          if (o.invoiceNo) out.set(o.id, o.invoiceNo)
          else pending.push(o.id)
        }
        if (pending.length === 0) return out

        let next = (await currentMax(tx)) + 1
        for (const id of pending) {
          // 跳过 Invoice 表已占用的号（历史断号被回填过的情况）
          while (await takenByInvoice(tx, format(next))) next += 1
          const name = format(next)
          await tx.order.update({ where: { id }, data: { invoiceNo: name } })
          out.set(id, name)
          next += 1
        }
        return out
      }, { timeout: BATCH_TX_TIMEOUT_MS })
    } catch (e) {
      // 并发下号被别人抢先占了 → 整批重来。
      // ⚠️ 不能只认 `code === 'P2002'`：Prisma 7 走 driver adapter 时，唯一约束冲突
      // 会被包成 DriverAdapterError（UniqueConstraintViolation），外层 code 不是 P2002，
      // 只判 P2002 会把可重试的冲突当成致命错误直接抛出去（实测踩过）。
      if (!isUniqueViolation(e)) throw e
      if (attempt === MAX_RETRY - 1) throw e
    }
  }
  return new Map()
}

/**
 * 给一张订单分配发票号；已经有号的直接返回原号（幂等 —— 重复打印同一张单，
 * 号必须不变，否则客户手上两张纸号不一样，会计会当成两笔账）。
 * 已被真实发票覆盖的返回那张票的号，且**不写库**。
 */
export async function ensureInvoiceNumber(orderId: string): Promise<string | null> {
  const map = await ensureInvoiceNumbers([orderId])
  return map.get(orderId) ?? null
}

/**
 * 批量确保发票号（打印中心一次打一整车的单）。
 *
 * 三步，前两步都是纯读、不占号：
 *   1. 已有 `Order.invoiceNo` → 原样返回（幂等）
 *   2. 已被财务真实发票覆盖 → 返回发票号，不发新号
 *   3. 剩下的才进一个事务连续发号
 */
export async function ensureInvoiceNumbers(orderIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (orderIds.length === 0) return out

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, invoiceNo: true },
  })
  const settled = new Set<string>()
  for (const o of orders) {
    if (o.invoiceNo) {
      out.set(o.id, o.invoiceNo)
      settled.add(o.id)
    }
  }

  const stillOpen = orders.filter(o => !settled.has(o.id)).map(o => o.id)
  const realInvoice = await coveredByRealInvoice(stillOpen)
  for (const [id, name] of realInvoice) {
    out.set(id, name)
    settled.add(id)
  }

  const needNumber = orders.filter(o => !settled.has(o.id)).map(o => o.id)
  if (needNumber.length === 0) return out

  for (const [id, name] of await allocateBatch(needNumber)) out.set(id, name)
  return out
}
