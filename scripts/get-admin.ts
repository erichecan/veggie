import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'

async function main() {
  neonConfig.webSocketConstructor = ws
  const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
  const prisma = new PrismaClient({ adapter })
  const users = await prisma.user.findMany({ select: { email: true, role: true, name: true }, take: 10 })
  console.log(JSON.stringify(users, null, 2))
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
