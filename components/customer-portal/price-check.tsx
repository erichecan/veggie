'use client'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur } from '@/lib/format-money'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { toPercent, type CartItem } from './cart-utils'

const PURPLE = '#875A7B'

export interface PriceCheckSourceLine {
  productId: string
  name: string
  spec: string | null
  uomName: string | null
  quantity: number
  /** 参考价——历史成交价（再来一单）或收藏时的快照价（应用清单），只用来提示"变没变"，不会被采纳入库 */
  referencePrice: number
}

interface DiffRow extends PriceCheckSourceLine {
  newPrice: number | null
  taxRate: number
  available: boolean
  changed: boolean
  checked: boolean
}

interface ProductCard {
  id: string
  spec: string | null
  uomName: string | null
  customerPrice: number | null
  customerTaxRate: number
  status: string
}

/**
 * "再来一单" / "应用收藏清单" 共用的核价流程：
 * 拿一批商品的历史/快照价，跟服务端当前权威价核对一遍，价格变了或商品下架都要
 * 明确亮出来让客户自己勾选，不能悄悄按旧价把东西塞进购物车。
 */
export function usePriceCheck(isEn: boolean) {
  const [title, setTitle] = useState<string | null>(null)
  const [rows, setRows] = useState<DiffRow[]>([])
  const [checking, setChecking] = useState(false)
  const onConfirmRef = useRef<(items: CartItem[]) => void>(() => {})

  async function open(dialogTitle: string, lines: PriceCheckSourceLine[], onConfirm: (items: CartItem[]) => void) {
    if (lines.length === 0) return
    setChecking(true)
    try {
      const ids = [...new Set(lines.map((l) => l.productId))].join(',')
      const data = await apiGet<{ products: ProductCard[] }>(`/api/customer-portal/products?ids=${ids}`)
      const byId = new Map(data.products.map((p) => [p.id, p]))
      const nextRows: DiffRow[] = lines.map((l) => {
        const card = byId.get(l.productId)
        const available = !!card && card.status === 'ACTIVE' && card.customerPrice != null
        const newPrice = card?.customerPrice ?? null
        const changed = available && newPrice != null && Math.abs(newPrice - l.referencePrice) > 0.01
        return {
          ...l,
          spec: card?.spec ?? l.spec,
          uomName: card?.uomName ?? l.uomName,
          newPrice,
          taxRate: toPercent(card?.customerTaxRate) ?? 0,
          available,
          changed,
          checked: available,
        }
      })
      onConfirmRef.current = onConfirm
      setRows(nextRows)
      setTitle(dialogTitle)
    } catch {
      toast.error(isEn ? 'Failed to check current prices' : '核对现价失败')
    } finally {
      setChecking(false)
    }
  }

  function toggle(productId: string) {
    setRows((rs) => rs.map((r) => (r.productId === productId ? { ...r, checked: !r.checked } : r)))
  }

  function close() {
    setTitle(null)
    setRows([])
  }

  function handleConfirmClick() {
    const items: CartItem[] = rows
      .filter((r) => r.checked && r.available && r.newPrice != null)
      .map((r) => ({ productId: r.productId, name: r.name, spec: r.spec, uomName: r.uomName, price: r.newPrice as number, quantity: r.quantity, taxRate: r.taxRate }))
    if (items.length === 0) {
      toast.error(isEn ? 'No items selected' : '没有选中可加入的商品')
      return
    }
    onConfirmRef.current(items)
    toast.success(isEn ? `Added ${items.length} items to cart` : `已把 ${items.length} 项加入购物车`)
    close()
  }

  const dialog = (
    <Dialog open={!!title} onOpenChange={(o) => { if (!o) close() }}>
      <DialogContent className="max-w-md max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto space-y-2 -mx-1 px-1">
          {rows.map((r) => (
            <label
              key={r.productId}
              className={`flex items-center gap-2 py-2 px-2 rounded-lg border text-sm ${r.available ? 'cursor-pointer' : 'opacity-50'}`}
              style={{ borderColor: r.changed ? '#f59e0b' : '#eee' }}
            >
              <input type="checkbox" checked={r.checked} disabled={!r.available} onChange={() => toggle(r.productId)} className="flex-none" />
              <div className="min-w-0 flex-1">
                <p className="truncate">{r.name} × {r.quantity}{r.uomName ? ` ${r.uomName}` : ''}</p>
                {!r.available && (
                  <p className="text-xs text-red-500">{isEn ? 'No longer available — will not be added' : '已下架/暂无报价，不会加入'}</p>
                )}
                {r.available && r.changed && (
                  <p className="text-xs text-amber-600">
                    {isEn ? `Price changed: ${eur(r.referencePrice)} → ${eur(r.newPrice as number)}` : `价格有变：${eur(r.referencePrice)} → ${eur(r.newPrice as number)}`}
                  </p>
                )}
              </div>
            </label>
          ))}
        </div>
        <DialogFooter>
          <button onClick={close} className="px-4 py-2 rounded-lg text-sm border">
            {isEn ? 'Cancel' : '取消'}
          </button>
          <button onClick={handleConfirmClick} className="px-4 py-2 rounded-lg text-sm text-white font-medium" style={{ background: PURPLE }}>
            {isEn ? 'Add selected to cart' : '确认加入购物车'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return { open, checking, dialog }
}
