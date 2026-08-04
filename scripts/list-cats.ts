import * as dotenv from 'dotenv'
import { createPrismaClient } from '@/lib/prisma-factory'

dotenv.config({ path: '.env.local' })

const prisma = createPrismaClient()

async function main() {
  const cats = await prisma.productCategory.findMany({ select: { id: true, name: true } })
  console.log(JSON.stringify(cats, null, 2))
  await prisma.$disconnect()
}
main()
