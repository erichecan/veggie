/** 回单核销清单的常量（无依赖，前后端、orders-query 都能引用，见 lib/accounting/returns.ts） */
/** 新系统正式出车日（与 22 点自动出发的历史下界同一天，见 app/api/cron/auto-confirm-departure）；更早的是 Odoo 导入的历史单 */
export const RETURNS_FLOOR_DATE = '2026-09-13'
/** 已核销的单在核销管理页「待核销」里保留多久，之后只在「已核销」tab 里 */
export const RETURNED_STAY_HOURS = 24
