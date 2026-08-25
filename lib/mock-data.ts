import type { Product, Customer, PurchaseRecord } from './types'

// 使用 Wikimedia Commons 真实蔬菜图片（公共领域/CC 授权）
function wimg(filename: string) {
  return `https://commons.wikimedia.org/w/index.php?title=Special:Redirect/file/${encodeURIComponent(filename)}&width=400`
}

export const MOCK_PRODUCTS: Product[] = [
  {
    id: 'prod_001',
    name: '本地菠菜',
    variantAttributes: [],
    spec: '1 bunch / ~500g',
    price: 2.50,
    listPrice: 2.50,
    stock: 120,
    qtyOnHand: 120,
    active: true,
    status: 'active',
    images: [wimg('Spinach_leaves.jpg')],
    createdAt: '2026-04-08T08:00:00.000Z',
  },
  {
    id: 'prod_002',
    name: '新鲜胡萝卜',
    variantAttributes: [],
    spec: '1 bag / 5kg',
    price: 6.50,
    listPrice: 6.50,
    stock: 80,
    qtyOnHand: 80,
    active: true,
    status: 'active',
    images: [wimg('Carrots.JPG')],
    createdAt: '2026-04-08T08:00:00.000Z',
  },
  {
    id: 'prod_003',
    name: '有机西兰花',
    variantAttributes: [],
    spec: '1 head / ~600g',
    price: 3.20,
    listPrice: 3.20,
    stock: 60,
    qtyOnHand: 60,
    active: true,
    status: 'active',
    images: [wimg('Broccoli_and_cross_section_edit.jpg')],
    createdAt: '2026-04-08T09:00:00.000Z',
  },
  {
    id: 'prod_004',
    name: '白玉菇',
    variantAttributes: [],
    spec: '1 pack / 250g',
    price: 2.20,
    listPrice: 2.20,
    stock: 200,
    qtyOnHand: 200,
    active: true,
    status: 'active',
    images: [wimg('Agaricus_bisporus_Zuchtchampignon.JPG')],
    createdAt: '2026-04-08T09:00:00.000Z',
  },
  {
    id: 'prod_005',
    name: '大白菜',
    variantAttributes: [],
    spec: '1 head / ~2kg',
    price: 1.80,
    listPrice: 1.80,
    stock: 150,
    qtyOnHand: 150,
    active: true,
    status: 'active',
    images: [wimg('Napa_cabbage.jpg')],
    createdAt: '2026-04-09T08:00:00.000Z',
  },
  {
    id: 'prod_006',
    name: '土豆（黄皮）',
    variantAttributes: [],
    spec: '1 box / 10kg',
    price: 9.90,
    listPrice: 9.90,
    stock: 40,
    qtyOnHand: 40,
    active: true,
    status: 'active',
    images: [wimg('Potato_potato.jpg')],
    createdAt: '2026-04-09T08:00:00.000Z',
  },
  {
    id: 'prod_007',
    name: '精品番茄',
    variantAttributes: [],
    spec: '1 tray / 1kg',
    price: 4.50,
    listPrice: 4.50,
    stock: 90,
    qtyOnHand: 90,
    active: false,
    status: 'draft',
    images: [wimg('Tomatoes.JPG')],
    createdAt: '2026-04-09T10:00:00.000Z',
  },
  {
    id: 'prod_008',
    name: '青椒',
    variantAttributes: [],
    spec: '1 bag / 500g',
    price: 2.80,
    listPrice: 2.80,
    stock: 110,
    qtyOnHand: 110,
    active: true,
    status: 'active',
    images: [wimg('Green-Bell-Pepper.jpg')],
    createdAt: '2026-04-09T10:00:00.000Z',
  },
]

export const DEMO_CUSTOMERS: Customer[] = [
  {
    id: 'rest_001',
    name: 'Hang Dai Chinese',
    address: '20 Camden Street Lower, Dublin 2, D02 VH99',
    phone: '+353 1 678 5576',
    email: 'info@hangdai.ie',
    vatNumber: 'IE1234567T',
    paymentTerm: 'weekly',
    creditLimit: 500,
    commissionRate: 0.05,
    createdAt: '2026-01-15T09:00:00.000Z',
  },
  {
    id: 'rest_002',
    name: 'Good World',
    address: '18 South Great George\'s Street, Dublin 2, D02 KH83',
    phone: '+353 1 677 5373',
    email: 'orders@goodworld.ie',
    vatNumber: 'IE2345678A',
    paymentTerm: 'monthly',
    creditLimit: 1200,
    commissionRate: 0.04,
    createdAt: '2026-02-01T09:00:00.000Z',
  },
  {
    id: 'rest_003',
    name: 'Pearl River',
    address: '20 Clarendon Street, Dublin 2, D02 VP77',
    phone: '+353 1 677 8559',
    email: 'supply@pearlriver.ie',
    vatNumber: 'IE3456789B',
    paymentTerm: 'cash',
    commissionRate: 0.03,
    createdAt: '2026-02-20T09:00:00.000Z',
  },
  {
    id: 'rest_004',
    name: 'Ka Shing',
    address: '15 Parnell Street, Dublin 1, D01 E5H9',
    phone: '+353 1 872 7388',
    email: 'purchase@kashing.ie',
    vatNumber: 'IE4567890C',
    paymentTerm: 'weekly',
    creditLimit: 800,
    commissionRate: 0.05,
    createdAt: '2026-03-05T09:00:00.000Z',
  },
]

// 向后兼容：其他模块直接用 {id, name} 的地方继续可用
export const DEMO_RESTAURANTS = DEMO_CUSTOMERS.map(c => ({ id: c.id, name: c.name }))

export const DEMO_BOSS = [
  { id: 'boss_001', name: 'Boss - Owner' },
]

