'use client'
import type {
  AppStore, Product, ProductTemplate, ProductAttribute, Order, PickingWave, Trip,
  RoleSession, Customer, PurchaseRecord, OdooPricelist, ProductCategory,
  Invoice, InvoiceLine, StockMove,
} from './types'
import { DEMO_CUSTOMERS, MOCK_PRODUCTS, MOCK_PURCHASES } from './mock-data'
import { SEED_PRICELISTS } from './seed-pricelists'
import { SEED_DEMO_CUSTOMERS } from './seed-customers'
import { SEED_CATEGORIES, SEED_PRODUCT_TEMPLATES, SEED_PRODUCT_ATTRIBUTES, SEED_PRODUCTS } from './seed-products'
import { getSession } from './session'
import { canAccessApi, type TokenClaims } from './rbac/gate'

const STORAGE_KEY = 'veggie_demo_store'

function now(): string {
  return new Date().toISOString()
}

export function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

// ─── API 调用帮助函数 ─────────────────────────────────────────────────────

function getToken(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem('veggie_token') ?? ''
}

function api(path: string, method = 'GET', body?: unknown): Promise<Response> {
  const token = getToken()
  return fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

// 枚举值从 DB 大写转为 TS 小写（WAVE_ASSIGNED → wave_assigned）
function lowerEnum(s: string | undefined | null): string {
  return (s ?? '').toLowerCase()
}

function normalizeOrder(o: Record<string, unknown>): Order {
  return {
    ...(o as unknown as Order),
    status: lowerEnum(o.status as string) as Order['status'],
    paymentMethod: lowerEnum(o.paymentMethod as string) as Order['paymentMethod'],
    items: (o.items as Order['items']) ?? [],
  }
}

function normalizeWave(w: Record<string, unknown>): PickingWave {
  return {
    ...(w as unknown as PickingWave),
    status: lowerEnum(w.status as string) as PickingWave['status'],
    zones: (w.zones as PickingWave['zones']) ?? [],
    orderIds: (w.orderIds as string[]) ?? [],
  }
}

function normalizeTrip(t: Record<string, unknown>): Trip {
  return {
    ...(t as unknown as Trip),
    status: lowerEnum(t.status as string) as Trip['status'],
    restaurants: (t.restaurants as Trip['restaurants']) ?? [],
  }
}

function normalizeInvoice(inv: Record<string, unknown>): Invoice {
  return {
    ...(inv as unknown as Invoice),
    status: lowerEnum(inv.status as string) as Invoice['status'],
    lines: (inv.lines as Invoice['lines']) ?? [],
    saleOrderIds: (inv.saleOrderIds as string[]) ?? [],
  }
}

function normalizeProduct(p: Record<string, unknown>): Product {
  return {
    ...(p as unknown as Product),
    status: lowerEnum(p.status as string) as Product['status'],
    images: (p.images as string[]) ?? [],
    variantAttributes: (p.variantAttributes as Product['variantAttributes']) ?? [],
  }
}

function normalizeTemplate(t: Record<string, unknown>): ProductTemplate {
  return {
    ...(t as unknown as ProductTemplate),
    status: lowerEnum(t.status as string) as ProductTemplate['status'],
    type: lowerEnum(t.type as string) as ProductTemplate['type'],
    images: (t.images as string[]) ?? [],
    attributeLines: (t.attributeLines as ProductTemplate['attributeLines']) ?? [],
  }
}

function normalizeStockMove(m: Record<string, unknown>): StockMove {
  return {
    ...(m as unknown as StockMove),
    type: lowerEnum(m.type as string) as StockMove['type'],
  }
}

// ─── 读 / 写 localStorage ─────────────────────────────────────────────────

export function loadStore(): AppStore {
  if (typeof window === 'undefined') return emptyStore()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return migrateStore(JSON.parse(raw) as AppStore)
  } catch {}
  return emptyStore()
}

