import { NextResponse } from 'next/server'
import { effectiveRoles, type JwtPayload } from './auth'
import { Prisma } from './generated/prisma/client'

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

/**
 * 退换货补全 M4：仓库核实通过后自动发一条退换货通知（source=AUTO），免得仓库/销售
 * 还要靠微信群口头喊"这单退货核实过了"。不走正式权限点体系——信息广场的管理动作
 * 本来就按角色判断（见上方 BULLETIN_MANAGE_ROLES），自动发帖同理，不单独建权限点。
 */
export async function createAutoGoodsReturnPost(
  tx: Prisma.TransactionClient,
  params: { restaurantName: string; productName: string; quantity: number; linkUrl: string },
): Promise<void> {
  const { restaurantName, productName, quantity, linkUrl } = params
  await tx.bulletinPost.create({
    data: {
      category: 'GOODS_RETURN',
      source: 'AUTO',
      content: `${restaurantName} 的退换货已完成仓库核实：${productName} × ${quantity}，等待销售审核。`,
      linkUrl,
    },
  })
}
