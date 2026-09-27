'use client'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { usePriceCheck } from './price-check'
import type { CartItem } from './cart-utils'

const PURPLE = '#875A7B'
const FAVORITES_KEY = 'veggie_favorite_lists'

interface FavoriteList {
  id: string
  name: string
  items: CartItem[]
  createdAt: string
}

function loadFavorites(): FavoriteList[] {
  if (typeof window === 'undefined') return []
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]')
  } catch {
    return []
  }
}

function saveFavorites(lists: FavoriteList[]) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(lists))
}

/**
 * 收藏夹/标准清单——v1 存在浏览器本地（跟购物车同一套存法），换设备不同步。
 * 跟"最近5单"互补：最近5单是系统自动记的历史，这里是客户自己攒的模板（比如"每周标准单"），
 * 不用每次去翻订单历史猜哪一单是常规单。
 */
export function FavoritesPanel({ cart, onApply, isEn }: { cart: CartItem[]; onApply: (items: CartItem[]) => void; isEn: boolean }) {
  const [lists, setLists] = useState<FavoriteList[]>([])
  const [naming, setNaming] = useState(false)
  const [newName, setNewName] = useState('')
  const { open, dialog } = usePriceCheck(isEn)

  useEffect(() => { setLists(loadFavorites()) }, [])

  function saveCurrentCart() {
    if (cart.length === 0) {
      toast.error(isEn ? 'Cart is empty' : '购物车为空，没有可保存的商品')
      return
    }
    if (!newName.trim()) {
      toast.error(isEn ? 'Please name this list' : '请给清单起个名字')
      return
    }
    const list: FavoriteList = { id: `fav_${Date.now()}`, name: newName.trim().slice(0, 30), items: cart, createdAt: new Date().toISOString() }
    const next = [list, ...lists]
    setLists(next)
    saveFavorites(next)
    setNewName('')
    setNaming(false)
    toast.success(isEn ? 'Saved' : '已保存')
  }

  function remove(id: string) {
    const next = lists.filter((l) => l.id !== id)
    setLists(next)
    saveFavorites(next)
  }

  function apply(list: FavoriteList) {
    open(
      isEn ? `Add "${list.name}" to cart` : `加入清单「${list.name}」`,
      list.items.map((i) => ({ productId: i.productId, name: i.name, spec: i.spec, uomName: i.uomName, quantity: i.quantity, referencePrice: i.price })),
      onApply,
    )
  }

  return (
    <div className="space-y-3">
      {naming ? (
        <div className="flex items-center gap-2 bg-white rounded-xl border p-3">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value.slice(0, 30))}
            placeholder={isEn ? 'List name (e.g. Weekly standard)' : '清单名称（如：每周标准单）'}
            className="flex-1 border rounded-lg px-3 py-1.5 text-sm"
            autoFocus
          />
          <button onClick={saveCurrentCart} className="px-3 py-1.5 rounded-lg text-xs font-medium text-white" style={{ background: PURPLE }}>
            {isEn ? 'Save' : '保存'}
          </button>
          <button onClick={() => { setNaming(false); setNewName('') }} className="px-2 py-1.5 text-xs text-gray-400">
            {isEn ? 'Cancel' : '取消'}
          </button>
        </div>
      ) : (
        <button
          onClick={() => setNaming(true)}
          className="w-full border-2 border-dashed rounded-xl py-2.5 text-sm text-gray-500 hover:border-gray-400 hover:text-gray-700"
          style={{ borderColor: '#ddd' }}
        >
          {isEn ? '+ Save current cart as a list' : '+ 把当前购物车存为清单'}
        </button>
      )}

      {lists.length === 0 ? (
        <p className="text-sm text-gray-400 py-6 text-center">{isEn ? 'No saved lists yet' : '还没有收藏的清单'}</p>
      ) : (
        <div className="space-y-2">
          {lists.map((l) => (
            <div key={l.id} className="bg-white rounded-xl border p-3 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{l.name}</p>
                <p className="text-xs text-gray-400 truncate mt-0.5">
                  {l.items.slice(0, 3).map((i) => i.name).join(isEn ? ', ' : '、')}
                  {l.items.length > 3 && (isEn ? ` +${l.items.length - 3} more` : ` 等${l.items.length}项`)}
                </p>
              </div>
              <div className="flex-none flex items-center gap-1.5">
                <button onClick={() => apply(l)} className="px-3 py-1.5 rounded-lg text-xs font-medium text-white" style={{ background: PURPLE }}>
                  {isEn ? 'Add to cart' : '一键下单'}
                </button>
                <button onClick={() => remove(l.id)} className="text-red-400 hover:text-red-600 text-xs px-1.5">✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {dialog}
    </div>
  )
}