export function saveStore(store: AppStore): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch (e) {
    if (e instanceof DOMException && e.name === 'QuotaExceededError') {
      // Trim historical data and retry once
      const slim: AppStore = {
        ...store,
        orders: store.orders.slice(0, 200),
        stockMoves: store.stockMoves?.slice(0, 100) ?? [],
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(slim))
      } catch {
        // If still too large, clear and start fresh next load
        localStorage.removeItem(STORAGE_KEY)
      }
    }
  }
}

function emptyStore(): AppStore {
  const allCustomers = [...SEED_DEMO_CUSTOMERS, ...DEMO_CUSTOMERS] as Customer[]
  return {
    productTemplates: SEED_PRODUCT_TEMPLATES,
    products: [...SEED_PRODUCTS, ...MOCK_PRODUCTS],
    productCategories: SEED_CATEGORIES,
    productAttributes: SEED_PRODUCT_ATTRIBUTES,
    customers: allCustomers,
    orders: [],
    waves: [],
    trips: [],
    purchases: MOCK_PURCHASES,
    invoices: [],
    stockMoves: [],
    roleSession: null,
    odooLists: SEED_PRICELISTS,
  }
}

// 兼容旧版 store
function migrateStore(s: AppStore): AppStore {
  if (!s.customers) s.customers = DEMO_CUSTOMERS
  if (!s.purchases) s.purchases = MOCK_PURCHASES
  if (!s.odooLists) s.odooLists = SEED_PRICELISTS
  if (!s.productCategories) s.productCategories = SEED_CATEGORIES
  if (!s.productTemplates) s.productTemplates = SEED_PRODUCT_TEMPLATES
  if (!s.productAttributes) s.productAttributes = SEED_PRODUCT_ATTRIBUTES
  if (!s.invoices) s.invoices = []
  if (!s.stockMoves) s.stockMoves = []
  s.customers.forEach((c, i) => {
    if (!c.paymentTerm) {
      const defaultTerms: Record<string, 'cash' | 'weekly' | 'monthly'> = {
        rest_001: 'weekly', rest_002: 'monthly', rest_003: 'cash', rest_004: 'weekly',
      }
      s.customers[i] = { ...c, paymentTerm: defaultTerms[c.id] ?? 'cash' }
    }
  })
  s.products.forEach((p, i) => {
    if (!p.templateId) s.products[i] = { ...p, templateId: `tmpl_${p.id}`, variantAttributes: [], active: p.status === 'active' }
    if (p.active === undefined) s.products[i] = { ...s.products[i], active: p.status === 'active' }
  })
  return s
}

// ─── hydrate：从 API 同步全量数据到 localStorage ───────────────────────────

