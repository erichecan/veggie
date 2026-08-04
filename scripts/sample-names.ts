import { config } from 'dotenv'
import { createPrismaClient } from '@/lib/prisma-factory'
config({ path: '.env.local' })

const prisma = createPrismaClient()

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
