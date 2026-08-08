/**
 * 新密码强度校验。
 * ============================================================================
 * 目标不是「复杂度评分好看」，而是**挡住这次事故里真实出现过的那几类密码**：
 * `test123`、`Demo1234!`、`123456`。所以规则以黑名单和常见模式为主，
 * 而不是堆砌「必须含大写+数字+符号」——后者只会逼出 `Password1!` 这种
 * 同样在字典里的东西。
 */

/** 已知泄露 / 项目自己造出来的口令。与 scripts/security/flag-weak-passwords.ts 同源 */
const BLOCKLIST = new Set([
  'test123', 'demo1234!', '123456', '12345678', '123456789', 'password',
  'password1', 'password123', 'admin', 'admin123', '111111', 'abc123',
  'qwerty', 'qwerty123', 'iloveyou', 'welcome', 'letmein', 'veggie123',
  'johnstone', 'johnstone123',
])

const MIN_LENGTH = 10

export interface PasswordVerdict {
  ok: boolean
  reason?: string
}

/** 全是同一个字符，或纯连续数字/字母（1234…、abcd…） */
function isTrivialSequence(pw: string): boolean {
  if (/^(.)\1+$/.test(pw)) return true
  const lower = pw.toLowerCase()
  const asc = 'abcdefghijklmnopqrstuvwxyz'
  const digits = '01234567890123456789'
  return (
    asc.includes(lower) ||
    [...asc].reverse().join('').includes(lower) ||
    digits.includes(lower) ||
    [...digits].reverse().join('').includes(lower)
  )
}

export function assessNewPassword(
  raw: string,
  who?: { email?: string; name?: string },
): PasswordVerdict {
  const pw = String(raw ?? '')

  if (pw.length < MIN_LENGTH) {
    return { ok: false, reason: `密码至少 ${MIN_LENGTH} 位` }
  }
  if (pw.length > 200) {
    return { ok: false, reason: '密码过长' }
  }
  if (pw.trim() !== pw) {
    return { ok: false, reason: '密码首尾不能有空格 —— 这类密码换个输入法就打不出来了' }
  }

  const lower = pw.toLowerCase()
  if (BLOCKLIST.has(lower)) {
    return { ok: false, reason: '这个密码在常见弱口令名单里，请换一个' }
  }
  // 「test123456」这种在弱口令后面补长度的写法同样挡掉
  for (const bad of BLOCKLIST) {
    if (bad.length >= 6 && lower.includes(bad)) {
      return { ok: false, reason: `密码里包含常见弱口令「${bad}」，请换一个` }
    }
  }

  if (isTrivialSequence(pw)) {
    return { ok: false, reason: '密码不能是连续或重复的字符' }
  }

  // 与自己的邮箱名 / 姓名太像，别人一猜就中。
  //
  // ⚠️ 必须**按片段**比，不能拿整串去 includes。现网邮箱形如
  // `driver.moazzam@veggie.local`，人真正会拿来当密码的是 `moazzam` 这一截，
  // 而它并不包含完整的 `driver.moazzam` —— 整串比对刚好放过了最典型的那种写法。
  const tokensOf = (s: string | undefined) =>
    (s ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4)

  const emailTokens = tokensOf(who?.email?.split('@')[0])
  if (emailTokens.some((t) => lower.includes(t))) {
    return { ok: false, reason: '密码不能包含自己的邮箱名' }
  }
  const nameTokens = tokensOf(who?.name)
  if (nameTokens.some((t) => lower.includes(t))) {
    return { ok: false, reason: '密码不能包含自己的姓名' }
  }

  // 至少两类字符。不强求四类 —— 那只会逼出 Password1! 这种同样在字典里的东西
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw)).length
  if (classes < 2) {
    return { ok: false, reason: '密码需要至少包含字母、数字、符号中的两类' }
  }

  return { ok: true }
}

export const PASSWORD_MIN_LENGTH = MIN_LENGTH
