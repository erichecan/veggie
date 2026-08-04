import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'

const prisma = createPrismaClient()

const IRISH_CUSTOMERS = [
  {
    id: 'cust_ie_001', name: 'Lucky Garden Chinese Restaurant',
    street: '14 Parnell Street', street2: undefined, city: 'Dublin 1', state: 'Dublin', zip: 'D01 XY23', country: 'Ireland',
    address: '14 Parnell Street, Dublin 1, D01 XY23', phone: '+353 1 872 3456', email: 'lucky.garden@example.ie',
    paymentTerm: 'NET30', creditLimit: 5000,
  },
  {
    id: 'cust_ie_002', name: 'Golden Dragon Cantonese Kitchen',
    street: '8 Thomas Street', street2: undefined, city: 'Dublin 8', state: 'Dublin', zip: 'D08 AC45', country: 'Ireland',
    address: '8 Thomas Street, Dublin 8, D08 AC45', phone: '+353 1 453 2211', email: 'golden.dragon@example.ie',
    paymentTerm: 'NET30', creditLimit: 4000,
  },
  {
    id: 'cust_ie_003', name: 'Red Lotus Thai & Asian Cuisine',
    street: '22 Camden Street Lower', street2: undefined, city: 'Dublin 2', state: 'Dublin', zip: 'D02 PK88', country: 'Ireland',
    address: '22 Camden Street Lower, Dublin 2, D02 PK88', phone: '+353 1 478 9900', email: 'redlotus@example.ie',
    paymentTerm: 'NET15', creditLimit: 3000,
  },
  {
    id: 'cust_ie_004', name: 'Bamboo Garden Restaurant',
    street: '55 Manor Street', street2: undefined, city: 'Dublin 7', state: 'Dublin', zip: 'D07 TR12', country: 'Ireland',
    address: '55 Manor Street, Dublin 7, D07 TR12', phone: '+353 1 868 4433', email: 'bamboogarden@example.ie',
    paymentTerm: 'IMMEDIATE', creditLimit: 2000,
  },
  {
    id: 'cust_ie_005', name: 'Phoenix Asian Supermarket & Deli',
    street: '101 Capel Street', street2: undefined, city: 'Dublin 1', state: 'Dublin', zip: 'D01 YH66', country: 'Ireland',
    address: '101 Capel Street, Dublin 1, D01 YH66', phone: '+353 1 872 0011', email: 'phoenix.asian@example.ie',
    paymentTerm: 'NET30', creditLimit: 8000,
  },
]

const DEMO_ORDERS = [
  {
    id: 'order_ie_001', restaurantId: 'cust_ie_001', restaurantName: 'Lucky Garden Chinese Restaurant',
    items: [{ productId: 'prod_demo_1', productName: 'Bok Choy', quantity: 10, price: 2.5, subtotal: 25 }, { productId: 'prod_demo_2', productName: 'Spring Onion', quantity: 5, price: 1.8, subtotal: 9 }],
    totalAmount: 34, status: 'IN_DELIVERY', deliveryBatch: '1 pm BAO',
  },
  {
    id: 'order_ie_002', restaurantId: 'cust_ie_002', restaurantName: 'Golden Dragon Cantonese Kitchen',
    items: [{ productId: 'prod_demo_3', productName: 'Ginger Root', quantity: 8, price: 3.2, subtotal: 25.6 }, { productId: 'prod_demo_4', productName: 'Garlic Bulb', quantity: 20, price: 0.9, subtotal: 18 }],
    totalAmount: 43.6, status: 'IN_DELIVERY', deliveryBatch: '1 pm BAO',
  },
  {
    id: 'order_ie_003', restaurantId: 'cust_ie_003', restaurantName: 'Red Lotus Thai & Asian Cuisine',
    items: [{ productId: 'prod_demo_5', productName: 'Thai Basil', quantity: 12, price: 2.0, subtotal: 24 }],
    totalAmount: 24, status: 'IN_DELIVERY', deliveryBatch: '2 pm SEAN',
  },
  {
    id: 'order_ie_004', restaurantId: 'cust_ie_004', restaurantName: 'Bamboo Garden Restaurant',
    items: [{ productId: 'prod_demo_6', productName: 'Bean Sprouts', quantity: 15, price: 1.5, subtotal: 22.5 }, { productId: 'prod_demo_7', productName: 'Water Chestnut', quantity: 6, price: 4.0, subtotal: 24 }],
    totalAmount: 46.5, status: 'CONFIRMED', deliveryBatch: null,
  },
  {
    id: 'order_ie_005', restaurantId: 'cust_ie_005', restaurantName: 'Phoenix Asian Supermarket & Deli',
    items: [{ productId: 'prod_demo_8', productName: 'Lemongrass', quantity: 10, price: 2.2, subtotal: 22 }, { productId: 'prod_demo_9', productName: 'Kaffir Lime Leaf', quantity: 8, price: 3.0, subtotal: 24 }],
    totalAmount: 46, status: 'COMPLETED', deliveryBatch: '1 am AFZAAL',
  },
]

