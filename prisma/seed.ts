import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'
import bcrypt from 'bcryptjs'
import { SEED_CATEGORIES, SEED_PRODUCT_ATTRIBUTES } from '../lib/seed-products'
import { SEED_PRICELISTS } from '../lib/seed-pricelists'
import { SEED_DEMO_CUSTOMERS } from '../lib/seed-customers'
import { SEED_UOM_CATEGORIES } from '../lib/seed-uoms'
import { STANDARD_ACCOUNTS } from '../lib/accounting'
import { loadCsvProducts, loadCsvCustomers } from './csv-loader'
import type { OrderStatus } from '../lib/generated/prisma/enums'
import { randomBytes } from 'node:crypto'

const prisma = createPrismaClient()

const SEED_USERS = [
  { email: 'operator@veggie.com', role: 'OPERATOR', name: '运营主管' },
  { email: 'restaurant1@veggie.com', role: 'RESTAURANT', name: '张老板 - 粤香楼', customerId: 'cust_001' },
  { email: 'restaurant2@veggie.com', role: 'RESTAURANT', name: '李老板 - 川味居', customerId: 'cust_002' },
  { email: 'sorter@veggie.com', role: 'SORTER', name: '分货员小李' },
  { email: 'driver@veggie.com', role: 'DRIVER', name: '司机小张' },
  { email: 'boss@veggie.com', role: 'BOSS', name: '老板' },
  { email: 'finance@veggie.com', role: 'FINANCE', name: '财务小陈' },
  { email: 'warehouse@veggie.com', role: 'WAREHOUSE', name: '仓库主管' },
  // SALES 一直缺一个能登录的账号：seed-events 建的那几个业务员是 attribution 用的
  // 数据记录，密码是 randomBytes(24) 或字面量 '$2a$10$invalidSeedOnlyHash...'，
  // 按设计就登不进去。于是「以业务员身份开报价单」这条路在本地从来没被走过。
  // roles 给 ['OPERATOR','SALES'] 与 seed-events 保持一致——生产上业务员也都兼任
  // OPERATOR，行级隔离因此在实际中约束不到人，测权限时要意识到这一点。
  { email: 'sales@veggie.com', role: 'SALES', name: '业务员小王', roles: ['OPERATOR', 'SALES'] },
]

/**
 * 种子账号密码。
 *
 * ⛔ 这里曾经硬编码 `Demo1234!`，而这份代码是公开仓库 —— 生产上这 9 个账号
 *    因此人人可登，实测 boss@veggie.com 一登就是 BOSS 权限。
 *    见 docs/20260807-production-credentials-audit.md
 *
 * 现在：优先读环境变量 `SEED_PASSWORD`；没给就**当场随机生成并打印**。
 * 无论哪条路径，都不会再有一个「写在代码里、所有人都知道」的默认密码。
 */
function resolveSeedPassword(): string {
  const fromEnv = process.env.SEED_PASSWORD
  if (fromEnv && fromEnv.length >= 12) return fromEnv
  if (fromEnv) {
    throw new Error('SEED_PASSWORD 至少 12 位，别再给种子账号设弱口令')
  }
  const generated = randomBytes(18).toString('base64url')
  console.log('\n⚠️  未设置 SEED_PASSWORD，已随机生成种子账号密码：')
  console.log(`    ${generated}`)
  console.log('    这行只打印这一次，需要的话现在就记下来。\n')
  return generated
}

