import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'

const prisma = createPrismaClient()

function waveName(date: Date, seq: number): string {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const dateStr = date.toLocaleDateString('sv-SE')
  const dayName = dayNames[date.getDay()]
  return `${dateStr} ${dayName} ${String(seq).padStart(3, '0')}`
}

const today = new Date('2026-05-03T00:00:00')
const yesterday = new Date('2026-05-02T00:00:00')
const twoDaysAgo = new Date('2026-05-01T00:00:00')

// 爱尔兰示例客户 IDs（来自 seed-trips.ts）
const RESTAURANTS = [
  { id: 'cust_ie_001', name: 'Lucky Garden Chinese Restaurant' },
  { id: 'cust_ie_002', name: 'Golden Dragon Cantonese Kitchen' },
  { id: 'cust_ie_003', name: 'Red Lotus Thai & Asian Cuisine' },
  { id: 'cust_ie_004', name: 'Bamboo Garden Restaurant' },
  { id: 'cust_ie_005', name: 'Phoenix Asian Supermarket & Deli' },
]

const DEMO_ITEMS = [
  { productId: 'prod_demo_1', productName: 'Bok Choy', spec: '500g', image: '', quantity: 10, price: 2.5, subtotal: 25 },
  { productId: 'prod_demo_2', productName: 'Spring Onion', spec: '1bunch', image: '', quantity: 5, price: 1.8, subtotal: 9 },
  { productId: 'prod_demo_3', productName: 'Ginger Root', spec: '1kg', image: '', quantity: 8, price: 3.2, subtotal: 25.6 },
  { productId: 'prod_demo_4', productName: 'Garlic Bulb', spec: '500g', image: '', quantity: 20, price: 0.9, subtotal: 18 },
  { productId: 'prod_demo_5', productName: 'Thai Basil', spec: '100g', image: '', quantity: 12, price: 2.0, subtotal: 24 },
]

function makeZones(items: typeof DEMO_ITEMS) {
  return [
    { name: 'A区', items: items.map(i => ({
      productId: i.productId, productName: i.productName, spec: i.spec,
      image: i.image, requiredQty: i.quantity, pickedQty: i.quantity, restaurants: [], done: true,
    })) },
  ]
}

// 示例波次数据：涵盖所有状态
const DEMO_WAVES = [
  // 今天 — 3 条波次
  {
    id: 'wave_demo_001',
    name: waveName(today, 1),
    status: 'PICKED',
    createdAt: new Date('2026-05-03T06:30:00Z'),
    orderIds: ['order_ie_004'],
    zones: makeZones(DEMO_ITEMS.slice(0, 2)),
  },
  {
    id: 'wave_demo_002',
    name: waveName(today, 2),
    status: 'SORTING',
    createdAt: new Date('2026-05-03T08:00:00Z'),
    orderIds: ['order_ie_001', 'order_ie_002'],
    zones: makeZones(DEMO_ITEMS.slice(2, 4)),
  },
  {
    id: 'wave_demo_003',
    name: waveName(today, 3),
    status: 'PENDING',
    createdAt: new Date('2026-05-03T09:15:00Z'),
    orderIds: [],
    zones: [],
  },
  // 昨天 — 2 条波次
  {
    id: 'wave_demo_004',
    name: waveName(yesterday, 1),
    status: 'SORTED',
    createdAt: new Date('2026-05-02T07:00:00Z'),
    orderIds: ['order_ie_003'],
    zones: makeZones(DEMO_ITEMS.slice(0, 3)),
  },
  {
    id: 'wave_demo_005',
    name: waveName(yesterday, 2),
    status: 'SORTED',
    createdAt: new Date('2026-05-02T09:30:00Z'),
    orderIds: ['order_ie_005'],
    zones: makeZones(DEMO_ITEMS.slice(3, 5)),
  },
  // 前天 — 1 条波次
  {
    id: 'wave_demo_006',
    name: waveName(twoDaysAgo, 1),
    status: 'SORTED',
    createdAt: new Date('2026-05-01T08:00:00Z'),
    orderIds: [],
    zones: makeZones(DEMO_ITEMS),
  },
]

async function main() {
  console.log('🌊 清理旧波次数据...')

  // 删除所有旧的波次（保留 DEMO 前缀以外的如有的话也清空）
  const deleted = await prisma.pickingWave.deleteMany({})
  console.log(`🗑️  已删除 ${deleted.count} 条旧波次`)

  console.log('🌱 写入新波次数据...')
  for (const w of DEMO_WAVES) {
    await prisma.pickingWave.create({
      data: {
        id: w.id,
        name: w.name,
        status: w.status as any,
        createdAt: w.createdAt,
        orderIds: w.orderIds,
        zones: w.zones as any,
      },
    })
    console.log(`  ✅ ${w.name} (${w.status})`)
  }

  console.log(`\n🎉 完成！共写入 ${DEMO_WAVES.length} 条波次`)
  console.log('  状态分布:')
  console.log('    今天: PICKED · SORTING · PENDING')
  console.log('    昨天: SORTED × 2')
  console.log('    前天: SORTED × 1')
}

main()
  .catch(e => { console.error('❌ 失败:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
