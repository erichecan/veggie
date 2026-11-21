'use client'

import { useState } from 'react'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost } from '@/lib/api'
import ProductSearchInput from '@/components/classic/ProductSearchInput'

interface ProductOption {
  id: string
  name: string
  internalRef?: string | null
  category?: string | null
  spec?: string | null
  purchaseUomSpec?: string | null
  uomName?: string | null
}

export default function WarehouseUnreportedReturnForm({ isEn, onSaved, vehiclePlates }: { isEn: boolean; onSaved: () => void; vehiclePlates: string[] }) {
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [photo, setPhoto] = useState<string | null>(null)
  const [products, setProducts] = useState<ProductOption[]>([])
  const [form, setForm] = useState({ vehiclePlate: '', driverName: '', customerName: '', productName: '', spec: '', uomLabel: '', quantity: '', reason: '' })

  useEffect(() => {
    if (!open || products.length) return
    apiGet<ProductOption[]>('/api/products?status=ACTIVE&sellable=1&slim=1')
      .then(rows => setProducts(Array.isArray(rows) ? rows : []))
      .catch(error => toast.error(error instanceof Error ? error.message : (isEn ? 'Could not load products' : '加载商品失败')))
  }, [open, products.length, isEn])

  async function submit() {
    if (!form.vehiclePlate.trim() || !form.productName.trim() || !form.spec.trim() || !form.uomLabel.trim() || !(Number(form.quantity) > 0)) {
      toast.error(isEn ? 'Enter the plate, item, specification, unit and a quantity above zero' : '请填写车牌、商品、规格、单位和大于 0 的数量')
      return
    }
    setBusy(true)
    try {
      await apiPost('/api/order-returns/intakes', { ...form, quantity: Number(form.quantity), photo })
      toast.success(isEn ? 'Unreported goods recorded for Sales matching' : '漏报货物已登记，等待销售匹配餐馆/订单')
      setForm({ vehiclePlate: '', driverName: '', customerName: '', productName: '', spec: '', uomLabel: '', quantity: '', reason: '' })
      setPhoto(null)
      setOpen(false)
      onSaved()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : (isEn ? 'Could not save the intake' : '登记失败'))
    } finally {
      setBusy(false)
    }
  }

  async function attachPhoto(file?: File) {
    if (!file) { setPhoto(null); return }
    if (!file.type.startsWith('image/')) { toast.error(isEn ? 'Choose an image' : '请选择图片'); return }
    if (file.size > 5 * 1024 * 1024) { toast.error(isEn ? 'Image must be under 5 MB' : '图片不能超过 5 MB'); return }
    const reader = new FileReader()
    reader.onload = () => setPhoto(typeof reader.result === 'string' ? reader.result : null)
    reader.onerror = () => toast.error(isEn ? 'Could not read the image' : '读取图片失败')
    reader.readAsDataURL(file)
  }

  const field = (key: keyof typeof form, label: string, required = false, type = 'text') => (
    <label className="block text-xs text-gray-600">{label}{required && <span className="text-red-500"> *</span>}
      <input type={type} min={type === 'number' ? '0.001' : undefined} step={type === 'number' ? '0.001' : undefined} value={form[key]} onChange={event => setForm(current => ({ ...current, [key]: event.target.value }))} className="mt-1 w-full rounded border px-2.5 py-2 text-sm" />
    </label>
  )

  return (
    <section className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-amber-900">{isEn ? 'Unreported goods on a vehicle' : '车辆漏报货物登记'}</h3>
          <p className="mt-1 text-xs text-amber-800">{isEn ? 'Record the plate and goods. Sales will identify the restaurant and original order in Returns.' : '仓库先记录车牌和实物；销售在“退换货”Tab 补充餐馆及原订单。系统自动记录登记时间。'}</p>
        </div>
        <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="rounded bg-[#875A7B] px-4 py-2 text-sm font-semibold text-white hover:bg-[#714B67]">
          {open ? (isEn ? 'Close entry' : '收起登记') : (isEn ? '+ Manual entry' : '+ 手动登记')}
        </button>
      </div>
      {open && <>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block text-xs text-gray-600">{isEn ? 'Vehicle plate' : '车牌号'}<span className="text-red-500"> *</span>
          <ProductSearchInput
            value={form.vehiclePlate}
            onChange={value => setForm(current => ({ ...current, vehiclePlate: value }))}
            onSelect={vehicle => setForm(current => ({ ...current, vehiclePlate: vehicle.name }))}
            products={vehiclePlates.map(plate => ({ id: plate, name: plate }))}
            placeholder={isEn ? 'Search plate or enter manually…' : '输入车牌号搜索，也可手动输入…'}
            inputClassName="mt-1 w-full rounded border px-2.5 py-2 text-sm"
            portalDropdown
          />
        </label>
        {field('driverName', isEn ? 'Driver (if known)' : '司机（知道时填写）')}
        {field('customerName', isEn ? 'Restaurant hint (optional)' : '餐馆线索（选填）')}
        <label className="block text-xs text-gray-600">{isEn ? 'Goods received' : '实际收到商品'}<span className="text-red-500"> *</span>
          <ProductSearchInput
            value={form.productName}
            onChange={value => setForm(current => ({ ...current, productName: value, spec: '', uomLabel: '' }))}
            onSelect={product => setForm(current => ({ ...current, productName: product.name, spec: product.purchaseUomSpec ?? product.spec ?? '', uomLabel: product.uomName ?? '' }))}
            products={products}
            placeholder={isEn ? 'Search products…' : '输入商品名称搜索并选择…'}
            inputClassName="mt-1 w-full rounded border px-2.5 py-2 text-sm"
            portalDropdown
          />
        </label>
        {field('spec', isEn ? 'Specification' : '规格', true)}
        {field('uomLabel', isEn ? 'Unit' : '单位', true)}
        {field('quantity', isEn ? 'Quantity received' : '实收数量', true, 'number')}
        {field('reason', isEn ? 'Reason / notes' : '原因或现场说明')}
        <label className="block text-xs text-gray-600">{isEn ? 'Photo (optional)' : '现场照片（选填）'}<input type="file" accept="image/*" capture="environment" onChange={event => void attachPhoto(event.target.files?.[0])} className="mt-1 block w-full text-xs" />{photo && <span className="text-green-700">{isEn ? 'Photo attached' : '已附照片'}</span>}</label>
      </div>
      <button type="button" disabled={busy} onClick={() => void submit()} className="mt-3 rounded bg-[#875A7B] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? (isEn ? 'Saving…' : '登记中…') : (isEn ? 'Save warehouse intake' : '登记并交销售匹配')}</button>
      </>}
    </section>
  )
}
