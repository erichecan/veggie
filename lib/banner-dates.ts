import { businessDayStart } from '@/lib/analytics/metrics'

/**
 * Banner.dateStart/dateEnd 的写入口径。
 *
 * 后台 DatePicker 传来的是 "yyyy-MM-dd"（同 <input type="date"> 契约），按业务时区
 * （BUSINESS_TIMEZONE=Europe/Dublin）取那一天的 00:00 存库——这样 GET
 * /api/customer-portal/banners 用 businessTodayStart() 比较时，dateEnd 那一整天
 * 都满足 `>= businessTodayStart()`，直到次日才失效，不会在 dateEnd 当天一开始就提前下线。
 */
export function parseBusinessDate(dateStr: string): Date {
  return businessDayStart(new Date(`${dateStr}T12:00:00Z`))
}