export async function hydrate(): Promise<void> {
  if (typeof window === 'undefined') return
  const token = getToken()
  if (!token) return

  // ⛔ 只拉当前会话**够得着**的那几个。原先是无差别八连发：司机一登录就打出
  // 7 个 403（orders/waves/invoices/customers/pricelists/stock-moves/purchases），
  // 控制台一片红，还白白占掉这台 2 vCPU 机器的并发。权限是对的（403 说明隔离生效），
  // 浪费的是请求本身。判定用的是 middleware 那张表，不会出现「这里放行而服务端 403」。
  const claims = (getSession() ?? {}) as TokenClaims
  const fetchAllowed = (path: string): Promise<Response | null> =>
    canAccessApi(claims, path, 'GET') ? api(path) : Promise.resolve(null)

  try {
    const [
      ordersRes, wavesRes, tripsRes, invoicesRes,
      customersRes, pricelistsRes, stockMovesRes, purchasesRes,
    ] = await Promise.allSettled([
      fetchAllowed('/api/orders'),
      fetchAllowed('/api/waves'),
      fetchAllowed('/api/trips'),
      fetchAllowed('/api/invoices'),
      fetchAllowed('/api/customers'),
      fetchAllowed('/api/pricelists'),
      fetchAllowed('/api/stock-moves'),
      fetchAllowed('/api/purchases'),
    ])

    const s = loadStore()

    if (ordersRes.status === 'fulfilled' && ordersRes.value?.ok) {
      const data = await ordersRes.value!.json() as Record<string, unknown>[]
      s.orders = data.map(normalizeOrder)
    }
    if (wavesRes.status === 'fulfilled' && wavesRes.value?.ok) {
      const data = await wavesRes.value!.json() as Record<string, unknown>[]
      s.waves = data.map(normalizeWave)
    }
    if (tripsRes.status === 'fulfilled' && tripsRes.value?.ok) {
      const data = await tripsRes.value!.json() as Record<string, unknown>[]
      s.trips = data.map(normalizeTrip)
    }
    if (invoicesRes.status === 'fulfilled' && invoicesRes.value?.ok) {
      const data = await invoicesRes.value!.json() as Record<string, unknown>[]
      s.invoices = data.map(normalizeInvoice)
    }
    if (customersRes.status === 'fulfilled' && customersRes.value?.ok) {
      const data = await customersRes.value!.json() as Customer[]
      if (data.length > 0) s.customers = data
    }
    if (pricelistsRes.status === 'fulfilled' && pricelistsRes.value?.ok) {
      const data = await pricelistsRes.value!.json() as OdooPricelist[]
      if (data.length > 0) s.odooLists = data
    }
    if (stockMovesRes.status === 'fulfilled' && stockMovesRes.value?.ok) {
      const data = await stockMovesRes.value!.json() as Record<string, unknown>[]
      s.stockMoves = data.map(normalizeStockMove)
    }
    if (purchasesRes.status === 'fulfilled' && purchasesRes.value?.ok) {
      const data = await purchasesRes.value!.json() as PurchaseRecord[]
      if (data.length > 0) s.purchases = data
    }

    saveStore(s)
  } catch (err) {
    console.error('[hydrate] 数据同步失败', err)
  }
}

// ─── 便捷操作函数 ─────────────────────────────────────────────────────────

