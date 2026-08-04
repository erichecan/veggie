import { createPrismaClient } from '@/lib/prisma-factory'
async function main() {
  const prisma = createPrismaClient()
  const users = await prisma.user.findMany({ select: { email: true, role: true, name: true }, take: 10 })
  console.log(JSON.stringify(users, null, 2))
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
