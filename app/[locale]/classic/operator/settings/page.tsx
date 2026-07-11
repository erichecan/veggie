'use client'
import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import type { ProductCategory } from '@/lib/types'

const PURPLE = '#875A7B'

/** 英文主标题 + 括号中文注释，如 bi('Bulk', '大货') → "Bulk (大货)" */
function bi(en: string, zh: string) {
  return `${en} (${zh})`
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface UomCategory {
  id: string
  name: string
  nameZh?: string
}

type GoodsType = 'BULK' | 'LOOSE' | null

interface Uom {
  id: string
  name: string
  nameZh?: string
  categoryId: string
  factor: number
  rounding: number
  type?: string
  goodsType?: GoodsType
}

// ─── Product Types (fixed enum, read-only reference) ──────────────────────────

const PRODUCT_TYPES = [
  {
    code: 'product',
    labelEn: 'Storable Product',
    labelZh: '库存商品',
    descZh: '有实物库存跟踪，入库出库均影响库存数量。',
    descEn: 'Has real inventory tracking. Stock moves affect on-hand quantity.',
  },
  {
    code: 'consu',
    labelEn: 'Consumable',
    labelZh: '消耗品',
    descZh: '不跟踪库存，可以随时出售，不需要入库操作。',
    descEn: 'No inventory tracking. Can be sold at any time without receipts.',
  },
  {
    code: 'service',
    labelEn: 'Service',
    labelZh: '服务',
    descZh: '无实物，销售服务类项目（如配送费、加工费等）。',
    descEn: 'Non-physical. Used for service items like delivery fees, processing fees.',
  },
]

// ─── Goods Type Inline Editor ─────────────────────────────────────────────────
// 用原生 <select> 直接行内编辑，PUT 后乐观更新；失败时由 onRevert 重载

function GoodsTypeEditor({
  uom,
  onChange,
  onRevert,
}: {
  uom: Uom
  onChange: (next: GoodsType) => void
  onRevert: () => void
}) {
  const [saving, setSaving] = useState(false)
  const current: GoodsType = uom.goodsType ?? null

  const bgClass =
    current === 'BULK'  ? 'bg-red-50    text-red-700    border-red-200' :
    current === 'LOOSE' ? 'bg-orange-50 text-orange-700 border-orange-200' :
                          'bg-gray-50   text-gray-500   border-gray-200'

  const label = current === 'BULK' ? bi('Bulk', '大货') : current === 'LOOSE' ? bi('Loose', '散货') : bi('Uncategorized', '未分类')

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const raw = e.target.value
    const next: GoodsType = raw === 'BULK' ? 'BULK' : raw === 'LOOSE' ? 'LOOSE' : null
    if (next === current) return
    onChange(next)
    setSaving(true)
    try {
      await apiPut(`/api/uoms/${uom.id}`, { goodsType: next })
      toast.success(`${uom.name}: ${next === 'BULK' ? bi('Bulk', '大货') : next === 'LOOSE' ? bi('Loose', '散货') : bi('Uncategorized', '未分类')}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : bi('Save failed', '保存失败'))
      onRevert()
    } finally {
      setSaving(false)
    }
  }

  return (
    <select
      value={current ?? ''}
      onChange={handleChange}
      disabled={saving}
      title={label}
      className={`text-xs rounded px-1.5 py-0.5 border font-medium cursor-pointer focus:outline-none focus:ring-1 focus:ring-purple-400 ${bgClass} ${saving ? 'opacity-60' : ''}`}
    >
      <option value="">{bi('Uncategorized', '未分类')}</option>
      <option value="BULK">{bi('Bulk', '大货')}</option>
      <option value="LOOSE">{bi('Loose', '散货')}</option>
    </select>
  )
}

// ─── UOM Section ──────────────────────────────────────────────────────────────

function UomSection() {
  const [categories, setCategories] = useState<UomCategory[]>([])
  const [allUoms, setAllUoms] = useState<Uom[]>([])
  const [loading, setLoading] = useState(true)

  const [newUomName, setNewUomName] = useState('')
  const [newUomNameZh, setNewUomNameZh] = useState('')
  const [newUomCategoryId, setNewUomCategoryId] = useState('')
  const [newUomFactor, setNewUomFactor] = useState('1')
  const [newUomRounding, setNewUomRounding] = useState('0.01')
  const [newUomGoodsType, setNewUomGoodsType] = useState<GoodsType>(null)
  const [savingUom, setSavingUom] = useState(false)

  const [newCatName, setNewCatName] = useState('')
  const [newCatNameZh, setNewCatNameZh] = useState('')
  const [savingCat, setSavingCat] = useState(false)

  async function load() {
    try {
      const [cats, uoms] = await Promise.all([
        apiGet<UomCategory[]>('/api/uom-categories'),
        apiGet<Uom[]>('/api/uoms'),
      ])
      setCategories(cats)
      setAllUoms(uoms)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : bi('Load failed', '加载失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function createCategory() {
    if (!newCatName.trim()) { toast.error(bi('Please enter a category name', '请输入分类名称')); return }
    setSavingCat(true)
    try {
      await apiPost('/api/uom-categories', { name: newCatName.trim(), nameZh: newCatNameZh.trim() || undefined })
      toast.success(bi('UoM category created', '计量单位分类已创建'))
      setNewCatName(''); setNewCatNameZh('')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : bi('Create failed', '创建失败'))
    } finally {
      setSavingCat(false)
    }
  }

  async function createUom() {
    if (!newUomName.trim()) { toast.error(bi('Please enter a unit name', '请输入单位名称')); return }
    if (!newUomCategoryId) { toast.error(bi('Please select a category', '请选择分类')); return }
    const factor = parseFloat(newUomFactor)
    if (!Number.isFinite(factor) || factor <= 0) { toast.error('Factor must be > 0'); return }
    setSavingUom(true)
    try {
      await apiPost('/api/uoms', {
        name: newUomName.trim(),
        nameZh: newUomNameZh.trim() || undefined,
        categoryId: newUomCategoryId,
        factor,
        rounding: parseFloat(newUomRounding) || 0.01,
        goodsType: newUomGoodsType,
      })
      toast.success(bi('Unit of Measure created', '计量单位已创建'))
      setNewUomName(''); setNewUomNameZh(''); setNewUomFactor('1'); setNewUomRounding('0.01'); setNewUomGoodsType(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : bi('Create failed', '创建失败'))
    } finally {
      setSavingUom(false)
    }
  }

  async function deactivateUom(id: string, name: string) {
    const msg = `${bi('Deactivate', '确认停用')} "${name}"? ${bi('It will no longer appear in dropdowns, but historical data is preserved.', '停用后该单位不再出现在下拉选项中，历史数据保留。')}`
    if (!confirm(msg)) return
    try {
      await apiDelete(`/api/uoms/${id}`)
      toast.success(`${bi('Deactivated', '已停用')}: ${name}`)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : bi('Failed', '操作失败'))
    }
  }

  if (loading) return <div className="text-sm text-gray-400 py-4">{bi('Loading…', '加载中…')}</div>

  return (
    <div className="space-y-6">
      <div>
        {categories.length === 0 ? (
          <p className="text-sm text-gray-400">{bi('No categories yet', '暂无分类')}</p>
        ) : (
          <div className="space-y-4">
            {categories.map(cat => {
              const uoms = allUoms.filter(u => u.categoryId === cat.id)
              return (
                <div key={cat.id} className="border border-gray-200 rounded overflow-hidden">
                  <div className="px-4 py-2 flex items-center gap-2" style={{ background: '#f3eff5' }}>
                    <span className="font-medium text-sm" style={{ color: PURPLE }}>{cat.name}</span>
                    {cat.nameZh && <span className="text-xs text-gray-400">({cat.nameZh})</span>}
                  </div>
                  {uoms.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-gray-400">{bi('No units', '暂无单位')}</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="border-b border-gray-100">
                        <tr className="text-left text-xs text-gray-500">
                          <th className="px-4 py-2 font-medium">{bi('Name', '名称')}</th>
                          <th className="px-4 py-2 font-medium">{bi('Chinese Name', '中文名')}</th>
                          <th className="px-4 py-2 font-medium text-right">Factor</th>
                          <th className="px-4 py-2 font-medium text-right">{bi('Rounding', '精度')}</th>
                          <th className="px-4 py-2 font-medium text-center">{bi('Type', '类型')}</th>
                          <th className="px-4 py-2 font-medium text-center">{bi('Goods', '货物类型')}</th>
                          <th className="px-4 py-2 w-16"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {uoms.map(u => (
                          <tr key={u.id} className="hover:bg-gray-50">
                            <td className="px-4 py-2 font-medium">{u.name}</td>
                            <td className="px-4 py-2 text-gray-500">{u.nameZh || '-'}</td>
                            <td className="px-4 py-2 text-right text-gray-700">{u.factor}</td>
                            <td className="px-4 py-2 text-right text-gray-500">{u.rounding}</td>
                            <td className="px-4 py-2 text-center">
                              <span className={`inline-block px-1.5 py-0.5 text-xs rounded ${
                                u.type === 'REFERENCE' ? 'bg-blue-100 text-blue-700' :
                                u.type === 'BIGGER' ? 'bg-purple-100 text-purple-700' :
                                'bg-gray-100 text-gray-600'
                              }`}>
                                {u.type === 'REFERENCE' ? bi('Ref', '基准') : u.type === 'BIGGER' ? bi('Bigger', '大单位') : bi('Smaller', '小单位')}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-center">
                              <GoodsTypeEditor
                                uom={u}
                                onChange={(next) => {
                                  // 乐观更新本地状态
                                  setAllUoms(prev => prev.map(x => x.id === u.id ? { ...x, goodsType: next } : x))
                                }}
                                onRevert={() => load()}
                              />
                            </td>
                            <td className="px-4 py-2 text-center">
                              <button
                                onClick={() => deactivateUom(u.id, u.name)}
                                className="text-xs text-red-500 hover:text-red-700"
                              >
                                {bi('Deactivate', '停用')}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* New Category */}
      <div className="border border-gray-200 rounded p-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">{bi('New UoM Category', '新建单位分类')}</h3>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-xs text-gray-500 mb-1">{bi('Name (EN)', '分类名（英文）')}</label>
            <input type="text" value={newCatName} onChange={e => setNewCatName(e.target.value)}
              placeholder="e.g. Weight"
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-36 focus:outline-none focus:border-purple-400" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{bi('Name (ZH)', '分类名（中文，可选）')}</label>
            <input type="text" value={newCatNameZh} onChange={e => setNewCatNameZh(e.target.value)}
              placeholder="如 重量"
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-36 focus:outline-none focus:border-purple-400" />
          </div>
          <button onClick={createCategory} disabled={savingCat}
            className="h-9 px-4 text-white text-sm rounded disabled:opacity-40"
            style={{ background: PURPLE }}>
            {savingCat ? bi('Creating…', '创建中…') : bi('Create Category', '创建分类')}
          </button>
        </div>
      </div>

      {/* New UOM */}
      <div className="border border-gray-200 rounded p-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">{bi('New Unit of Measure', '新建计量单位')}</h3>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-xs text-gray-500 mb-1">{bi('Category', '所属分类')}</label>
            <select value={newUomCategoryId} onChange={e => setNewUomCategoryId(e.target.value)}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-36 focus:outline-none focus:border-purple-400">
              <option value="">{bi('Select…', '选择分类')}</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.nameZh ? `${c.name} (${c.nameZh})` : c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{bi('Name (EN)', '单位名（英文）')}</label>
            <input type="text" value={newUomName} onChange={e => setNewUomName(e.target.value)}
              placeholder="e.g. kg"
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-24 focus:outline-none focus:border-purple-400" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{bi('Name (ZH)', '中文名（可选）')}</label>
            <input type="text" value={newUomNameZh} onChange={e => setNewUomNameZh(e.target.value)}
              placeholder="如 千克"
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-24 focus:outline-none focus:border-purple-400" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Factor</label>
            <input type="number" step="any" min="0.0001" value={newUomFactor} onChange={e => setNewUomFactor(e.target.value)}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-20 focus:outline-none focus:border-purple-400" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{bi('Rounding', '精度')}</label>
            <input type="number" step="any" min="0.0001" value={newUomRounding} onChange={e => setNewUomRounding(e.target.value)}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-20 focus:outline-none focus:border-purple-400" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{bi('Goods Type', '货物类型')}</label>
            <select
              value={newUomGoodsType ?? ''}
              onChange={e => {
                const v = e.target.value
                setNewUomGoodsType(v === 'BULK' ? 'BULK' : v === 'LOOSE' ? 'LOOSE' : null)
              }}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm w-32 focus:outline-none focus:border-purple-400 bg-white"
            >
              <option value="">{bi('Uncategorized', '未分类')}</option>
              <option value="BULK">{bi('Bulk', '大货')}</option>
              <option value="LOOSE">{bi('Loose', '散货')}</option>
            </select>
          </div>
          <button onClick={createUom} disabled={savingUom}
            className="h-9 px-4 text-white text-sm rounded disabled:opacity-40"
            style={{ background: PURPLE }}>
            {savingUom ? bi('Creating…', '创建中…') : bi('Create Unit', '创建单位')}
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-2">
          {bi('Factor: within the same category, a larger factor means a bigger unit. The reference unit has factor = 1.', '换算系数：同分类内，系数越大代表越大的单位。基准单位系数为 1。')}
          <br />
          {bi('Goods Type: drives the picking-list grouping (BULK first, then LOOSE).', '货物类型：决定拣货单的分组顺序（先大货，后散货）。')}
        </p>
      </div>
    </div>
  )
}

// ─── Product Category Section ─────────────────────────────────────────────────

function ProductCategorySection({ isEn }: { isEn: boolean }) {
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [newNameZh, setNewNameZh] = useState('')
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editNameZh, setEditNameZh] = useState('')

  async function load() {
    try {
      const cats = await apiGet<ProductCategory[]>('/api/product-categories')
      setCategories(cats)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Load failed' : '加载失败'))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  async function create() {
    if (!newName.trim()) { toast.error(isEn ? 'Please enter a name' : '请输入分类名称'); return }
    setSaving(true)
    try {
      await apiPost('/api/product-categories', { name: newName.trim(), nameZh: newNameZh.trim() || undefined })
      toast.success(isEn ? 'Category created' : '商品分类已创建')
      setNewName(''); setNewNameZh('')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Create failed' : '创建失败'))
    } finally {
      setSaving(false)
    }
  }

  async function saveEdit(id: string) {
    if (!editName.trim()) { toast.error(isEn ? 'Name cannot be empty' : '名称不能为空'); return }
    try {
      await apiPut(`/api/product-categories/${id}`, { name: editName.trim(), nameZh: editNameZh.trim() || undefined })
      toast.success(isEn ? 'Saved' : '已保存')
      setEditingId(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
    }
  }

  async function del(id: string, name: string) {
    if (!confirm(isEn ? `Delete category "${name}"?` : `确认删除商品分类"${name}"？`)) return
    try {
      await apiDelete(`/api/product-categories/${id}`)
      toast.success(isEn ? 'Deleted' : '已删除')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Delete failed' : '删除失败'))
    }
  }

  if (loading) return <div className="text-sm text-gray-400 py-4">{isEn ? 'Loading…' : '加载中…'}</div>

  return (
    <div className="space-y-4">
      <div className="border border-gray-200 rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200" style={{ background: '#f3eff5' }}>
            <tr className="text-left text-xs text-gray-600">
              <th className="px-4 py-2 font-medium">{isEn ? 'English Name' : '英文名'}</th>
              <th className="px-4 py-2 font-medium">{isEn ? 'Chinese Name' : '中文名'}</th>
              <th className="px-4 py-2 w-28"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {categories.length === 0 && (
              <tr><td colSpan={3} className="px-4 py-6 text-center text-gray-400">{isEn ? 'No categories' : '暂无分类'}</td></tr>
            )}
            {categories.map(cat => (
              <tr key={cat.id} className="hover:bg-gray-50">
                {editingId === cat.id ? (
                  <>
                    <td className="px-4 py-2">
                      <input type="text" value={editName} onChange={e => setEditName(e.target.value)}
                        className="border rounded px-2 py-1 text-sm w-full focus:outline-none focus:border-purple-400" autoFocus
                        style={{ borderColor: PURPLE }} />
                    </td>
                    <td className="px-4 py-2">
                      <input type="text" value={editNameZh} onChange={e => setEditNameZh(e.target.value)}
                        className="border rounded px-2 py-1 text-sm w-full focus:outline-none"
                        style={{ borderColor: PURPLE }} />
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex gap-2">
                        <button onClick={() => saveEdit(cat.id)}
                          className="text-xs font-medium hover:underline" style={{ color: PURPLE }}>
                          {isEn ? 'Save' : '保存'}
                        </button>
                        <button onClick={() => setEditingId(null)} className="text-xs text-gray-500 hover:underline">
                          {isEn ? 'Cancel' : '取消'}
                        </button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-4 py-2 font-medium">{cat.name}</td>
                    <td className="px-4 py-2 text-gray-500">{cat.nameZh || '-'}</td>
                    <td className="px-4 py-2">
                      <div className="flex gap-2">
                        <button onClick={() => { setEditingId(cat.id); setEditName(cat.name); setEditNameZh(cat.nameZh ?? '') }}
                          className="text-xs hover:underline" style={{ color: PURPLE }}>
                          {isEn ? 'Edit' : '编辑'}
                        </button>
                        <button onClick={() => del(cat.id, cat.name)} className="text-xs text-red-500 hover:underline">
                          {isEn ? 'Delete' : '删除'}
                        </button>
                      </div>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border border-gray-200 rounded p-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">{isEn ? 'New Product Category' : '新建商品分类'}</h3>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-xs text-gray-500 mb-1">{isEn ? 'Name (EN)' : '英文名'}</label>
            <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
              placeholder={isEn ? 'e.g. Vegetables' : '如 Vegetables'}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-40 focus:outline-none focus:border-purple-400" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{isEn ? 'Name (ZH, optional)' : '中文名（可选）'}</label>
            <input type="text" value={newNameZh} onChange={e => setNewNameZh(e.target.value)}
              placeholder={isEn ? 'e.g. 蔬菜' : '如 蔬菜'}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-40 focus:outline-none focus:border-purple-400" />
          </div>
          <button onClick={create} disabled={saving}
            className="h-9 px-4 text-white text-sm rounded disabled:opacity-40"
            style={{ background: PURPLE }}>
            {saving ? (isEn ? 'Creating…' : '创建中…') : (isEn ? 'Create' : '创建')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Product Type Section ─────────────────────────────────────────────────────

function ProductTypeSection({ isEn }: { isEn: boolean }) {
  return (
    <div className="border border-gray-200 rounded overflow-hidden">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200" style={{ background: '#f3eff5' }}>
          <tr className="text-left text-xs text-gray-600">
            <th className="px-4 py-3 font-medium">Code</th>
            <th className="px-4 py-3 font-medium">{isEn ? 'English' : '英文名'}</th>
            <th className="px-4 py-3 font-medium">{isEn ? 'Chinese' : '中文名'}</th>
            <th className="px-4 py-3 font-medium">{isEn ? 'Description' : '说明'}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {PRODUCT_TYPES.map(t => (
            <tr key={t.code} className="hover:bg-gray-50">
              <td className="px-4 py-3 font-mono text-xs text-gray-500">{t.code}</td>
              <td className="px-4 py-3 font-medium">{t.labelEn}</td>
              <td className="px-4 py-3 text-gray-700">{t.labelZh}</td>
              <td className="px-4 py-3 text-gray-500 text-xs">{isEn ? t.descEn : t.descZh}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 py-2 text-xs text-gray-400 border-t border-gray-100" style={{ background: '#f9f7fa' }}>
        {isEn
          ? 'Product types are fixed system enums and cannot be customized. Assign types on individual product records.'
          : '商品类型为系统固定枚举，不支持自定义。可在商品详情页为每件商品指定类型。'}
      </p>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type Tab = 'uom' | 'product-type' | 'product-category'

export default function ClassicOperatorSettingsPage() {
  const locale = useLocale()
  const isEn = locale !== routing.defaultLocale
  const [activeTab, setActiveTab] = useState<Tab>('uom')

  const TABS: { id: Tab; label: string }[] = [
    { id: 'uom', label: bi('Units of Measure', '计量单位') },
    { id: 'product-type', label: isEn ? 'Product Types' : '商品类型' },
    { id: 'product-category', label: isEn ? 'Product Categories' : '商品分类' },
  ]

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Odoo-style breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-4">
        <span style={{ color: PURPLE }}>{isEn ? 'Settings' : '设置'}</span>
      </div>

      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-2xl font-semibold text-gray-800">{isEn ? 'Settings' : '设置'}</h1>
      </div>

      {/* Tab bar */}
      <div className="flex gap-0 mb-6 border-b border-gray-200">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className="px-5 py-2.5 text-sm font-medium border-b-2 transition-colors"
            style={{
              color: activeTab === tab.id ? PURPLE : '#6b7280',
              borderBottomColor: activeTab === tab.id ? PURPLE : 'transparent',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="bg-white rounded border border-gray-200 p-6">
        {activeTab === 'uom' && (
          <>
            <h2 className="text-base font-semibold mb-1" style={{ color: PURPLE }}>
              {bi('Units of Measure', '计量单位')}
            </h2>
            <p className="text-sm text-gray-500 mb-5">
              {bi('Manage UoM categories and units for products and inventory.', '管理计量单位分类和单位，用于商品规格和库存管理。')}
            </p>
            <UomSection />
          </>
        )}
        {activeTab === 'product-type' && (
          <>
            <h2 className="text-base font-semibold mb-1" style={{ color: PURPLE }}>
              {isEn ? 'Product Types' : '商品类型'}
            </h2>
            <p className="text-sm text-gray-500 mb-5">
              {isEn ? 'Fixed product types matching Odoo\'s storable / consumable / service model.' : '系统支持三种商品类型，对应 Odoo 的商品类型设置。'}
            </p>
            <ProductTypeSection isEn={isEn} />
          </>
        )}
        {activeTab === 'product-category' && (
          <>
            <h2 className="text-base font-semibold mb-1" style={{ color: PURPLE }}>
              {isEn ? 'Product Categories' : '商品分类'}
            </h2>
            <p className="text-sm text-gray-500 mb-5">
              {isEn ? 'Manage product categories used in product classification and pricelist rules.' : '管理商品分类，用于商品归类和价格表规则。'}
            </p>
            <ProductCategorySection isEn={isEn} />
          </>
        )}
      </div>
    </div>
  )
}