export const DEMO_FINANCE = [
  { id: 'fin_001', name: 'Finance - Mary' },
]

export const DEMO_WAREHOUSE = [
  { id: 'wh_001', name: 'Warehouse - Tom' },
]

export const DEMO_OPERATORS = [
  { id: 'op_001', name: 'Operator - Li Mei' },
]

export const DEMO_SORTERS = [
  { id: 'sorter_001', name: 'Sorter - Chen Fang' },
]

export const DEMO_DRIVERS = [
  { id: 'cmo2ammh100056mylz54y3hym', name: '司机小张 (driver@veggie.com)' },
  { id: 'driver_002', name: 'Driver - Liu Yang' },
]

// 采购记录（近7天，6种商品，3个供应商）
const d = (daysAgo: number, hour = 9) => {
  const dt = new Date('2026-04-11T00:00:00.000Z')
  dt.setDate(dt.getDate() - daysAgo)
  dt.setHours(hour, 0, 0, 0)
  return dt.toISOString()
}

export const MOCK_PURCHASES: PurchaseRecord[] = [
  // 今日 (day 0)
  { id: 'pur_001', productId: 'prod_001', productName: '本地菠菜', spec: '1 bunch / ~500g', quantity: 200, unitCost: 1.20, supplier: 'Green Farm Co.', arrivedAt: d(0, 7), createdAt: d(0, 7) },
  { id: 'pur_002', productId: 'prod_002', productName: '新鲜胡萝卜', spec: '1 bag / 5kg', quantity: 50, unitCost: 3.80, supplier: 'Root Supply Ltd.', arrivedAt: d(0, 8), createdAt: d(0, 8) },
  { id: 'pur_003', productId: 'prod_005', productName: '大白菜', spec: '1 head / ~2kg', quantity: 80, unitCost: 0.90, supplier: 'Green Farm Co.', arrivedAt: d(0, 9), createdAt: d(0, 9) },
  // 1天前
  { id: 'pur_004', productId: 'prod_003', productName: '有机西兰花', spec: '1 head / ~600g', quantity: 60, unitCost: 1.80, supplier: 'Organic Fresh IE', arrivedAt: d(1, 8), createdAt: d(1, 8) },
  { id: 'pur_005', productId: 'prod_006', productName: '土豆（黄皮）', spec: '1 box / 10kg', quantity: 30, unitCost: 5.50, supplier: 'Root Supply Ltd.', arrivedAt: d(1, 9), createdAt: d(1, 9) },
  // 2天前
  { id: 'pur_006', productId: 'prod_004', productName: '白玉菇', spec: '1 pack / 250g', quantity: 150, unitCost: 1.10, supplier: 'Organic Fresh IE', arrivedAt: d(2, 7), createdAt: d(2, 7) },
  { id: 'pur_007', productId: 'prod_001', productName: '本地菠菜', spec: '1 bunch / ~500g', quantity: 160, unitCost: 1.20, supplier: 'Green Farm Co.', arrivedAt: d(2, 8), createdAt: d(2, 8) },
  // 3天前
  { id: 'pur_008', productId: 'prod_002', productName: '新鲜胡萝卜', spec: '1 bag / 5kg', quantity: 40, unitCost: 3.80, supplier: 'Root Supply Ltd.', arrivedAt: d(3, 9), createdAt: d(3, 9) },
  { id: 'pur_009', productId: 'prod_005', productName: '大白菜', spec: '1 head / ~2kg', quantity: 100, unitCost: 0.90, supplier: 'Green Farm Co.', arrivedAt: d(3, 10), createdAt: d(3, 10) },
  // 4天前
  { id: 'pur_010', productId: 'prod_003', productName: '有机西兰花', spec: '1 head / ~600g', quantity: 50, unitCost: 1.80, supplier: 'Organic Fresh IE', arrivedAt: d(4, 8), createdAt: d(4, 8) },
  { id: 'pur_011', productId: 'prod_006', productName: '土豆（黄皮）', spec: '1 box / 10kg', quantity: 25, unitCost: 5.50, supplier: 'Root Supply Ltd.', arrivedAt: d(4, 9), createdAt: d(4, 9) },
  // 5天前
  { id: 'pur_012', productId: 'prod_004', productName: '白玉菇', spec: '1 pack / 250g', quantity: 120, unitCost: 1.10, supplier: 'Organic Fresh IE', arrivedAt: d(5, 7), createdAt: d(5, 7) },
  { id: 'pur_013', productId: 'prod_001', productName: '本地菠菜', spec: '1 bunch / ~500g', quantity: 180, unitCost: 1.20, supplier: 'Green Farm Co.', arrivedAt: d(5, 8), createdAt: d(5, 8) },
  // 6天前
  { id: 'pur_014', productId: 'prod_002', productName: '新鲜胡萝卜', spec: '1 bag / 5kg', quantity: 45, unitCost: 3.80, supplier: 'Root Supply Ltd.', arrivedAt: d(6, 9), createdAt: d(6, 9) },
  { id: 'pur_015', productId: 'prod_005', productName: '大白菜', spec: '1 head / ~2kg', quantity: 90, unitCost: 0.90, supplier: 'Green Farm Co.', arrivedAt: d(6, 10), createdAt: d(6, 10) },
]

// 商品分区规则（简单按关键词）
export function getZone(productName: string): string {
  if (/菠菜|白菜|生菜|油菜|芹菜|韭菜/.test(productName)) return '叶菜区'
  if (/胡萝卜|土豆|萝卜|洋葱|姜|蒜/.test(productName)) return '根茎区'
  if (/菇|蘑菇|木耳/.test(productName)) return '菌菇区'
  return '配送区'
}
