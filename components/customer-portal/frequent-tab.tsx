'use client'
import { eur } from '@/lib/format-money'
import type { FrequentCard } from './product-types'

const PURPLE = '#875A7B'

/** 常购单品——按历史下单次数排序的单品快捷复购，跟"最近订单"（整单维度）互补 */
export function FrequentTab({ frequent, onReorder, isEn }: { frequent: FrequentCard[]; onReorder: (p: FrequentCard, qty: number) => void; isEn: boolean }) {
  // 一键复购是直接加购物车、不经过"再来一单"那套核价确认弹窗，所以这里先把下架/无报价的
  // 商品过滤掉——不然常购清单里躺着一个早就下架的商品，点一下就绕过核价直接混进购物车
  const available = frequent.filter((p) => p.customerPrice != null && (p.status ?? 'ACTIVE') === 'ACTIVE')

  if (available.length === 0) {
    return <p className="text-sm text-gray-400 py-6 text-center">{isEn ? 'No frequently ordered items yet' : '还没有常购记录'}</p>
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1">
      {available.map((p) => (
        <div key={p.id} className="flex-none w-40 bg-white rounded-xl border p-3 flex flex-col justify-between">
          <div>
            <h3 className="font-medium text-sm truncate">{p.name}</h3>
            <p className="text-xs text-gray-400 mt-0.5 truncate">
              {isEn ? `Last time: ${p.lastQuantity} ${p.uomName || 'unit'}` : `上次 ${p.lastQuantity} ${p.uomName || '个'}`}
            </p>
          </div>
          <div className="flex items-center justify-between mt-2">
            <span className="text-sm font-bold" style={{ color: PURPLE }}>{eur(p.customerPrice ?? 0)}</span>
            <button onClick={() => onReorder(p, p.lastQuantity)}
              className="px-2.5 py-1 rounded-lg text-xs font-medium text-white transition-colors"
              style={{ background: PURPLE }}>
              {isEn ? 'Reorder' : '一键复购'}
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
