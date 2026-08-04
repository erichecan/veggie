/**
 * 退货演示种子数据 — 10 条退货记录，分布在 3 次行程中
 * 运行: node_modules/.bin/tsx --env-file=.env.local prisma/seed-returns.ts
 */
import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'

const prisma = createPrismaClient()

// ─── 餐馆（使用 seed.ts 已创建的 demo 客户）────────────────────────────────
const REST_1 = { restaurantId: 'cust_001', restaurantName: 'Achara' }
const REST_2 = { restaurantId: 'cust_002', restaurantName: 'AE D5' }

// ─── 商品快照（listPrice 来自数据库）────────────────────────────────────────
const PRODUCTS = {
  broccoli:   { id: 'p19577', name: 'Broccoli Stem CASE',              price: 19.95 },
  cabbageW:   { id: 'p5757',  name: 'Cabbage White BAG',               price: 14.50 },
  cabbageWL:  { id: 'p5758',  name: 'Cabbage White LOOSE',             price:  2.50 },
  cabbageR:   { id: 'p5755',  name: 'Cabbage Red BAG',                 price: 11.00 },
  mushroom:   { id: 'p21551', name: 'AUTHENTIC Mushroom & Pork Ball 360g PKT', price: 5.50 },
  tofu:       { id: 'p20144', name: 'Basket Tofu Firm (Satonoyuki) CASE',      price: 65.00 },
  gyoza:      { id: 'p21709', name: 'BIBIGO Tofu & Veg Gyoza 12*600g CASE',    price: 52.80 },
  edamame:    { id: 'p20060', name: '*Peeled* Edamame Soy Bean 500g PKT',      price:  3.80 },
  springRoll: { id: 'p21763', name: 'JSB Frozen Veg Spring Roll 10*750g CASE', price: 24.00 },
  gyozaSpinach: { id: 'p19925', name: 'Aji Veg Gyoza SPINACH 600g PKT',        price:  5.80 },
}

function item(p: { id: string; name: string; price: number }, qty: number) {
  return {
    productId: p.id,
    productName: p.name,
    spec: '',
    price: p.price,
    quantity: qty,
    subtotal: +(p.price * qty).toFixed(2),
    deliveredQty: qty,
  }
}

function ret(
  p: { id: string; name: string; price: number },
  qty: number,
  reason: string | undefined,
  status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'SETTLED',
  refundPct?: number,
) {
  const refundAmount = refundPct != null ? +(p.price * qty * refundPct).toFixed(2) : undefined
  return {
    productId: p.id,
    productName: p.name,
    quantity: qty,
    unitPrice: p.price,
    refundMode: refundPct != null ? ('pct' as const) : undefined,
    refundPct,
    refundAmount,
    status,
    ...(reason ? { reason } : {}),
  }
}

