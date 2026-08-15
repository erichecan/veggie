/**
 * 报价单 vs 销售单 —— 状态分界的唯一真相（台账 X9）
 * ============================================================================
 * 本系统里**报价单不是独立实体**：它就是 `status = 'PENDING'` 的 Order，
 * 一经确认，同一条记录变成销售单。这个设计很省事，但埋了一个容易踩的坑 ——
 * 凡是「查这个客户以前买过什么/多少钱」的地方，如果只排除 CANCELLED，
 * **报价单会被算成成交**。
 *
 * 客户 20260814 反馈的正是这个：「price type 是 multi 或 last 时，上一次的价格，
 * 是指 sale order 的价格，不应该是 quotation 价格」。一张从没被确认、甚至已经
 * 谈崩的报价单，它的价会直接变成下一单的基准价 —— 而报价只是**要价**，不是成交。
 *
 * 生产实测（20260814）：488 张 PENDING，且报价单都是新的、历史单几乎都是 LOCKED，
 * 所以报价极容易赢下「最近一次」——**2434 个「客户×商品」组合里有 873 个（36%）
 * 的所谓"上次成交价"取自报价单**。
 *
 * 这里不用 `{ not: 'CANCELLED' }` 这种减法写法，改成显式白名单：
 * 以后新增状态（比如加个 DRAFT）时，减法会默默把它算进成交，白名单会逼人做决定。
 */
import type { $Enums } from '@/lib/generated/prisma/client'

/**
 * **真正成交过**的订单状态。用于历史成交价、成交量等一切「已经卖出去了」的口径。
 *
 * 不含 `PENDING`（那是报价单，还没成交）与 `CANCELLED`（作废）。
 * `LOCKED` 是开票后锁定，属于最确凿的成交，必须含。
 */
export const SALE_ORDER_STATUSES: $Enums.OrderStatus[] = [
  'CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED', 'LOCKED',
]

/** 报价单（尚未确认）。与上面互斥，两者并集再加 CANCELLED 即全部状态。 */
export const QUOTATION_STATUSES: $Enums.OrderStatus[] = ['PENDING']
