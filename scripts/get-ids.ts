import dotenv from 'dotenv'
import { resolve } from 'path'
dotenv.config({ path: resolve(process.cwd(), '.env.local') })

import { prisma } from '../lib/db'

async function main() {
  const [customers, products] = await Promise.all([
    prisma.customer.findMany({ take: 3, select: { id: true, name: true } }),
    prisma.product.findMany({ take: 5, select: { id: true, name: true } }),
  ])
  console.log('CUSTOMERS:', JSON.stringify(customers))
  console.log('PRODUCTS:', JSON.stringify(products))
  await prisma.$disconnect()
}
main()