const TRIPS = [
  // ── 行程 1：2 个月前，已结清，REST_1 有 3 条退货 ──────────────────────────
  {
    id: 'trip_seed_returns_001',
    name: '上午 · 小张司机 · 1家餐馆',
    timeSlot: 'AM',
    driverId: 'driver_001',
    driverName: '司机小张',
    status: 'COMPLETED' as const,
    createdAt: new Date(Date.now() - 61 * 24 * 60 * 60 * 1000),
    restaurants: [
      {
        ...REST_1,
        orderIds: [],
        delivered: true,
        payment: 285.60,
        pods: [],
        cargoVerified: true,
        items: [
          item(PRODUCTS.broccoli, 5),
          item(PRODUCTS.cabbageW, 10),
          item(PRODUCTS.tofu, 2),
          item(PRODUCTS.edamame, 20),
          item(PRODUCTS.mushroom, 8),
          item(PRODUCTS.gyozaSpinach, 6),
        ],
        // 3 条退货（均已结清）
        returns: [
          ret(PRODUCTS.broccoli, 2, '到货时已腐烂，叶子发黄', 'SETTLED', 1.0),
          ret(PRODUCTS.tofu, 1, '包装破损，豆腐散落', 'SETTLED', 1.0),
          ret(PRODUCTS.edamame, 3, '数量不足，少发了 3 包', 'SETTLED', 1.0),
        ],
      },
    ],
    totalPayment: 285.60,
  },

  // ── 行程 2：1 个月前，已完成，REST_1 有 2 条退货，REST_2 有 2 条退货 ───────
  {
    id: 'trip_seed_returns_002',
    name: '下午 · 小张司机 · 2家餐馆',
    timeSlot: 'PM',
    driverId: 'driver_001',
    driverName: '司机小张',
    status: 'COMPLETED' as const,
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    restaurants: [
      {
        ...REST_1,
        orderIds: [],
        delivered: true,
        payment: 198.40,
        pods: [],
        cargoVerified: true,
        items: [
          item(PRODUCTS.cabbageR, 6),
          item(PRODUCTS.gyoza, 3),
          item(PRODUCTS.springRoll, 2),
          item(PRODUCTS.mushroom, 12),
        ],
        // 2 条退货（已批准）
        returns: [
          ret(PRODUCTS.cabbageR, 1, '外叶大面积开裂，无法使用', 'APPROVED', 1.0),
          ret(PRODUCTS.gyoza, 1, '冷链中断，收货时已解冻', 'APPROVED', 0.5),
        ],
      },
      {
        ...REST_2,
        orderIds: [],
        delivered: true,
        payment: 142.50,
        pods: [],
        cargoVerified: true,
        items: [
          item(PRODUCTS.edamame, 15),
          item(PRODUCTS.tofu, 3),
          item(PRODUCTS.gyozaSpinach, 10),
          item(PRODUCTS.broccoli, 4),
          item(PRODUCTS.cabbageWL, 20),
        ],
        // 2 条退货（已批准）
        returns: [
          ret(PRODUCTS.tofu, 2, '临近过期，保质期不足 3 天', 'APPROVED', 1.0),
          ret(PRODUCTS.gyozaSpinach, 2, undefined, 'APPROVED', 1.0),
        ],
      },
    ],
    totalPayment: 340.90,
  },

  // ── 行程 3：3 天前，已送达，REST_1 有 2 条待审核，REST_2 有 1 条待审核 ────
  {
    id: 'trip_seed_returns_003',
    name: '上午 · 小张司机 · 2家餐馆',
    timeSlot: 'AM',
    driverId: 'driver_001',
    driverName: '司机小张',
    status: 'COMPLETED' as const,
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    restaurants: [
      {
        ...REST_1,
        orderIds: [],
        delivered: true,
        payment: 321.00,
        pods: [],
        cargoVerified: true,
        items: [
          item(PRODUCTS.broccoli, 8),
          item(PRODUCTS.cabbageW, 15),
          item(PRODUCTS.gyoza, 4),
          item(PRODUCTS.mushroom, 20),
          item(PRODUCTS.springRoll, 3),
        ],
        // 2 条待审核退货
        returns: [
          ret(PRODUCTS.mushroom, 5, undefined, 'PENDING_REVIEW'),
          ret(PRODUCTS.springRoll, 1, '外箱破损严重', 'PENDING_REVIEW', 1.0),
        ],
      },
      {
        ...REST_2,
        orderIds: [],
        delivered: true,
        payment: 189.70,
        pods: [],
        cargoVerified: true,
        items: [
          item(PRODUCTS.edamame, 10),
          item(PRODUCTS.cabbageWL, 25),
          item(PRODUCTS.tofu, 2),
          item(PRODUCTS.gyozaSpinach, 8),
        ],
        // 1 条待审核退货
        returns: [
          ret(PRODUCTS.edamame, 4, '袋子破损，解冻渗水', 'PENDING_REVIEW', 1.0),
        ],
      },
    ],
    totalPayment: 510.70,
  },
]

async function main() {
  console.log('🌱 写入退货演示行程数据...')

  for (const trip of TRIPS) {
    const { createdAt, ...rest } = trip
    await (prisma.trip as any).upsert({
      where: { id: trip.id },
      update: {
        ...rest,
        restaurants: rest.restaurants as any,
      },
      create: {
        ...rest,
        restaurants: rest.restaurants as any,
        createdAt,
      },
    })
    const returnCount = trip.restaurants.reduce((s, r) => s + r.returns.length, 0)
    console.log(`  ✅ ${trip.id}  ${trip.name}  (退货 ${returnCount} 条)`)
  }

  const total = TRIPS.reduce((s, t) => s + t.restaurants.reduce((s2, r) => s2 + r.returns.length, 0), 0)
  console.log(`\n🎉 完成！共写入 ${TRIPS.length} 次行程，${total} 条退货记录。`)
  console.log('   退货状态分布：SETTLED×3  APPROVED×4  PENDING_REVIEW×3')
}

main()
  .catch(e => { console.error('❌ 失败:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
