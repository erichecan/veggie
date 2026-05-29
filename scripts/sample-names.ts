import { config } from 'dotenv'
config({ path: '.env.local' })
import { neonConfig } from '@neondatabase/serverless'
import { PrismaNeon } from '@prisma/adapter-neon'
import { PrismaClient } from '../lib/generated/prisma/client'
import ws from 'ws'

neonConfig.webSocketConstructor = ws
const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

async function main() {
  const templates = await prisma.productTemplate.findMany({
    select: { id: true, name: true, categoryId: true },
    orderBy: { categoryId: 'asc' },
  })
  // Print all names grouped by category
  const byCat: Record<string, string[]> = {}
  for (const t of templates) {
    const cat = t.categoryId ?? 'unknown'
    if (!byCat[cat]) byCat[cat] = []
    byCat[cat].push(t.name)
  }
  for (const [cat, names] of Object.entries(byCat)) {
    console.log(`\n=== ${cat} (${names.length}) ===`)
    names.slice(0, 10).forEach(n => console.log(' ', n))
    if (names.length > 10) console.log(`  ... and ${names.length - 10} more`)
  }
  await prisma.$disconnect()
}
main()
