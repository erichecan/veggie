import { NextResponse } from 'next/server'
import { effectiveRoles, type JwtPayload } from './auth'

export { BULLETIN_CATEGORIES, type BulletinCategoryValue } from './bulletin-categories'

/** 能置顶 / 删任意帖的角色。信息广场不接正式权限点体系（见 DEV-PLAN §3），管理动作直接按角色判断 */
const BULLETIN_MANAGE_ROLES = ['BOSS', 'OPERATOR']

/** 信息广场只对内部员工开放，客户门户账号 (RESTAURANT) 不可见、不可发帖 */
export function assertInternalUser(user: JwtPayload): NextResponse | null {
  if (effectiveRoles(user).includes('RESTAURANT')) {
    return NextResponse.json({ error: '无权访问' }, { status: 403 })
  }
  return null
}

export function canManageBulletin(user: JwtPayload): boolean {
  return effectiveRoles(user).some((r) => BULLETIN_MANAGE_ROLES.includes(r))
}
