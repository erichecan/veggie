import assert from 'node:assert/strict'
import { config } from 'dotenv'
import { buildCategoryTree, validateCategoryMove } from '../../lib/product-category-tree'

config({ path: '.env.local', quiet: true })

async function main() {
  const { prisma } = await import('../../lib/db')
  try {
    const categories = await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(610050002::bigint)`
      return tx.productCategory.findMany({ select: { id: true, parentId: true } })
    }, { timeout: 15_000 })
    categories.forEach(category => validateCategoryMove(categories, category.id, category.parentId))
    const tree = buildCategoryTree(categories)
    const flattened = tree.flatMap(root => [root, ...root.children.flatMap(child => [child, ...child.children])])
    assert.equal(flattened.length, categories.length)
    console.log(`PASS: database category tree, ${categories.length} records, ${tree.length} roots, max depth ${Math.max(0, ...flattened.map(node => node.depth))}; read only`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
