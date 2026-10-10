'use client'
/**
 * useDraftAutosave - 正在填的表单内容防抖写 localStorage，按用户隔离，过期自动清
 * -----------------------------------------------------------------------
 * 读写/过期判定全部写成纯函数（参数里的 storage 可以是真 localStorage，也可以是
 * 单测里的内存 mock），React hook 只是在上面加一层 useEffect 防抖 + 挂载时读取。
 *
 * 用法：
 *   const draft = useDraftAutosave({ userId, entity: 'order', recordKey: orderId, data: formState })
 *   // 挂载时若发现旧草稿：draft.pendingDraft 非 null → 渲染 DraftRestoreBanner
 *   // 用户点恢复：const restored = draft.restore(); 把 restored 灌回表单状态
 *   // 用户点丢弃：draft.discard()
 *   // 保存成功后：draft.clearDraft()
 */
import { useEffect, useRef, useState } from 'react'

export const DRAFT_KEY_PREFIX = 'veggie_draft'
const DEFAULT_DEBOUNCE_MS = 2_000
const DEFAULT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000 // 3 天，经验值，无 PRD 依据

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface StoredDraft<T> {
  savedAt: number
  data: T
}

/** key 按用户 id 隔离，避免同一浏览器换账号登录看到别人的草稿 */
export function draftStorageKey(userId: string, entity: string, recordKey: string): string {
  return `${DRAFT_KEY_PREFIX}:${userId}:${entity}:${recordKey}`
}

export function isDraftExpired(savedAt: number, now: number, maxAgeMs: number): boolean {
  return now - savedAt > maxAgeMs
}

/** 读到期的草稿时顺手清掉，不留垂死数据占位 */
export function readDraft<T>(
  storage: StorageLike,
  key: string,
  now: number,
  maxAgeMs: number,
): T | null {
  const raw = storage.getItem(key)
  if (!raw) return null
  let parsed: StoredDraft<T>
  try {
    parsed = JSON.parse(raw) as StoredDraft<T>
  } catch {
    storage.removeItem(key)
    return null
  }
  if (isDraftExpired(parsed.savedAt, now, maxAgeMs)) {
    storage.removeItem(key)
    return null
  }
  return parsed.data
}

export function writeDraft<T>(storage: StorageLike, key: string, data: T, now: number): void {
  const payload: StoredDraft<T> = { savedAt: now, data }
  storage.setItem(key, JSON.stringify(payload))
}

export function clearDraft(storage: StorageLike, key: string): void {
  storage.removeItem(key)
}

export interface EnumerableStorageLike extends StorageLike {
  readonly length: number
  key(index: number): string | null
}

/** 退出登录时调用：扫掉这个用户名下所有未保存草稿，不留到下次换人登录同一浏览器后仍可在 devtools 里读到 */
export function clearDraftsForUser(storage: EnumerableStorageLike, userId: string): void {
  const prefix = `${DRAFT_KEY_PREFIX}:${userId}:`
  const keysToRemove: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i)
    if (k && k.startsWith(prefix)) keysToRemove.push(k)
  }
  keysToRemove.forEach(k => storage.removeItem(k))
}

interface UseDraftAutosaveOptions<T> {
  /** 没登录用户 id 时不启用（无法安全隔离，整个 hook 直接跳过） */
  userId: string | null | undefined
  entity: string
  recordKey: string
  data: T
  enabled?: boolean
  debounceMs?: number
  maxAgeMs?: number
}

interface UseDraftAutosaveResult<T> {
  /** 进页面时发现的旧草稿，非 null 时应该渲染 DraftRestoreBanner 让用户选 */
  pendingDraft: T | null
  /** 用户点"恢复"：返回草稿内容并关闭提示条 */
  restore: () => T | null
  /** 用户点"丢弃"：清掉草稿并关闭提示条 */
  discard: () => void
  /** 保存成功后调用：清掉对应草稿，避免下次进页面又弹恢复提示 */
  clearDraft: () => void
}

export function useDraftAutosave<T>(options: UseDraftAutosaveOptions<T>): UseDraftAutosaveResult<T> {
  const {
    userId,
    entity,
    recordKey,
    data,
    enabled = true,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
  } = options

  const key = userId && enabled ? draftStorageKey(userId, entity, recordKey) : null
  const [pendingDraft, setPendingDraft] = useState<T | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 定时器实际触发时才读这个值判断——不放进下面 effect 的依赖数组，否则用户在
  // restore/discard 之前的每次按键都会被当成"已有决定"重新判断一次，意义不大
  const pendingDraftRef = useRef<T | null>(null)
  useEffect(() => { pendingDraftRef.current = pendingDraft }, [pendingDraft])

  // 挂载时（或 key 变化，如新建页第一次拿到草稿 id）读一次旧草稿
  useEffect(() => {
    if (!key || typeof window === 'undefined') {
      setPendingDraft(null)
      return
    }
    const found = readDraft<T>(window.localStorage, key, Date.now(), maxAgeMs)
    setPendingDraft(found)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // 防抖写入当前内容
  useEffect(() => {
    if (!key || typeof window === 'undefined') return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      // 旧草稿的恢复/丢弃提示条还没被用户处理时，不能用当前内容(可能是刚挂载、
      // 还没来得及恢复的空白表单)覆盖它——否则提示条显示的那份"可恢复"的草稿,
      // 会在用户点"恢复"之前就被这个防抖写入悄悄冲掉
      if (pendingDraftRef.current !== null) return
      writeDraft(window.localStorage, key, data, Date.now())
    }, debounceMs)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, data, debounceMs])

  function restore(): T | null {
    const value = pendingDraft
    setPendingDraft(null)
    return value
  }

  function discard(): void {
    if (key && typeof window !== 'undefined') clearDraft(window.localStorage, key)
    setPendingDraft(null)
  }

  function clearDraftNow(): void {
    if (key && typeof window !== 'undefined') clearDraft(window.localStorage, key)
  }

  return { pendingDraft, restore, discard, clearDraft: clearDraftNow }
}
