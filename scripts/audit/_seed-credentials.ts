/**
 * 本机测试库的账号口令 —— 审计脚本共用的唯一来源
 * ============================================================================
 * 此前 26 个脚本各写一遍 `process.env.SEED_PASSWORD ?? 'LocalTest2026!'`。
 * 20260814 用户要求把 `operator@veggie.com` 单独改成别的口令，于是 26 处全部失效 ——
 * 一个账号改口令要改 26 个文件，这本身就是设计问题，顺手收口。
 *
 * ⛔ 只用于**本机 veggie_test**。脚本自己都有 localhost 闸门，这里不重复守。
 */

/** 绝大多数种子账号仍是这个 */
const DEFAULT_PASSWORD = 'LocalTest2026!'

/**
 * 单独改过口令的账号。
 * · `operator@veggie.com` —— 20260814 用户要求改成 111111（生产同步改了）。
 *   ⚠️ 这个口令在 `lib/password-policy.ts` 的弱口令黑名单里，只因为是本机夹具才留着；
 *   生产上那份**应尽快轮换**。
 */
const OVERRIDES: Record<string, string> = {
  'operator@veggie.com': '111111',
}

/**
 * 取某个种子账号的口令。
 *
 * ⛔ **账号级 override 排在环境变量前面**，顺序不能反。
 * `.env.test` 里有 `SEED_PASSWORD="LocalTest2026!"`（整库默认），第一版把环境变量
 * 放在最前，结果 override 被它整个盖掉 —— 脚本照旧拿老口令去登 operator，
 * 登录返回 401，而脚本把它显示成「登录失败（限流？）」。
 * 直接 curl 能登、脚本不能，差别就在这里。
 *
 * 现在的语义：**这个账号单独改过 → 用它自己的；否则才看环境变量；再否则用默认。**
 */
export function seedPassword(email: string): string {
  const own = OVERRIDES[email.trim().toLowerCase()]
  if (own) return own
  return process.env.SEED_PASSWORD ?? DEFAULT_PASSWORD
}
