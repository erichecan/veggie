import { neonConfig } from '@neondatabase/serverless'
import { PrismaNeon } from '@prisma/adapter-neon'
import { PrismaClient } from '../lib/generated/prisma/client'
import ws from 'ws'
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

neonConfig.webSocketConstructor = ws
const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

async function main() {
  const cats = await prisma.productCategory.findMany({ select: { id: true, name: true } })
  console.log(JSON.stringify(cats, null, 2))
  await prisma.$disconnect()
}
main()
