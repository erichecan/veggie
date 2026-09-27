'use client'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut, apiDelete, apiUpload } from '@/lib/api'
import { DatePicker } from '@/components/ui/date-picker'
import { NumericInput } from '@/components/ui/numeric-input'
import ProductSearchInput from '@/components/classic/ProductSearchInput'
import type { Product } from '@/lib/types'

const PURPLE = '#875A7B'

interface Banner {
  id: string
  title: string
  imageUrl: string
  linkUrl: string | null
  productId: string | null
  sequence: number
  active: boolean
  dateStart: string | null
  dateEnd: string | null
}

function emptyForm(): Omit<Banner, 'id'> {
  return { title: '', imageUrl: '', linkUrl: null, productId: null, sequence: 0, active: true, dateStart: null, dateEnd: null }
}

export function BannerManager({ isEn }: { isEn: boolean }) {
  const [banners, setBanners] = useState<Banner[]>([])
  const [loading, setLoading] = useState(true)
  const [products, setProducts] = useState<Product[]>([])
  const [editing, setEditing] = useState<Banner | null>(null)
  const [form, setForm] = useState<Omit<Banner, 'id'>>(emptyForm())
  const [productQuery, setProductQuery] = useState('')
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function reload() {
    setLoading(true)
    apiGet<Banner[]>('/api/banners').then(setBanners).catch(() => toast.error(isEn ? 'Failed to load' : '加载失败')).finally(() => setLoading(false))
  }

  useEffect(() => {
    reload()
    apiGet<Product[]>('/api/products').then((all) => setProducts(all.filter((p) => p.status?.toLowerCase() === 'active'))).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function openCreate() {
    setEditing(null)
    setForm(emptyForm())
    setProductQuery('')
  }

  function openEdit(b: Banner) {
    setEditing(b)
    // API 把 Banner.dateStart/dateEnd（DateTime）序列化成完整 ISO 字符串，
    // 但 DatePicker 的 value 契约固定是 "yyyy-MM-dd"（同 <input type="date">）——
    // 不转换的话编辑已有轮播图时日期框会显示空白，保存时还会把日期悄悄清空。
    setForm({ ...b, dateStart: b.dateStart ? b.dateStart.slice(0, 10) : null, dateEnd: b.dateEnd ? b.dateEnd.slice(0, 10) : null })
    const p = products.find((x) => x.id === b.productId)
    setProductQuery(p?.name ?? '')
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const { url } = await apiUpload<{ url: string }>('/api/upload-image', fd)
      setForm((f) => ({ ...f, imageUrl: url }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Upload failed' : '上传失败'))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleSave() {
    if (!form.title.trim() || !form.imageUrl) {
      toast.error(isEn ? 'Title and image are required' : '标题和图片不能为空')
      return
    }
    setSaving(true)
    try {
      if (editing) {
        await apiPut(`/api/banners/${editing.id}`, form)
      } else {
        await apiPost('/api/banners', form)
      }
      toast.success(isEn ? 'Saved' : '已保存')
      setEditing(null)
      setForm(emptyForm())
      reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Save failed' : '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(b: Banner) {
    if (!confirm(isEn ? `Delete "${b.title}"?` : `确定删除"${b.title}"？`)) return
    try {
      await apiDelete(`/api/banners/${b.id}`)
      toast.success(isEn ? 'Deleted' : '已删除')
      reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Delete failed' : '删除失败'))
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{isEn ? 'Customer Portal Banners' : '客户门户轮播图'}</h1>
        <button onClick={openCreate} className="px-3 py-1.5 rounded-lg text-sm font-medium text-white" style={{ background: PURPLE }}>
          + {isEn ? 'New Banner' : '新建轮播图'}
        </button>
      </div>

      {/* 编辑表单 */}
      <div className="bg-white border rounded-xl p-4 space-y-4">
        <p className="text-sm font-medium text-gray-700">{editing ? (isEn ? 'Edit Banner' : '编辑轮播图') : (isEn ? 'New Banner' : '新建轮播图')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{isEn ? 'Title (internal)' : '标题（内部备注用）'}</label>
            <input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{isEn ? 'Sequence (smaller = first)' : '排序（数字越小越靠前）'}</label>
            <NumericInput min={0} step="any" value={form.sequence} onChange={(e) => setForm((f) => ({ ...f, sequence: e.target.value === '' ? 0 : Number(e.target.value) }))}
              className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]" />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">{isEn ? 'Image' : '图片'}</label>
          <div className="flex items-center gap-3">
            {form.imageUrl && <img src={form.imageUrl} alt="" className="h-16 rounded border object-cover" />}
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleFileChange} disabled={uploading} className="text-sm" />
            {uploading && <span className="text-xs text-gray-400">{isEn ? 'Uploading...' : '上传中...'}</span>}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{isEn ? 'Link to product (optional)' : '点击跳转到商品（可选）'}</label>
            <ProductSearchInput<Product>
              value={productQuery}
              onChange={(v) => { setProductQuery(v); if (!v.trim()) setForm((f) => ({ ...f, productId: null })) }}
              onSelect={(p) => { setProductQuery(p.name); setForm((f) => ({ ...f, productId: p.id, linkUrl: null })) }}
              products={products}
              placeholder={isEn ? 'Search a product…' : '搜索商品…'}
              inputClassName="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]"
              portalDropdown
              maxResults={30}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{isEn ? 'Or link to URL (optional)' : '或跳转到链接（可选）'}</label>
            <input value={form.linkUrl ?? ''} onChange={(e) => setForm((f) => ({ ...f, linkUrl: e.target.value || null, productId: e.target.value ? null : f.productId }))}
              placeholder="https://..."
              className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]" />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{isEn ? 'Start Date (optional)' : '开始日期（可选）'}</label>
            <DatePicker value={form.dateStart ?? ''} onChange={(v) => setForm((f) => ({ ...f, dateStart: v || null }))}
              className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">{isEn ? 'End Date (optional)' : '结束日期（可选）'}</label>
            <DatePicker value={form.dateEnd ?? ''} onChange={(v) => setForm((f) => ({ ...f, dateEnd: v || null }))}
              className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#875A7B]" />
          </div>
          <label className="flex items-center gap-2 text-sm mt-5">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} />
            {isEn ? 'Active' : '启用'}
          </label>
        </div>

        <div className="flex gap-2">
          <button onClick={handleSave} disabled={saving} className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50" style={{ background: PURPLE }}>
            {saving ? (isEn ? 'Saving...' : '保存中...') : (isEn ? 'Save' : '保存')}
          </button>
          {editing && (
            <button onClick={openCreate} className="px-4 py-2 rounded-lg text-sm border">
              {isEn ? 'Cancel edit' : '取消编辑'}
            </button>
          )}
        </div>
      </div>

      {/* 列表 */}
      <div className="bg-white border rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">{isEn ? 'Loading...' : '加载中...'}</div>
        ) : banners.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">{isEn ? 'No banners yet' : '还没有轮播图'}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="px-3 py-2 font-medium">{isEn ? 'Image' : '图片'}</th>
                <th className="px-3 py-2 font-medium">{isEn ? 'Title' : '标题'}</th>
                <th className="px-3 py-2 font-medium">{isEn ? 'Sequence' : '排序'}</th>
                <th className="px-3 py-2 font-medium">{isEn ? 'Dates' : '起止日期'}</th>
                <th className="px-3 py-2 font-medium">{isEn ? 'Active' : '启用'}</th>
                <th className="px-3 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {banners.map((b) => (
                <tr key={b.id} className="border-b last:border-0">
                  <td className="px-3 py-2"><img src={b.imageUrl} alt="" className="h-10 w-16 object-cover rounded border" /></td>
                  <td className="px-3 py-2">{b.title}</td>
                  <td className="px-3 py-2">{b.sequence}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{b.dateStart ?? '—'} ~ {b.dateEnd ?? '—'}</td>
                  <td className="px-3 py-2">{b.active ? '✓' : '—'}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button onClick={() => openEdit(b)} className="text-xs text-gray-500 hover:text-gray-800 mr-3">{isEn ? 'Edit' : '编辑'}</button>
                    <button onClick={() => handleDelete(b)} className="text-xs text-red-500 hover:text-red-700">{isEn ? 'Delete' : '删除'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
