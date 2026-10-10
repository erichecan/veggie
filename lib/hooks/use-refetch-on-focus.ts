'use client'
/**
 * useRefetchOnFocus - 切回这个 tab 时，把页面自己已有的数据加载函数重新跑一遍
 * -----------------------------------------------------------------------
 * 原来 orders/[id]、quotations/[id]、place-order 三处各自写了一份几乎一字不差的
 * window focus + visibilitychange + 30s 节流代码，且都只刷新了商品列表。这里收成
 * 共享 hook：不关心传入的函数加载的是商品、价格表、库存、客户还是别的什么 ——
 * 只认「这是不是一个要在 tab 切回来时重跑的加载函数」。
 *
 * 用法：
 *   useRefetchOnFocus([fetchProducts, fetchPricelist])
 */
import { useEffect, useRef } from 'react'

const DEFAULT_THROTTLE_MS = 30_000

/** 纯判定：距上次刷新是否已经够久，可独立单测，不依赖 DOM/时钟 */
export function shouldRefetch(lastFetchAt: number, now: number, throttleMs: number): boolean {
  return now - lastFetchAt >= throttleMs
}

interface UseRefetchOnFocusOptions {
  /** 节流间隔，默认 30s（跟原三份重复代码一致） */
  throttleMs?: number
  /** 传 false 时整个 hook 不生效（如提交中途不想被打断） */
  enabled?: boolean
}

export function useRefetchOnFocus(
  reloadFns: Array<() => void>,
  options: UseRefetchOnFocusOptions = {},
): void {
  const { throttleMs = DEFAULT_THROTTLE_MS, enabled = true } = options
  const lastFetchAtRef = useRef(Date.now())
  const reloadFnsRef = useRef(reloadFns)
  reloadFnsRef.current = reloadFns

  useEffect(() => {
    if (!enabled) return

    function runReload() {
      const now = Date.now()
      if (!shouldRefetch(lastFetchAtRef.current, now, throttleMs)) return
      lastFetchAtRef.current = now
      for (const fn of reloadFnsRef.current) fn()
    }

    function onVisibility() {
      if (document.visibilityState === 'visible') runReload()
    }

    window.addEventListener('focus', runReload)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', runReload)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [throttleMs, enabled])
}
