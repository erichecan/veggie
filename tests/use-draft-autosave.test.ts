import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  draftStorageKey, isDraftExpired, readDraft, writeDraft, clearDraft, clearDraftsForUser,
  type StorageLike, type EnumerableStorageLike,
} from '../lib/hooks/use-draft-autosave'

/** 内存版 Storage，跟真实 localStorage 结构一样，纯函数测试不需要 jsdom */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: (key) => { map.delete(key) },
  }
}

/** 带 length/key 枚举能力的内存版 Storage，跟真实 localStorage 接口一致 */
function enumerableMemoryStorage(): EnumerableStorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: (key) => { map.delete(key) },
    get length() { return map.size },
    key: (index) => Array.from(map.keys())[index] ?? null,
  }
}

const ONE_DAY = 24 * 60 * 60 * 1000

test('draftStorageKey 按用户/实体/记录三段拼接，不同用户不会撞 key', () => {
  const a = draftStorageKey('user-1', 'order', 'draft-abc')
  const b = draftStorageKey('user-2', 'order', 'draft-abc')
  assert.notEqual(a, b)
  assert.match(a, /^veggie_draft:user-1:order:draft-abc$/)
})

test('isDraftExpired 未超过 maxAge 不算过期', () => {
  assert.equal(isDraftExpired(1000, 1000 + ONE_DAY, 3 * ONE_DAY), false)
})

test('isDraftExpired 超过 maxAge 算过期', () => {
  assert.equal(isDraftExpired(1000, 1000 + 4 * ONE_DAY, 3 * ONE_DAY), true)
})

test('writeDraft 写入后 readDraft 能原样读回', () => {
  const storage = memoryStorage()
  const key = draftStorageKey('user-1', 'order', 'new-1')
  writeDraft(storage, key, { lines: [{ productId: 'p1', qty: 2 }] }, 1000)
  const got = readDraft<{ lines: { productId: string; qty: number }[] }>(storage, key, 1000 + 60_000, 3 * ONE_DAY)
  assert.deepEqual(got, { lines: [{ productId: 'p1', qty: 2 }] })
})

test('readDraft 对过期草稿返回 null 并顺手清掉存储', () => {
  const storage = memoryStorage()
  const key = draftStorageKey('user-1', 'order', 'new-1')
  writeDraft(storage, key, { foo: 'bar' }, 1000)
  const got = readDraft(storage, key, 1000 + 4 * ONE_DAY, 3 * ONE_DAY)
  assert.equal(got, null)
  assert.equal(storage.getItem(key), null)
})

test('readDraft 对不存在的 key 返回 null', () => {
  const storage = memoryStorage()
  const got = readDraft(storage, draftStorageKey('user-1', 'order', 'missing'), 1000, 3 * ONE_DAY)
  assert.equal(got, null)
})

test('readDraft 对损坏的 JSON 返回 null 并清掉存储，不抛异常', () => {
  const storage = memoryStorage()
  const key = draftStorageKey('user-1', 'order', 'broken')
  storage.setItem(key, '{not json')
  const got = readDraft(storage, key, 1000, 3 * ONE_DAY)
  assert.equal(got, null)
  assert.equal(storage.getItem(key), null)
})

test('clearDraft 清掉指定 key，不影响其他草稿', () => {
  const storage = memoryStorage()
  const keyA = draftStorageKey('user-1', 'order', 'a')
  const keyB = draftStorageKey('user-1', 'order', 'b')
  writeDraft(storage, keyA, { v: 1 }, 1000)
  writeDraft(storage, keyB, { v: 2 }, 1000)
  clearDraft(storage, keyA)
  assert.equal(storage.getItem(keyA), null)
  assert.notEqual(storage.getItem(keyB), null)
})

test('clearDraftsForUser 只清这个用户的草稿，不影响其他用户/其他存储项', () => {
  const storage = enumerableMemoryStorage()
  writeDraft(storage, draftStorageKey('user-1', 'order', 'a'), { v: 1 }, 1000)
  writeDraft(storage, draftStorageKey('user-1', 'customer', 'b'), { v: 2 }, 1000)
  writeDraft(storage, draftStorageKey('user-2', 'order', 'a'), { v: 3 }, 1000)
  storage.setItem('veggie_user', '{"userId":"user-1"}')
  clearDraftsForUser(storage, 'user-1')
  assert.equal(storage.getItem(draftStorageKey('user-1', 'order', 'a')), null)
  assert.equal(storage.getItem(draftStorageKey('user-1', 'customer', 'b')), null)
  assert.notEqual(storage.getItem(draftStorageKey('user-2', 'order', 'a')), null)
  assert.notEqual(storage.getItem('veggie_user'), null)
})
