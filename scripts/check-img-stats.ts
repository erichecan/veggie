import { config } from 'dotenv'
import { createPrismaClient } from '@/lib/prisma-factory'
config({ path: '.env.local' })

const prisma = createPrismaClient()

async function main() {
  const total = await prisma.productTemplate.count()
  const withImg = await prisma.productTemplate.count({ where: { NOT: { images: { equals: [] } } } })
  const noImg = await prisma.productTemplate.count({ where: { images: { equals: [] } } })
  // 抽样 5 个有图片的商品
  const samples = await prisma.productTemplate.findMany({
    where: { NOT: { images: { equals: [] } } },
    select: { name: true, images: true },
    take: 5,
  })
  console.log(`总商品: ${total}`)
  console.log(`有图片: ${withImg} (${Math.round(withImg/total*100)}%)`)
  console.log(`无图片: ${noImg}`)
  console.log('\n抽样:')
  for (const s of samples) {
    console.log(` "${s.name}"`)
    console.log(`   → ${(s.images as string[])[0]?.slice(0, 80)}`)
  }
  await prisma.$disconnect()
}
main()
