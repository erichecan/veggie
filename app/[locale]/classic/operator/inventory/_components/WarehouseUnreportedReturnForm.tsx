'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost } from '@/lib/api'

export default function WarehouseUnreportedReturnForm({ isEn, onSaved }: { isEn: boolean; onSaved: () => void }) {
  const [busy, setBusy] = useState(false)
  const [photo, setPhoto] = useState<string | null>(null)
  const [form, setForm] = useState({ vehiclePlate: '', driverName: '', customerName: '', productName: '', spec: '', uomLabel: '', quantity: '', reason: '' })

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
      <div className="mb-2">
        <h3 className="text-sm font-semibold text-amber-900">{isEn ? 'Warehouse entry — unreported returned goods' : '仓库手动登记司机漏报货物'}</h3>
        <p className="mt-1 text-xs text-amber-800">{isEn ? 'Record the vehicle and goods. Sales will identify the restaurant and original order in the Returns tab.' : '先记录车牌和实物；销售会在“退换货”Tab 补充餐馆及原订单。登记时间由系统自动记录。'}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {field('vehiclePlate', isEn ? 'Vehicle plate' : '车牌号', true)}
        {field('driverName', isEn ? 'Driver (if known)' : '司机（知道时填写）')}
        {field('customerName', isEn ? 'Restaurant hint (optional)' : '餐馆线索（选填）')}
        {field('productName', isEn ? 'Goods received' : '实际收到商品', true)}
        {field('spec', isEn ? 'Specification' : '规格', true)}
        {field('uomLabel', isEn ? 'Unit' : '单位', true)}
        {field('quantity', isEn ? 'Quantity received' : '实收数量', true, 'number')}
        {field('reason', isEn ? 'Reason / notes' : '原因或现场说明')}
        <label className="block text-xs text-gray-600">{isEn ? 'Photo (optional)' : '现场照片（选填）'}<input type="file" accept="image/*" capture="environment" onChange={event => void attachPhoto(event.target.files?.[0])} className="mt-1 block w-full text-xs" />{photo && <span className="text-green-700">{isEn ? 'Photo attached' : '已附照片'}</span>}</label>
      </div>
      <button type="button" disabled={busy} onClick={() => void submit()} className="mt-3 rounded bg-[#875A7B] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? (isEn ? 'Saving…' : '登记中…') : (isEn ? 'Save warehouse intake' : '登记并交销售匹配')}</button>
    </section>
  )
}
