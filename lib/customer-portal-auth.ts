import { prisma } from '@/lib/db'

/** Resolve the customer record linked to a portal login, keeping legacy user-id links usable. */
export async function resolvePortalCustomerId(userId: string, customerId?: string | null): Promise<string> {
  if (customerId) return customerId
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { customerId: true } })
  return user?.customerId ?? userId
}

/** Customer record plus legacy user IDs that historically stored orders/credits for that same account. */
export async function resolvePortalOwnerIds(userId: string, customerId?: string | null): Promise<string[]> {
  const customer = await resolvePortalCustomerId(userId, customerId)
  const linkedUsers = await prisma.user.findMany({ where: { customerId: customer }, select: { id: true } })
  return [...new Set([customer, userId, ...linkedUsers.map(user => user.id)])]
}
