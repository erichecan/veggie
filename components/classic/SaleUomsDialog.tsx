'use client'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { apiGet, apiPut } from '@/lib/api'
import SaleUomsEditor from '@/components/classic/SaleUomsEditor'
import {
  validateSaleUomItems, withBaseUomFallback, mapSaleUomApiRows,
  type SaleUomFormRow, type SaleUomApiRow,
} from '@/lib/sale-uom'

/**
 * 商品列表页的「可售单位」管理弹窗（20260908）——客户要求不打开商品详情页也能直接管理
 * 可售单位，就地复用详情页那套编辑器（components/classic/SaleUomsEditor.tsx）。
 *
 * 跟详情页的可售单位区块的关键区别：这里**不改基准单位**——基准单位（product.uomId）
 * 只在商品详情页的「Unit of Measure」改，这里当作既定事实传进来，不用像详情页
 * saveSaleUoms() 那样在保存前先同步一次 uomId。
 */

interface UomOption {
  id: string
  name: string
  nameZh?: string | null
  categoryId?: string
}

export interface SaleUomsDialogProduct {
  id: string
  name: string
  uomId?: string | null
  listPrice: number
  commissionPrice?: number | null
}

export default function SaleUomsDialog({
  open, product, uoms, isEn, onClose, onSaved,
}: {
  open: boolean
  product: SaleUomsDialogProduct | null
  uoms: readonly UomOption[]
  isEn: boolean
  onClose: () => void
  onSaved: (rows: SaleUomFormRow[]) => void
}) {
  const [saleUoms, setSaleUoms] = useState<SaleUomFormRow[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || !product) return
    setLoading(true)
    apiGet<SaleUomApiRow[]>(`/api/products/${product.id}/sale-uoms`)
      .then(rows => setSaleUoms(withBaseUomFallback(mapSaleUomApiRows(rows), product.uomId)))
      .catch(() => setSaleUoms([]))
      .finally(() => setLoading(false))
  // product 变了(切换到另一行)或重新打开都要重新拉，用 id 而不是整个对象做依赖——
  // 调用方每次渲染传的 product 字面量引用都不同，用对象本身会导致每次渲染都重新请求。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, product?.id])

  async function handleSave() {
    if (!product || saving) return
    const err = validateSaleUomItems(saleUoms)
    if (err) { toast.error(err); return }
    setSaving(true)
    try {
      const payload = saleUoms.map(r => ({ ...r, isDefault: product.uomId ? r.uomId === product.uomId : r.isDefault }))
      const rows = await apiPut<SaleUomApiRow[]>(`/api/products/${product.id}/sale-uoms`, { items: payload })
      const mapped = mapSaleUomApiRows(rows)
      toast.success(isEn ? 'Sellable units saved' : '可售单位已保存')
      onSaved(mapped)
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      {/* sm: 前缀不能少：DialogContent 自带 sm:max-w-sm，不带前缀的类在 sm 断点以上盖不住它。
          可售单位每行要横排单位/系数/定价公式/佣金/规格好几个控件，比默认弹窗宽得多不够放。 */}
      <DialogContent className="flex flex-col max-w-[calc(100vw-2rem)] max-h-[calc(100vh-2rem)] sm:max-w-[min(900px,calc(100vw-3rem))]">
        <DialogHeader className="shrink-0">
          <DialogTitle style={{ color: '#875A7B' }}>
            {isEn ? 'Sellable Units' : '可售单位'}
            {product && <span className="ml-2 text-sm font-normal text-gray-500">{product.name}</span>}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto py-1 pr-1">
          {loading ? (
            <p className="text-sm text-gray-400">{isEn ? 'Loading…' : '加载中…'}</p>
          ) : product ? (
            <SaleUomsEditor
              saleUoms={saleUoms}
              onChange={setSaleUoms}
              uoms={uoms}
              baseUomId={product.uomId}
              baseListPrice={product.listPrice}
              baseCommissionPrice={product.commissionPrice ?? null}
              editMode
              isEn={isEn}
              showCreateHint={false}
            />
          ) : null}
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onClose}>{isEn ? 'Cancel' : '取消'}</Button>
          <Button onClick={handleSave} disabled={saving || loading} style={{ background: '#875A7B' }}>
            {saving ? (isEn ? 'Saving...' : '保存中...') : (isEn ? 'Save' : '保存')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