async function main() {
  console.log('🌱 开始导入种子数据...')
  const hash = await bcrypt.hash(resolveSeedPassword(), 12)

  // Users
  for (const u of SEED_USERS) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        email: u.email,
        passwordHash: hash,
        role: u.role as any,
        // 权限判断优先看 roles[]，为空才回退到 role。之前这里没写，所有种子账号的
        // roles[] 都是空数组，等于强制走回退路径——真正的多角色场景测不出来。
        roles: (u as any).roles ?? [u.role],
        name: u.name,
        customerId: (u as any).customerId ?? null,
      },
    })
  }
  console.log(`✅ 用户: ${SEED_USERS.length} 条`)

  // Categories
  for (const c of SEED_CATEGORIES) {
    await prisma.productCategory.upsert({
      where: { id: c.id },
      update: { name: c.name, nameZh: c.nameZh, externalId: c.externalId },
      create: { id: c.id, name: c.name, nameZh: c.nameZh, externalId: c.externalId },
    })
  }
  console.log(`✅ 分类: ${SEED_CATEGORIES.length} 条`)

  // Product Attributes
  for (const attr of SEED_PRODUCT_ATTRIBUTES) {
    await prisma.productAttribute.upsert({
      where: { id: attr.id },
      update: { name: attr.name, sequence: attr.sequence },
      create: {
        id: attr.id,
        name: attr.name,
        sequence: attr.sequence,
        values: {
          create: attr.values.map(v => ({ id: v.id, name: v.name, sequence: v.sequence })),
        },
      },
    })
  }
  console.log(`✅ 属性: ${SEED_PRODUCT_ATTRIBUTES.length} 条`)

  // UoM Categories + UoMs（幂等）
  const p = prisma as unknown as Record<string, Record<string, (arg: unknown) => Promise<unknown>>>
  let uomCount = 0
  for (const cat of SEED_UOM_CATEGORIES) {
    await p.uomCategory.upsert({
      where: { id: cat.id },
      update: { name: cat.name, nameZh: cat.nameZh ?? null },
      create: { id: cat.id, name: cat.name, nameZh: cat.nameZh ?? null },
    })
    for (const u of cat.uoms) {
      await p.uom.upsert({
        where: { id: u.id },
        update: {
          name: u.name, nameZh: u.nameZh ?? null,
          factor: u.factor, rounding: u.rounding,
          type: u.type, categoryId: cat.id,
        },
        create: {
          id: u.id, name: u.name, nameZh: u.nameZh ?? null,
          factor: u.factor, rounding: u.rounding,
          type: u.type, categoryId: cat.id,
        },
      })
      uomCount++
    }
  }
  console.log(`✅ UoM Categories: ${SEED_UOM_CATEGORIES.length} 条 / Units: ${uomCount} 条`)

  // 会计标准科目（幂等）
  for (const acct of STANDARD_ACCOUNTS) {
    await p.account.upsert({
      where: { code: acct.code },
      update: {
        name: acct.name, nameZh: acct.nameZh,
        type: acct.type, allowManual: acct.allowManual ?? false,
      },
      create: {
        code: acct.code, name: acct.name, nameZh: acct.nameZh,
        type: acct.type, allowManual: acct.allowManual ?? false,
      },
    })
  }
  console.log(`✅ 会计科目: ${STANDARD_ACCOUNTS.length} 条`)

  // Products — bulk import from pic/product.product.csv
  // ⚠️ 防重复守卫：本 CSV 导入使用 p{num} 体系，与生产库已去重的 cuid25 正版不同；
  //    在已有数据的库上重复运行会制造重复商品/客户。因此：已有商品时默认跳过 CSV 批量导入。
  //    仅在空库初始化、或确需强制重导时设 SEED_FORCE_BULK=1。
  const BATCH = 100
  const existingProductCount = await prisma.product.count()
  const skipBulkMaster = existingProductCount > 0 && process.env.SEED_FORCE_BULK !== '1'
  if (skipBulkMaster) {
    console.log(`⏭️  已存在 ${existingProductCount} 个商品 → 跳过 CSV 批量商品/客户导入（防重复）。如需强制：SEED_FORCE_BULK=1`)
  }
  const csvProducts = skipBulkMaster ? [] : loadCsvProducts()

  // Product（模板/变体已合并为一张表：一次 upsert 写全字段）
  for (let i = 0; i < csvProducts.length; i += BATCH) {
    const batch = csvProducts.slice(i, i + BATCH)
    await Promise.all(batch.map(p =>
      prisma.product.upsert({
        where: { id: p.prodId },
        update: {
          name: p.name,
          listPrice: p.listPrice,
          standardPrice: p.standardPrice,
          qtyOnHand: p.qtyOnHand,
          customerTaxRate: p.customerTaxRate,
          vendorTaxRate: p.vendorTaxRate,
          forecastQty: p.forecastQty,
          commissionPrice: p.commissionPrice,
          weight: p.weight,
          saleDescription: p.saleDescription,
          sequence: p.sequence,
          updatedBy: p.updatedBy,
        },
        create: {
          id: p.prodId,
          name: p.name,
          variantAttributes: [],
          internalRef: p.internalRef,
          categoryId: p.categoryId,
          listPrice: p.listPrice,
          standardPrice: p.standardPrice,
          qtyOnHand: p.qtyOnHand,
          active: true,
          customerTaxRate: p.customerTaxRate,
          vendorTaxRate: p.vendorTaxRate,
          forecastQty: p.forecastQty,
          type: p.type,
          canBeSold: true,
          canBePurchased: true,
          saleDescription: p.saleDescription,
          images: [],
          status: 'ACTIVE',
          externalId: p.externalId,
          sequence: p.sequence,
          weight: p.weight,
          commissionPrice: p.commissionPrice,
          createdBy: p.createdBy,
          updatedBy: p.updatedBy,
        },
      })
    ))
    if (i % 500 === 0 && i > 0) console.log(`  商品: ${i}/${csvProducts.length}`)
  }
  console.log(`✅ 商品: ${csvProducts.length} 条`)

  // Pricelists
  for (const pl of SEED_PRICELISTS) {
    await prisma.odooPricelist.upsert({
      where: { id: pl.id },
      update: {},
      create: {
        id: pl.id,
        externalId: pl.externalId,
        name: pl.name,
        currency: pl.currency,
        items: pl.items as any,
        sequence: pl.sequence,
        selectable: pl.selectable,
        active: pl.active,
        promotionalCode: pl.promotionalCode,
        notes: pl.notes,
      },
    })
  }
  console.log(`✅ 价格表: ${SEED_PRICELISTS.length} 条`)

  // Customers — demo accounts (cust_001 / cust_002 referenced by seed users)
  for (const c of SEED_DEMO_CUSTOMERS) {
    await prisma.customer.upsert({
      where: { id: c.id },
      update: { name: c.name, city: c.city, address: c.address },
      create: {
        id: c.id,
        name: c.name,
        address: c.address,
        phone: c.phone,
        email: c.email,
        vatNumber: c.vatNumber,
        paymentTerm: c.paymentTerm,
        creditLimit: c.creditLimit,
        commissionRate: c.commissionRate,
        externalId: c.externalId,
        city: c.city,
        notes: c.notes,
      },
    })
    if (c.pricelistIds.length > 0) {
      await prisma.customerPricelist.deleteMany({ where: { customerId: c.id } })
      await prisma.customerPricelist.createMany({
        data: c.pricelistIds.map((pricelistId, idx) => ({ customerId: c.id, pricelistId, sequence: idx + 1 })),
      })
    }
  }
  console.log(`✅ Demo 客户: ${SEED_DEMO_CUSTOMERS.length} 条`)

  // Customers — bulk import from pic/res.partner.csv (受同一防重复守卫控制，见上方 skipBulkMaster)
  const csvCustomers = skipBulkMaster ? [] : loadCsvCustomers()
  let csvImported = 0
  for (let i = 0; i < csvCustomers.length; i += BATCH) {
    const batch = csvCustomers.slice(i, i + BATCH)
    await Promise.all(batch.map(async c => {
      await prisma.customer.upsert({
        where: { id: c.id },
        update: {
          name: c.name,
          city: c.city,
          address: c.address,
          notes: c.notes,
          externalId: c.externalId,
        },
        create: {
          id: c.id,
          name: c.name,
          address: c.address,
          phone: c.phone,
          email: c.email,
          vatNumber: c.vatNumber,
          paymentTerm: c.paymentTerm,
          externalId: c.externalId,
          city: c.city,
          notes: c.notes,
        },
      })
      if (c.pricelistIds.length > 0) {
        await prisma.customerPricelist.deleteMany({ where: { customerId: c.id } })
        await prisma.customerPricelist.createMany({
          data: c.pricelistIds.map((pricelistId, idx) => ({ customerId: c.id, pricelistId, sequence: idx + 1 })),
        })
      }
    }))
    csvImported += batch.length
    if (i % 500 === 0 && i > 0) console.log(`  CSV 客户: ${i}/${csvCustomers.length}`)
  }
  console.log(`✅ CSV 客户: ${csvImported} 条`)

  // ── 爱尔兰餐馆示例客户（行程 seed 数据依赖这些 ID）────────────────────
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
  console.log(`✅ 爱尔兰示例客户: ${IRISH_CUSTOMERS.length} 条`)

  // ── 示例订单（每个餐馆一张，状态 IN_DELIVERY 供行程使用）───────────────
  // status 显式标注成 OrderStatus 而不是让它推断成 string：这里原本写 `o.status as any`，
  // 于是 'DELIVERED'（枚举里根本没有，正确值是 COMPLETED）一直躺在种子数据里，
  // typecheck 全绿、直到真去空库灌种子才在运行时炸（2026-08-04 T1.4 发现）。
  const DEMO_ORDERS: Array<{
    id: string
    restaurantId: string
    restaurantName: string
    items: Array<{ productId: string; name: string; qty: number; unitPrice: number; subtotal: number }>
    totalAmount: number
    status: OrderStatus
    deliveryBatch: string | null
  }> = [
    { id: 'order_ie_001', restaurantId: 'cust_ie_001', restaurantName: 'Lucky Garden Chinese Restaurant',
      items: [{ productId: 'prod_demo_1', name: 'Bok Choy', qty: 10, unitPrice: 2.5, subtotal: 25 }, { productId: 'prod_demo_2', name: 'Spring Onion', qty: 5, unitPrice: 1.8, subtotal: 9 }],
      totalAmount: 34, status: 'IN_DELIVERY', deliveryBatch: '1 pm BAO' },
    { id: 'order_ie_002', restaurantId: 'cust_ie_002', restaurantName: 'Golden Dragon Cantonese Kitchen',
      items: [{ productId: 'prod_demo_3', name: 'Ginger Root', qty: 8, unitPrice: 3.2, subtotal: 25.6 }, { productId: 'prod_demo_4', name: 'Garlic Bulb', qty: 20, unitPrice: 0.9, subtotal: 18 }],
      totalAmount: 43.6, status: 'IN_DELIVERY', deliveryBatch: '1 pm BAO' },
    { id: 'order_ie_003', restaurantId: 'cust_ie_003', restaurantName: 'Red Lotus Thai & Asian Cuisine',
      items: [{ productId: 'prod_demo_5', name: 'Thai Basil', qty: 12, unitPrice: 2.0, subtotal: 24 }],
      totalAmount: 24, status: 'IN_DELIVERY', deliveryBatch: '2 pm SEAN' },
    { id: 'order_ie_004', restaurantId: 'cust_ie_004', restaurantName: 'Bamboo Garden Restaurant',
      items: [{ productId: 'prod_demo_6', name: 'Bean Sprouts', qty: 15, unitPrice: 1.5, subtotal: 22.5 }, { productId: 'prod_demo_7', name: 'Water Chestnut', qty: 6, unitPrice: 4.0, subtotal: 24 }],
      totalAmount: 46.5, status: 'CONFIRMED', deliveryBatch: null },
    { id: 'order_ie_005', restaurantId: 'cust_ie_005', restaurantName: 'Phoenix Asian Supermarket & Deli',
      items: [{ productId: 'prod_demo_8', name: 'Lemongrass', qty: 10, unitPrice: 2.2, subtotal: 22 }, { productId: 'prod_demo_9', name: 'Kaffir Lime Leaf', qty: 8, unitPrice: 3.0, subtotal: 24 }],
      totalAmount: 46, status: 'COMPLETED', deliveryBatch: '1 am AFZAAL' },
  ]

  // Upsert DriverSlot records for demo orders
  const demoDrivers = [
    { driverName: 'BAO', batchNum: 1, timeOfDay: 'pm' },
    { driverName: 'SEAN', batchNum: 2, timeOfDay: 'pm' },
    { driverName: 'AFZAAL', batchNum: 1, timeOfDay: 'am' },
  ]
  const driverSlotMap = new Map<string, string>()
  for (const d of demoDrivers) {
    const slot = await prisma.driverSlot.upsert({
      where: { timeOfDay_batchNum_driverName: { timeOfDay: d.timeOfDay, batchNum: d.batchNum, driverName: d.driverName } },
      update: {},
      create: { driverName: d.driverName, batchNum: d.batchNum, timeOfDay: d.timeOfDay },
    })
    driverSlotMap.set(d.driverName, slot.id)
  }

  function resolveDriverSlotId(batch: string | null): string | null {
    if (!batch) return null
    const parts = batch.trim().split(/\s+/)
    const name = parts.length >= 3 ? parts.slice(2).join(' ') : parts[parts.length - 1]
    return driverSlotMap.get(name.toUpperCase()) ?? null
  }

  for (const o of DEMO_ORDERS) {
    const driverSlotId = resolveDriverSlotId(o.deliveryBatch)
    await prisma.order.upsert({
      where: { id: o.id },
      update: { status: o.status, deliveryBatch: o.deliveryBatch, driverSlotId },
      create: {
        id: o.id,
        restaurantId: o.restaurantId,
        restaurantName: o.restaurantName,
        items: o.items as any,
        totalAmount: o.totalAmount,
        status: o.status,
        deliveryBatch: o.deliveryBatch,
        driverSlotId,
      },
    })
  }
  console.log(`✅ 示例订单: ${DEMO_ORDERS.length} 条`)

  // ── 行程种子数据（各种状态）────────────────────────────────────────────
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
          items: [{ productId: 'prod_demo_1', name: 'Bok Choy', qty: 10, unitPrice: 2.5, subtotal: 25 }, { productId: 'prod_demo_2', name: 'Spring Onion', qty: 5, unitPrice: 1.8, subtotal: 9 }],
          delivered: true,
          returns: [],
          pods: [],
          cargoVerified: true,
        },
        {
          restaurantId: 'cust_ie_002',
          restaurantName: 'Golden Dragon Cantonese Kitchen',
          address: '8 Thomas Street, Dublin 8, D08 AC45',
          orderIds: ['order_ie_002'],
          items: [{ productId: 'prod_demo_3', name: 'Ginger Root', qty: 8, unitPrice: 3.2, subtotal: 25.6 }, { productId: 'prod_demo_4', name: 'Garlic Bulb', qty: 20, unitPrice: 0.9, subtotal: 18 }],
          delivered: false,
          returns: [],
          pods: [],
          cargoVerified: true,
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
          items: [{ productId: 'prod_demo_5', name: 'Thai Basil', qty: 12, unitPrice: 2.0, subtotal: 24 }],
          delivered: false,
          returns: [],
          pods: [],
          cargoVerified: false,
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
          items: [{ productId: 'prod_demo_1', name: 'Bok Choy', qty: 6, unitPrice: 2.5, subtotal: 15 }],
          delivered: true,
          returns: [],
          pods: [],
          cargoVerified: true,
        },
        {
          restaurantId: 'cust_ie_004',
          restaurantName: 'Bamboo Garden Restaurant',
          address: '55 Manor Street, Dublin 7, D07 TR12',
          orderIds: [],
          items: [{ productId: 'prod_demo_6', name: 'Bean Sprouts', qty: 15, unitPrice: 1.5, subtotal: 22.5 }],
          delivered: true,
          returns: [],
          pods: [],
          cargoVerified: true,
        },
        {
          restaurantId: 'cust_ie_005',
          restaurantName: 'Phoenix Asian Supermarket & Deli',
          address: '101 Capel Street, Dublin 1, D01 YH66',
          orderIds: ['order_ie_005'],
          items: [{ productId: 'prod_demo_8', name: 'Lemongrass', qty: 10, unitPrice: 2.2, subtotal: 22 }, { productId: 'prod_demo_9', name: 'Kaffir Lime Leaf', qty: 8, unitPrice: 3.0, subtotal: 24 }],
          delivered: true,
          returns: [],
          pods: [],
          cargoVerified: true,
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
          items: [{ productId: 'prod_demo_3', name: 'Ginger Root', qty: 4, unitPrice: 3.2, subtotal: 12.8 }],
          delivered: false,
          returns: [],
          pods: [],
          cargoVerified: false,
        },
        {
          restaurantId: 'cust_ie_003',
          restaurantName: 'Red Lotus Thai & Asian Cuisine',
          address: '22 Camden Street Lower, Dublin 2, D02 PK88',
          orderIds: [],
          items: [{ productId: 'prod_demo_5', name: 'Thai Basil', qty: 6, unitPrice: 2.0, subtotal: 12 }],
          delivered: false,
          returns: [],
          pods: [],
          cargoVerified: false,
        },
      ],
    },
  ]

  for (const t of DEMO_TRIPS) {
    await prisma.trip.upsert({
      where: { id: t.id },
      update: { name: t.name, status: t.status as any, restaurants: t.restaurants as any },
      create: {
        id: t.id,
        name: t.name,
        timeSlot: t.timeSlot,
        driverName: t.driverName,
        departTime: t.departTime,
        status: t.status as any,
        restaurants: t.restaurants as any,
      },
    })
  }
  console.log(`✅ 示例行程: ${DEMO_TRIPS.length} 条（IN_PROGRESS · PENDING · COMPLETED · PENDING_ASSIGNMENT）`)

  console.log('\n🎉 种子数据导入完成！')
  console.log('\n📋 测试账号（密码见上方 SEED_PASSWORD / 随机生成的那一行）:')
  SEED_USERS.forEach(u => console.log(`  ${u.role.padEnd(12)} ${u.email}`))
}

main()
  .catch(e => { console.error('❌ 导入失败:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
