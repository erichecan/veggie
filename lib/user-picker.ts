/**
 * 选人下拉(销售员等)的选项 —— 20261009
 * ============================================================================
 * 客户反馈：Xuan Li 已有一个停用的 placeholder 账号，Salesperson 下拉里却出现
 * 两个「Xuan Li」。根因：GET /api/users 返回全部用户(用户管理页要看停用的)，各选人下拉
 * 直接拿来用，没过滤 isActive。
 *
 * 规则：只列启用的账号；**当前已选**的如果是停用账号，保留并标注「(已停用)」——
 * 否则已有单据/客户上的销售员会显示成空白，用户还以为数据丢了。
 */

export interface PickerUser {
  id: string
  name: string
  email?: string
  isActive?: boolean
}

export function isPickableUser(u: PickerUser): boolean {
  return u.isActive !== false
}

/** 停用账号的显示名 */
export function userDisplayName(u: PickerUser, isEn: boolean): string {
  const name = u.name || u.email || u.id
  return isPickableUser(u) ? name : `${name} ${isEn ? '(deactivated)' : '(已停用)'}`
}

/**
 * @param currentId 当前已选的用户 id；它若是停用账号，仍保留在选项里(带标注)
 * @param opts.includeInactive 报表筛选这类要按历史数据查的场景：停用的也列，但都带标注
 */
export function userPickerOptions(
  users: PickerUser[],
  currentId: string | null | undefined,
  isEn: boolean,
  opts: { includeInactive?: boolean } = {},
): { value: string; label: string }[] {
  return users
    .filter(u => opts.includeInactive || isPickableUser(u) || (!!currentId && u.id === currentId))
    .map(u => ({ value: u.id, label: userDisplayName(u, isEn) }))
}
