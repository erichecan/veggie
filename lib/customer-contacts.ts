/**
 * 客户联系人的共享规则。
 *
 * 放在这里而不是各 route 里各写一份 —— 邮箱规范化只要两边不一致，
 * 「新增时说重复了、发送时又匹配不上」这种鬼故事就会出现。
 */

/** 一个客户最多几个联系人。防的是导入脚本或误操作把几百条塞进一个客户 */
export const MAX_CONTACTS_PER_CUSTOMER = 50

/** 收件人上限（To + CC 合计）。Resend 单封上限 50，留点余量 */
export const MAX_RECIPIENTS_PER_EMAIL = 25

/** 统一小写去空格。存和比都走这里，别在别处手写 trim().toLowerCase() */
export function normalizeEmail(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase()
}

/**
 * 邮箱格式校验。
 *
 * 故意保持宽松：只要求「有本地部分 @ 有点的域名」，不去追求 RFC 5322 完备。
 * 真实客户资料里 `John Smith <j@x.ie>`、全角＠、末尾分号都出现过，
 * 这里挡掉明显不是邮箱的即可，剩下的交给 Resend 退信。
 */
export function isValidEmail(email: string): boolean {
  if (!email || email.length > 254) return false
  if (/[\s<>,;()[\]\\"]/.test(email)) return false
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(email)
}
