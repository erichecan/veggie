/**
 * 公开 API 路由白名单 —— 唯一真相
 *
 * ⚠️ 往这里加一条，等于把接口公开到互联网上，且是**前缀匹配**：
 * 写 `/api/customers` 会连带放行整个 `/api/customers/*` 子树。
 *
 * 2026-08-02 的教训：`/api/customers` 曾因为一次「修 /enter 路由 404」被顺手加进来，
 * 结果全量客户名册（1605 条，含地址/电话/邮箱/VAT/信用额度/提成率）匿名可读了两个月
 * 没人发现。`tests/public-api-routes.test.ts` 现在会枚举全部 API 路由并与快照比对，
 * 任何路由变成公开都会让测试失败——要加就得同时改快照并写清为什么可以公开。
 *
 * 判定标准：只放**不含任何业务数据**的端点。凡是能读到客户、订单、商品、价格、
 * 财务、配置的接口，一律不许进这个名单。
 */
export const PUBLIC_API_ROUTES = [
  /** 登录本身，必须匿名可达 */
  '/api/auth/login',
  /** 健康检查，只回 {ok:true}+时间戳，无业务数据 */
  '/api/health',
  /** 地图瓦片代理，纯转发第三方瓦片，无业务数据 */
  '/api/tile',
  /** 定时任务入口，自带 CRON_SECRET 校验（见各 route.ts 首行），不走 JWT */
  '/api/cron',
] as const

/** middleware 的放行判定。与 middleware.ts 共用同一份实现，避免两处逻辑漂移。 */
export function isPublicApiRoute(pathname: string): boolean {
  return PUBLIC_API_ROUTES.some(r => pathname.startsWith(r))
}