export const StoreAPI = {
  // Role — stored in sessionStorage so each browser tab has its own identity
  setRole(session: RoleSession | null) {
    if (typeof window === 'undefined') return
    if (session) sessionStorage.setItem('veggie_role', JSON.stringify(session))
    else sessionStorage.removeItem('veggie_role')
  },
  getRole(): RoleSession | null {
    if (typeof window === 'undefined') return null
    try {
      const raw = sessionStorage.getItem('veggie_role')
      return raw ? (JSON.parse(raw) as RoleSession) : null
    } catch { return null }
  },

  // Customers
  getCustomers(): Customer[] {
    return loadStore().customers
  },
  upsertCustomer(c: Customer) {
    const s = loadStore()
    const idx = s.customers.findIndex(x => x.id === c.id)
    if (idx >= 0) {
      s.customers[idx] = c
    } else {
      s.customers.unshift(c)
    }
    saveStore(s)
    // 持久化到 DB
    const isNew = idx < 0
    api(isNew ? '/api/customers' : `/api/customers/${c.id}`, isNew ? 'POST' : 'PUT', c)
      .catch(err => console.error('[store] upsertCustomer API error', err))
  },
  newCustomer(): Customer {
    return {
      id: genId('rest'),
      name: '',
      address: '',
      phone: '',
      email: '',
      vatNumber: '',
      paymentTerm: 'cash',
      createdAt: now(),
    }
  },

  // Product Templates
  getProductTemplates(): ProductTemplate[] {
    return loadStore().productTemplates ?? []
  },
  upsertProductTemplate(t: ProductTemplate) {
    const s = loadStore()
    if (!s.productTemplates) s.productTemplates = []
    const idx = s.productTemplates.findIndex(x => x.id === t.id)
    if (idx >= 0) s.productTemplates[idx] = t
    else s.productTemplates.unshift(t)
    saveStore(s)
    const isNew = idx < 0
    api(isNew ? '/api/product-templates' : `/api/product-templates/${t.id}`, isNew ? 'POST' : 'PUT', t)
      .catch(err => console.error('[store] upsertProductTemplate API error', err))
  },
  deleteProductTemplate(id: string) {
    const s = loadStore()
    if (!s.productTemplates) return
    s.productTemplates = s.productTemplates.filter(x => x.id !== id)
    s.products = s.products.filter(x => x.templateId !== id)
    saveStore(s)
    api(`/api/product-templates/${id}`, 'DELETE')
      .catch(err => console.error('[store] deleteProductTemplate API error', err))
  },
  newProductTemplate(): ProductTemplate {
    return {
      id: genId('tmpl'),
      name: '',
      listPrice: 0,
      standardPrice: 0,
      customerTaxRate: 0.135,
      type: 'product',
      canBeSold: true,
      canBePurchased: true,
      images: [],
      attributeLines: [],
      status: 'draft',
      createdAt: now(),
    }
  },

  // Product Attributes
  getProductAttributes(): ProductAttribute[] {
    return loadStore().productAttributes ?? []
  },
  upsertProductAttribute(a: ProductAttribute) {
    const s = loadStore()
    if (!s.productAttributes) s.productAttributes = []
    const idx = s.productAttributes.findIndex(x => x.id === a.id)
    if (idx >= 0) s.productAttributes[idx] = a
    else s.productAttributes.unshift(a)
    saveStore(s)
  },

  // Products (variants)
  getProducts(): Product[] {
    return loadStore().products
  },
  upsertProduct(p: Product) {
    const s = loadStore()
    const idx = s.products.findIndex(x => x.id === p.id)
    if (idx >= 0) s.products[idx] = p
    else s.products.unshift(p)
    saveStore(s)
    const isNew = idx < 0
    api(isNew ? '/api/products' : `/api/products/${p.id}`, isNew ? 'POST' : 'PUT', p)
      .catch(err => console.error('[store] upsertProduct API error', err))
  },
  deleteProduct(id: string) {
    const s = loadStore()
    s.products = s.products.filter(x => x.id !== id)
    saveStore(s)
    api(`/api/products/${id}`, 'DELETE')
      .catch(err => console.error('[store] deleteProduct API error', err))
  },
  newProduct(templateId?: string): Product {
    return {
      id: genId('prod'),
      templateId: templateId ?? genId('tmpl'),
      name: '',
      variantAttributes: [],
      spec: '',
      price: 0,
      listPrice: 0,
      qtyOnHand: 0,
      stock: 0,
      active: true,
      status: 'draft',
      images: [],
      createdAt: now(),
    }
  },

  // Orders
  getOrders(): Order[] {
    return loadStore().orders
  },
  addOrder(o: Order) {
    const s = loadStore()
    s.orders.unshift(o)
    saveStore(s)
    api('/api/orders', 'POST', o)
      .catch(err => console.error('[store] addOrder API error', err))
  },
  updateOrderStatus(id: string, status: Order['status']) {
    const s = loadStore()
    const o = s.orders.find(x => x.id === id)
    if (o) {
      o.status = status
      saveStore(s)
      api(`/api/orders/${id}`, 'PUT', { status })
        .catch(err => console.error('[store] updateOrderStatus API error', err))
    }
  },

  // Waves
  getWaves(): PickingWave[] {
    return loadStore().waves
  },
  addWave(w: PickingWave) {
    const s = loadStore()
    s.waves.unshift(w)
    w.orderIds.forEach(oid => {
      const o = s.orders.find(x => x.id === oid)
      if (o) o.status = 'wave_assigned'
    })
    saveStore(s)
    api('/api/waves', 'POST', w)
      .catch(err => console.error('[store] addWave API error', err))
  },
  updateWave(w: PickingWave) {
    const s = loadStore()
    const idx = s.waves.findIndex(x => x.id === w.id)
    if (idx >= 0) {
      s.waves[idx] = w
      saveStore(s)
      api(`/api/waves/${w.id}`, 'PUT', w)
        .catch(err => console.error('[store] updateWave API error', err))
    }
  },

  // Trips
  getTrips(): Trip[] {
    return loadStore().trips
  },
  addTrip(t: Trip) {
    const s = loadStore()
    s.trips.unshift(t)
    t.restaurants.forEach(r => {
      r.orderIds.forEach(oid => {
        const o = s.orders.find(x => x.id === oid)
        if (o) o.status = 'in_delivery'
      })
    })
    saveStore(s)
    api('/api/trips', 'POST', t)
      .catch(err => console.error('[store] addTrip API error', err))
  },
  updateTrip(t: Trip) {
    const s = loadStore()
    const idx = s.trips.findIndex(x => x.id === t.id)
    if (idx >= 0) {
      s.trips[idx] = t
      if (t.status === 'completed') {
        t.restaurants.forEach(r => {
          r.orderIds.forEach(oid => {
            const o = s.orders.find(x => x.id === oid)
            if (o) o.status = 'completed'
          })
        })
      }
      saveStore(s)
      api(`/api/trips/${t.id}`, 'PUT', t)
        .catch(err => console.error('[store] updateTrip API error', err))
    }
  },

  // Purchases
  getPurchases(): PurchaseRecord[] {
    return loadStore().purchases
  },
  addPurchase(p: PurchaseRecord) {
    const s = loadStore()
    s.purchases.unshift(p)
    const prod = s.products.find(x => x.id === p.productId)
    if (prod) {
      const oldQty = prod.qtyOnHand ?? 0
      const oldCost = prod.standardPrice ?? 0
      const newQty = oldQty + p.quantity
      const newCost = newQty > 0 ? (oldQty * oldCost + p.quantity * p.unitCost) / newQty : p.unitCost
      prod.qtyOnHand = newQty
      prod.standardPrice = Math.round(newCost * 100) / 100
    }
    s.stockMoves.unshift({
      id: genId('sm'),
      productId: p.productId,
      productName: p.productName,
      type: 'in',
      qty: p.quantity,
      note: `采购入库 - ${p.supplier}`,
      createdAt: p.arrivedAt,
    })
    saveStore(s)
    api('/api/purchases', 'POST', p)
      .catch(err => console.error('[store] addPurchase API error', err))
    api('/api/stock-moves', 'POST', {
      productId: p.productId, productName: p.productName,
      type: 'in', qty: p.quantity, note: `采购入库 - ${p.supplier}`,
    }).catch(err => console.error('[store] addPurchase stock-move API error', err))
  },

  // Invoices
  getInvoices(): Invoice[] {
    return loadStore().invoices ?? []
  },
  upsertInvoice(inv: Invoice) {
    const s = loadStore()
    if (!s.invoices) s.invoices = []
    const idx = s.invoices.findIndex(x => x.id === inv.id)
    if (idx >= 0) s.invoices[idx] = inv
    else s.invoices.unshift(inv)
    saveStore(s)
    const isNew = idx < 0
    api(isNew ? '/api/invoices' : `/api/invoices/${inv.id}`, isNew ? 'POST' : 'PUT', inv)
      .catch(err => console.error('[store] upsertInvoice API error', err))
  },
  generateInvoiceFromOrders(orderIds: string[]): Invoice | null {
    const s = loadStore()
    const orders = s.orders.filter(o => orderIds.includes(o.id))
    if (orders.length === 0) return null
    const firstOrder = orders[0]
    const customer = s.customers.find(c => c.id === firstOrder.restaurantId)

    const lineMap = new Map<string, InvoiceLine>()
    orders.forEach(order => {
      order.items.forEach(item => {
        const key = item.productId
        const taxRate = 0.135
        if (lineMap.has(key)) {
          const l = lineMap.get(key)!
          l.qty += item.quantity
          l.subtotalExTax = Math.round(l.qty * l.unitPrice * (1 / (1 + taxRate)) * 100) / 100
          l.taxAmount = Math.round(l.subtotalExTax * taxRate * 100) / 100
          l.subtotalIncTax = Math.round(l.qty * l.unitPrice * 100) / 100
        } else {
          const subtotalIncTax = Math.round(item.price * item.quantity * 100) / 100
          const subtotalExTax = Math.round(subtotalIncTax / (1 + taxRate) * 100) / 100
          lineMap.set(key, {
            productId: item.productId,
            productName: item.productName,
            spec: item.spec,
            qty: item.quantity,
            unitPrice: item.price,
            taxRate,
            subtotalExTax,
            taxAmount: Math.round(subtotalIncTax - subtotalExTax),
            subtotalIncTax,
          })
        }
      })
    })
    const lines = Array.from(lineMap.values())
    const subtotalExTax = lines.reduce((acc, l) => acc + l.subtotalExTax, 0)
    const totalTax = lines.reduce((acc, l) => acc + l.taxAmount, 0)
    const totalIncTax = lines.reduce((acc, l) => acc + l.subtotalIncTax, 0)

    const invNum = String(s.invoices ? s.invoices.length + 1 : 1).padStart(4, '0')
    const inv: Invoice = {
      id: genId('inv'),
      name: `INV-${invNum}`,
      customerId: firstOrder.restaurantId,
      customerName: firstOrder.restaurantName,
      saleOrderIds: orderIds,
      lines,
      subtotalExTax: Math.round(subtotalExTax * 100) / 100,
      totalTax: Math.round(totalTax * 100) / 100,
      totalIncTax: Math.round(totalIncTax * 100) / 100,
      amountPaid: 0,
      amountDue: Math.round(totalIncTax * 100) / 100,
      status: 'draft',
      paymentTerms: customer?.paymentTerm ?? 'cash',
      createdAt: now(),
    }
    return inv
  },

  // StockMoves
  getStockMoves(): StockMove[] {
    return loadStore().stockMoves ?? []
  },
  addStockAdjustment(productId: string, qty: number, note: string) {
    const s = loadStore()
    if (!s.stockMoves) s.stockMoves = []
    const prod = s.products.find(x => x.id === productId)
    if (!prod) return
    prod.qtyOnHand = (prod.qtyOnHand ?? 0) + qty
    s.stockMoves.unshift({
      id: genId('sm'),
      productId,
      productName: prod.name,
      type: 'adjustment',
      qty,
      note,
      createdAt: now(),
    })
    saveStore(s)
    api('/api/stock-moves', 'POST', {
      productId, productName: prod.name, type: 'adjustment', qty, note,
    }).catch(err => console.error('[store] addStockAdjustment API error', err))
  },

  // OdooPricelists
  getOdooLists(): OdooPricelist[] {
    return loadStore().odooLists ?? []
  },
  upsertOdooList(pl: OdooPricelist) {
    const s = loadStore()
    if (!s.odooLists) s.odooLists = []
    const idx = s.odooLists.findIndex(x => x.id === pl.id)
    if (idx >= 0) s.odooLists[idx] = pl
    else s.odooLists.unshift(pl)
    saveStore(s)
    const isNew = idx < 0
    api(isNew ? '/api/pricelists' : `/api/pricelists/${pl.id}`, isNew ? 'POST' : 'PUT', pl)
      .catch(err => console.error('[store] upsertOdooList API error', err))
  },
  deleteOdooList(id: string) {
    const s = loadStore()
    if (!s.odooLists) return
    s.odooLists = s.odooLists.filter(x => x.id !== id)
    saveStore(s)
    api(`/api/pricelists/${id}`, 'DELETE')
      .catch(err => console.error('[store] deleteOdooList API error', err))
  },
  newOdooList(): OdooPricelist {
    return {
      id: genId('pl'),
      name: '',
      currency: 'EUR',
      items: [],
      sequence: 99,
      selectable: true,
      active: true,
      updatedAt: now(),
    }
  },

  // ProductCategories
  getProductCategories(): ProductCategory[] {
    return loadStore().productCategories ?? []
  },
  upsertProductCategory(cat: ProductCategory) {
    const s = loadStore()
    if (!s.productCategories) s.productCategories = []
    const idx = s.productCategories.findIndex(x => x.id === cat.id)
    if (idx >= 0) s.productCategories[idx] = cat
    else s.productCategories.unshift(cat)
    saveStore(s)
    const isNew = idx < 0
    api(isNew ? '/api/product-categories' : `/api/product-categories/${cat.id}`, isNew ? 'POST' : 'PUT', cat)
      .catch(err => console.error('[store] upsertProductCategory API error', err))
  },

  // 重置（开发用）
  resetStore() {
    if (typeof window !== 'undefined') localStorage.removeItem(STORAGE_KEY)
  },
}