const DEMO_TRIPS = [
  {
    id: 'trip_ie_001',
    name: '1 pm BAO · 2家餐馆',
    timeSlot: 'PM',
    driverName: 'BAO',
    status: 'IN_PROGRESS',
    departTime: '13:00',
    restaurants: [
      {
        restaurantId: 'cust_ie_001',
        restaurantName: 'Lucky Garden Chinese Restaurant',
        address: '14 Parnell Street, Dublin 1, D01 XY23',
        orderIds: ['order_ie_001'],
        items: [{ productId: 'prod_demo_1', productName: 'Bok Choy', quantity: 10, price: 2.5, subtotal: 25 }, { productId: 'prod_demo_2', productName: 'Spring Onion', quantity: 5, price: 1.8, subtotal: 9 }],
        delivered: true, returns: [], pods: [], cargoVerified: true,
      },
      {
        restaurantId: 'cust_ie_002',
        restaurantName: 'Golden Dragon Cantonese Kitchen',
        address: '8 Thomas Street, Dublin 8, D08 AC45',
        orderIds: ['order_ie_002'],
        items: [{ productId: 'prod_demo_3', productName: 'Ginger Root', quantity: 8, price: 3.2, subtotal: 25.6 }, { productId: 'prod_demo_4', productName: 'Garlic Bulb', quantity: 20, price: 0.9, subtotal: 18 }],
        delivered: false, returns: [], pods: [], cargoVerified: true,
      },
    ],
  },
  {
    id: 'trip_ie_002',
    name: '2 pm SEAN · 1家餐馆',
    timeSlot: 'PM',
    driverName: 'SEAN',
    status: 'PENDING',
    departTime: '14:00',
    restaurants: [
      {
        restaurantId: 'cust_ie_003',
        restaurantName: 'Red Lotus Thai & Asian Cuisine',
        address: '22 Camden Street Lower, Dublin 2, D02 PK88',
        orderIds: ['order_ie_003'],
        items: [{ productId: 'prod_demo_5', productName: 'Thai Basil', quantity: 12, price: 2.0, subtotal: 24 }],
        delivered: false, returns: [], pods: [], cargoVerified: false,
      },
    ],
  },
  {
    id: 'trip_ie_003',
    name: '1 am AFZAAL · 3家餐馆',
    timeSlot: 'AM',
    driverName: 'AFZAAL',
    status: 'COMPLETED',
    departTime: '07:30',
    restaurants: [
      {
        restaurantId: 'cust_ie_001',
        restaurantName: 'Lucky Garden Chinese Restaurant',
        address: '14 Parnell Street, Dublin 1, D01 XY23',
        orderIds: [],
        items: [{ productId: 'prod_demo_1', productName: 'Bok Choy', quantity: 6, price: 2.5, subtotal: 15 }],
        delivered: true, returns: [], pods: [], cargoVerified: true,
      },
      {
        restaurantId: 'cust_ie_004',
        restaurantName: 'Bamboo Garden Restaurant',
        address: '55 Manor Street, Dublin 7, D07 TR12',
        orderIds: [],
        items: [{ productId: 'prod_demo_6', productName: 'Bean Sprouts', quantity: 15, price: 1.5, subtotal: 22.5 }],
        delivered: true, returns: [], pods: [], cargoVerified: true,
      },
      {
        restaurantId: 'cust_ie_005',
        restaurantName: 'Phoenix Asian Supermarket & Deli',
        address: '101 Capel Street, Dublin 1, D01 YH66',
        orderIds: ['order_ie_005'],
        items: [{ productId: 'prod_demo_8', productName: 'Lemongrass', quantity: 10, price: 2.2, subtotal: 22 }, { productId: 'prod_demo_9', productName: 'Kaffir Lime Leaf', quantity: 8, price: 3.0, subtotal: 24 }],
        delivered: true, returns: [], pods: [], cargoVerified: true,
      },
    ],
  },
  {
    id: 'trip_ie_004',
    name: '3 pm WIT · 2家餐馆',
    timeSlot: 'PM',
    driverName: 'WIT',
    status: 'PENDING_ASSIGNMENT',
    departTime: '15:00',
    restaurants: [
      {
        restaurantId: 'cust_ie_002',
        restaurantName: 'Golden Dragon Cantonese Kitchen',
        address: '8 Thomas Street, Dublin 8, D08 AC45',
        orderIds: [],
        items: [{ productId: 'prod_demo_3', productName: 'Ginger Root', quantity: 4, price: 3.2, subtotal: 12.8 }],
        delivered: false, returns: [], pods: [], cargoVerified: false,
      },
      {
        restaurantId: 'cust_ie_003',
        restaurantName: 'Red Lotus Thai & Asian Cuisine',
        address: '22 Camden Street Lower, Dublin 2, D02 PK88',
        orderIds: [],
        items: [{ productId: 'prod_demo_5', productName: 'Thai Basil', quantity: 6, price: 2.0, subtotal: 12 }],
        delivered: false, returns: [], pods: [], cargoVerified: false,
      },
    ],
  },
]

