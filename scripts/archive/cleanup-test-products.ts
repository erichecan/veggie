import { createPrismaClient } from '@/lib/prisma-factory'
const prisma = createPrismaClient()

async function main() {
  const targets = await prisma.productTemplate.findMany({
    where: {
      OR: [
        { name: '' },
        { name: { in: ['vest','test M.P','test','reuse','osp','price difference','TEST 1P','TEST 14P'] } },
      ]
    },
    select: { id: true, name: true, createdAt: true }
  })
  console.log(`将删除 ${targets.length} 条测试商品:`)
  targets.forEach(r => console.log(`  [${r.id}] "${r.name}" (${r.createdAt})`))

  if (targets.length > 0) {
    const ids = targets.map(r => r.id)
    await prisma.productTemplate.deleteMany({ where: { id: { in: ids } } })
    console.log('✅ 已删除')
  }
}

main().catch(console.error).finally(() => prisma.$disconnect())
