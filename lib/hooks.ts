'use client'
import { useState, useEffect, useCallback } from 'react'
import { apiGet } from './api'
import { getSession, toRoleSession } from './session'
import type { Product, Order, PickingWave, Trip, RoleSession, Customer, OdooPricelist, Invoice, PurchaseRecord, StockMove, ProductCategory } from './types'

// ─── Role ─────────────────────────────────────────────────────────────────────

export function useRole() {
  const [session, setSessionState] = useState<RoleSession | null>(null)

  useEffect(() => {
    const user = getSession()
    if (user) setSessionState(toRoleSession(user))
  }, [])

  const setSession = useCallback((s: RoleSession | null) => {
    setSessionState(s)
  }, [])

  return { session, setSession }
}

// ─── 通用 fetching hook 工厂 ─────────────────────────────────────────────────

function useApiData<T>(path: string, deps: unknown[] = []) {
  const [data, setData] = useState<T[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await apiGet<T[]>(path)
      setData(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { data, loading, error, refresh }
}

// ─── 各资源 hooks ─────────────────────────────────────────────────────────────

export function useProducts() {
  const { data: products, loading, error, refresh } = useApiData<Product>('/api/products')
  return { products, loading, error, refresh }
}

export function useProductCategories() {
  const { data: categories, loading, error, refresh } = useApiData<ProductCategory>('/api/product-categories')
  return { categories, loading, error, refresh }
}

export function useOrders(restaurantId?: string) {
  const path = restaurantId ? `/api/orders?restaurantId=${restaurantId}` : '/api/orders'
  const { data: orders, loading, error, refresh } = useApiData<Order>(path, [restaurantId])
  return { orders, loading, error, refresh }
}

export function useWaves() {
  const { data: waves, loading, error, refresh } = useApiData<PickingWave>('/api/waves')
  return { waves, loading, error, refresh }
}

export function useTrips(driverId?: string) {
  const path = driverId ? `/api/trips?driverId=${driverId}` : '/api/trips'
  const { data: trips, loading, error, refresh } = useApiData<Trip>(path, [driverId])
  return { trips, loading, error, refresh }
}

export function useCustomers() {
  const { data: customers, loading, error, refresh } = useApiData<Customer>('/api/customers')
  return { customers, loading, error, refresh }
}

export function usePricelists() {
  const { data: pricelists, loading, error, refresh } = useApiData<OdooPricelist>('/api/pricelists')
  return { pricelists, loading, error, refresh }
}

export function useInvoices() {
  const { data: invoices, loading, error, refresh } = useApiData<Invoice>('/api/invoices')
  return { invoices, loading, error, refresh }
}

export function usePurchases() {
  const { data: purchases, loading, error, refresh } = useApiData<PurchaseRecord>('/api/purchases')
  return { purchases, loading, error, refresh }
}

export function useStockMoves(productId?: string) {
  const path = productId ? `/api/stock-moves?productId=${productId}` : '/api/stock-moves'
  const { data: moves, loading, error, refresh } = useApiData<StockMove>(path, [productId])
  return { moves, loading, error, refresh }
}