async function main() {
  console.log('🌱 导入爱尔兰示例客户 + 行程数据...')

  for (const c of IRISH_CUSTOMERS) {
    await prisma.customer.upsert({
      where: { id: c.id },
      update: { name: c.name, street: c.street, city: c.city, state: c.state, zip: c.zip, address: c.address },
      create: {
        id: c.id, name: c.name, address: c.address,
        street: c.street, street2: c.street2, city: c.city, state: c.state, zip: c.zip, country: c.country,
        phone: c.phone, email: c.email, paymentTerm: c.paymentTerm, creditLimit: c.creditLimit,
      },
    })
  }
  console.log(`✅ 爱尔兰客户: ${IRISH_CUSTOMERS.length} 条`)

  // Load DriverSlot records for mapping
  const allSlots = await prisma.driverSlot.findMany()
  const slotByName = new Map(allSlots.map(s => [s.driverName.toUpperCase(), s.id]))

  function resolveSlotId(batch: string | null): string | null {
    if (!batch) return null
    const parts = batch.trim().split(/\s+/)
    const name = parts.length >= 3 ? parts.slice(2).join(' ') : parts[parts.length - 1]
    return slotByName.get(name.toUpperCase()) ?? null
  }

  for (const o of DEMO_ORDERS) {
    const driverSlotId = resolveSlotId(o.deliveryBatch)
    await prisma.order.upsert({
      where: { id: o.id },
      update: { status: o.status as any, deliveryBatch: o.deliveryBatch, driverSlotId },
      create: {
        id: o.id, restaurantId: o.restaurantId, restaurantName: o.restaurantName,
        items: o.items as any, totalAmount: o.totalAmount,
        status: o.status as any, deliveryBatch: o.deliveryBatch, driverSlotId,
      },
    })
  }
  console.log(`✅ 示例订单: ${DEMO_ORDERS.length} 条`)

  for (const t of DEMO_TRIPS) {
    await prisma.trip.upsert({
      where: { id: t.id },
      update: { name: t.name, status: t.status as any, restaurants: t.restaurants as any },
      create: {
        id: t.id, name: t.name, timeSlot: t.timeSlot,
        driverName: t.driverName, departTime: t.departTime,
        status: t.status as any, restaurants: t.restaurants as any,
      },
    })
  }
  console.log(`✅ 示例行程: ${DEMO_TRIPS.length} 条`)
  console.log('\n🎉 完成！行程包含：IN_PROGRESS · PENDING · COMPLETED · PENDING_ASSIGNMENT')
}

main()
  .catch(e => { console.error('❌ 失败:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
