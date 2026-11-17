import { prisma } from '@/lib/db'

/** Resolve the customer record linked to a portal login, keeping legacy user-id links usable. */
export async function resolvePortalCustomerId(userId: string, customerId?: string | null): Promise<string> {
  if (customerId) return customerId
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { customerId: true } })
  return user?.customerId ?? userId
}
