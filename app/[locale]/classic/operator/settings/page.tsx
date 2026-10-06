'use client'
import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import type { ProductCategory } from '@/lib/types'
import BulkImportDialog from '@/components/shared/BulkImportDialog'
import { useCsvExport } from '@/hooks/use-csv-export'
import { UOM_EXPORT_COLUMNS } from '@/lib/export/columns/uoms'
import { PRODUCT_CATEGORY_EXPORT_COLUMNS } from '@/lib/export/columns/product-categories'
import { buildCategoryTree, validateCategoryMove, type CategoryTreeNode } from '@/lib/product-category-tree'

const PURPLE = '#875A7B'

// ─── Types ─────────────────────────────────────────────────────────────────────

interface UomCategory {
  id: string
  name: string
  nameZh?: string
}

type GoodsType = 'BULK' | 'LOOSE'

interface Uom {
  id: string
  name: string
  nameZh?: string
  categoryId: string
  goodsType?: GoodsType | null
  /** 拣货单是否按客户展开明细，与 goodsType 是两个独立维度 */
  expandByCustomer?: boolean
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
  isEn,
  onChange,
  onRevert,
}: {
  uom: Uom
  isEn: boolean
  onChange: (next: GoodsType) => void
  onRevert: () => void
}) {
  const [saving, setSaving] = useState(false)
  // 历史遗留数据仍可能是 null（未分类已下线，不再可选）；display 兜底为 BULK，但不会自动写回
  const current: GoodsType = uom.goodsType ?? 'BULK'

  const bgClass =
    current === 'BULK' ? 'bg-red-50    text-red-700    border-red-200' :
                          'bg-orange-50 text-orange-700 border-orange-200'

  const label = current === 'BULK' ? (isEn ? 'Bulk' : '大货') : (isEn ? 'Loose' : '散货')

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next: GoodsType = e.target.value === 'LOOSE' ? 'LOOSE' : 'BULK'
    if (next === current) return
    onChange(next)
    setSaving(true)
    try {
      await apiPut(`/api/uoms/${uom.id}`, { goodsType: next })
      toast.success(`${uom.name}: ${next === 'BULK' ? (isEn ? 'Bulk' : '大货') : (isEn ? 'Loose' : '散货')}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Save failed' : '保存失败'))
      onRevert()
    } finally {
      setSaving(false)
    }
  }

  return (
    <select
      value={current}
      onChange={handleChange}
      disabled={saving}
      title={label}
      className={`text-xs rounded px-1.5 py-0.5 border font-medium cursor-pointer focus:outline-none focus:ring-1 focus:ring-purple-400 ${bgClass} ${saving ? 'opacity-60' : ''}`}
    >
      <option value="BULK">{isEn ? 'Bulk' : '大货'}</option>
      <option value="LOOSE">{isEn ? 'Loose' : '散货'}</option>
    </select>
  )
}

// ─── Expand-by-customer Inline Editor ─────────────────────────────────────────
// 与货物类型同样的行内即改即存；失败时由 onRevert 重载

function ExpandEditor({
  uom,
  isEn,
  onChange,
  onRevert,
}: {
  uom: Uom
  isEn: boolean
  onChange: (next: boolean) => void
  onRevert: () => void
}) {
  const [saving, setSaving] = useState(false)
  const current = uom.expandByCustomer === true

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value === 'YES'
    if (next === current) return
    onChange(next)
    setSaving(true)
    try {
      await apiPut(`/api/uoms/${uom.id}`, { expandByCustomer: next })
      toast.success(`${uom.name}: ${next ? (isEn ? 'Expand by customer' : '按客户展开') : (isEn ? 'Total only' : '只显示总量')}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : (isEn ? 'Save failed' : '保存失败'))
      onRevert()
    } finally {
      setSaving(false)
    }
  }

  return (
    <select
      value={current ? 'YES' : 'NO'}
      onChange={handleChange}
      disabled={saving}
      className={`text-xs rounded px-1.5 py-0.5 border font-medium cursor-pointer focus:outline-none focus:ring-1 focus:ring-purple-400 ${
        current ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-gray-50 text-gray-500 border-gray-200'
      } ${saving ? 'opacity-60' : ''}`}
    >
      <option value="NO">{isEn ? 'Total only' : '只显示总量'}</option>
      <option value="YES">{isEn ? 'By customer' : '按客户展开'}</option>
    </select>
  )
}

// ─── Uom Name Inline Editor ────────────────────────────────────────────────────
// 名称/中文名行内可编辑，失焦时才保存；name 不允许清空，nameZh 允许清空为 null

function NameEditor({
  value,
  required,
  isEn,
  onSave,
}: {
  value: string
  required: boolean
  isEn: boolean
  onSave: (next: string) => Promise<void>
}) {
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setDraft(value) }, [value])

  async function commit() {
    const next = draft.trim()
    if (next === value.trim()) return
    if (required && !next) {
      toast.error(isEn ? 'Name cannot be empty' : '名称不能为空')
      setDraft(value)
      return
    }
    setSaving(true)
    try {
      await onSave(next)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
      setDraft(value)
    } finally {
      setSaving(false)
    }
  }

  return (
    <input
      type="text"
      value={draft}
      disabled={saving}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      placeholder={required ? undefined : (isEn ? '-' : '-')}
      className={`w-full bg-transparent border border-transparent hover:border-gray-300 focus:border-purple-400 rounded px-1.5 py-0.5 focus:outline-none ${saving ? 'opacity-60' : ''}`}
    />
  )
}

// ─── UOM Section ──────────────────────────────────────────────────────────────

function UomSection({ isEn }: { isEn: boolean }) {
  const [categories, setCategories] = useState<UomCategory[]>([])
  const [allUoms, setAllUoms] = useState<Uom[]>([])
  const [loading, setLoading] = useState(true)

  const [newUomName, setNewUomName] = useState('')
  const [newUomNameZh, setNewUomNameZh] = useState('')
  const [newUomCategoryId, setNewUomCategoryId] = useState('')
  const [newUomGoodsType, setNewUomGoodsType] = useState<GoodsType>('BULK')
  const [newUomExpand, setNewUomExpand] = useState(false)
  const [savingUom, setSavingUom] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const exportAction = useCsvExport({ entity: 'uoms', params: () => '', columns: UOM_EXPORT_COLUMNS })

  async function load() {
    try {
      const [cats, uoms] = await Promise.all([
        apiGet<UomCategory[]>('/api/uom-categories'),
        apiGet<Uom[]>('/api/uoms'),
      ])
      setCategories(cats)
      setAllUoms(uoms)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Load failed' : '加载失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function createUom() {
    if (!newUomName.trim()) { toast.error(isEn ? 'Please enter a unit name' : '请输入单位名称'); return }
    if (!newUomCategoryId) { toast.error(isEn ? 'Please select a category' : '请选择分类'); return }
    setSavingUom(true)
    try {
      await apiPost('/api/uoms', {
        name: newUomName.trim(),
        nameZh: newUomNameZh.trim() || undefined,
        categoryId: newUomCategoryId,
        goodsType: newUomGoodsType,
        expandByCustomer: newUomExpand,
      })
      toast.success(isEn ? 'Unit of Measure created' : '计量单位已创建')
      setNewUomName(''); setNewUomNameZh(''); setNewUomGoodsType('BULK'); setNewUomExpand(false)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Create failed' : '创建失败'))
    } finally {
      setSavingUom(false)
    }
  }

  async function deactivateUom(id: string, name: string) {
    const msg = isEn
      ? `Deactivate "${name}"? It will no longer appear in dropdowns, but historical data is preserved.`
      : `确认停用 "${name}"？停用后该单位不再出现在下拉选项中，历史数据保留。`
    if (!confirm(msg)) return
    try {
      await apiDelete(`/api/uoms/${id}`)
      toast.success(`${isEn ? 'Deactivated' : '已停用'}: ${name}`)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Failed' : '操作失败'))
    }
  }

  if (loading) return <div className="text-sm text-gray-400 py-4">{isEn ? 'Loading…' : '加载中…'}</div>

  return (
    <div className="space-y-6">
      <div className="flex justify-end gap-2">
        <button onClick={() => setImportOpen(true)}
          className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50">
          {isEn ? 'Import' : '导入'}
        </button>
        <button onClick={exportAction.onClick} disabled={exportAction.disabled}
          className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40">
          {exportAction.label}
        </button>
      </div>
      <div>
        {categories.length === 0 ? (
          <p className="text-sm text-gray-400">{isEn ? 'No categories yet' : '暂无分类'}</p>
        ) : (
          <div className="space-y-4">
            {categories.map(cat => {
              const uoms = allUoms.filter(u => u.categoryId === cat.id)
              return (
                <div key={cat.id} className="border border-gray-200 rounded overflow-hidden">
                  <div className="px-4 py-2 flex items-center gap-2" style={{ background: '#f3eff5' }}>
                    <span className="font-medium text-sm" style={{ color: PURPLE }}>
                      {isEn ? cat.name : (cat.nameZh || cat.name)}
                    </span>
                    {!isEn && cat.nameZh && cat.name && <span className="text-xs text-gray-400">({cat.name})</span>}
                  </div>
                  {uoms.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-gray-400">{isEn ? 'No units' : '暂无单位'}</p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="border-b border-gray-100">
                        <tr className="text-left text-xs text-gray-500">
                          <th className="px-4 py-2 font-medium">{isEn ? 'Name' : '名称'}</th>
                          <th className="px-4 py-2 font-medium">{isEn ? 'Chinese Name' : '中文名'}</th>
                          <th className="px-4 py-2 font-medium text-center">{isEn ? 'Goods' : '货物类型'}</th>
                          <th className="px-4 py-2 font-medium text-center">{isEn ? 'Picking Detail' : '拣货明细'}</th>
                          <th className="px-4 py-2 w-16"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {uoms.map(u => (
                          <tr key={u.id} className="hover:bg-gray-50">
                            <td className="px-4 py-1 font-medium">
                              <NameEditor
                                value={u.name}
                                required
                                isEn={isEn}
                                onSave={async (next) => {
                                  await apiPut(`/api/uoms/${u.id}`, { name: next })
                                  setAllUoms(prev => prev.map(x => x.id === u.id ? { ...x, name: next } : x))
                                }}
                              />
                            </td>
                            <td className="px-4 py-1 text-gray-500">
                              <NameEditor
                                value={u.nameZh || ''}
                                required={false}
                                isEn={isEn}
                                onSave={async (next) => {
                                  await apiPut(`/api/uoms/${u.id}`, { nameZh: next })
                                  setAllUoms(prev => prev.map(x => x.id === u.id ? { ...x, nameZh: next || undefined } : x))
                                }}
                              />
                            </td>
                            <td className="px-4 py-2 text-center">
                              <GoodsTypeEditor
                                uom={u}
                                isEn={isEn}
                                onChange={(next) => {
                                  // 乐观更新本地状态
                                  setAllUoms(prev => prev.map(x => x.id === u.id ? { ...x, goodsType: next } : x))
                                }}
                                onRevert={() => load()}
                              />
                            </td>
                            <td className="px-4 py-2 text-center">
                              <ExpandEditor
                                uom={u}
                                isEn={isEn}
                                onChange={(next) => {
                                  setAllUoms(prev => prev.map(x => x.id === u.id ? { ...x, expandByCustomer: next } : x))
                                }}
                                onRevert={() => load()}
                              />
                            </td>
                            <td className="px-4 py-2 text-center">
                              <button
                                onClick={() => deactivateUom(u.id, u.name)}
                                className="text-xs text-red-500 hover:text-red-700"
                              >
                                {isEn ? 'Deactivate' : '停用'}
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

      {/* New UOM */}
      <div className="border border-gray-200 rounded p-4">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">{isEn ? 'New Unit of Measure' : '新建计量单位'}</h3>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-xs text-gray-500 mb-1">{isEn ? 'Category' : '所属分类'}</label>
            <select value={newUomCategoryId} onChange={e => setNewUomCategoryId(e.target.value)}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-36 focus:outline-none focus:border-purple-400">
              <option value="">{isEn ? 'Select…' : '选择分类'}</option>
              {categories.map(c => <option key={c.id} value={c.id}>{isEn ? c.name : (c.nameZh || c.name)}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{isEn ? 'Name (EN)' : '单位名（英文）'}</label>
            <input type="text" value={newUomName} onChange={e => setNewUomName(e.target.value)}
              placeholder="e.g. kg"
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-24 focus:outline-none focus:border-purple-400" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{isEn ? 'Name (ZH, optional)' : '中文名（可选）'}</label>
            <input type="text" value={newUomNameZh} onChange={e => setNewUomNameZh(e.target.value)}
              placeholder={isEn ? 'optional' : '如 千克'}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-24 focus:outline-none focus:border-purple-400" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{isEn ? 'Goods Type' : '货物类型'}</label>
            <select
              value={newUomGoodsType}
              onChange={e => setNewUomGoodsType(e.target.value === 'LOOSE' ? 'LOOSE' : 'BULK')}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm w-32 focus:outline-none focus:border-purple-400 bg-white"
            >
              <option value="BULK">{isEn ? 'Bulk' : '大货'}</option>
              <option value="LOOSE">{isEn ? 'Loose' : '散货'}</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{isEn ? 'Picking Detail' : '拣货明细'}</label>
            <select
              value={newUomExpand ? 'YES' : 'NO'}
              onChange={e => setNewUomExpand(e.target.value === 'YES')}
              className="border border-gray-300 rounded px-2 py-1.5 text-sm w-36 focus:outline-none focus:border-purple-400 bg-white"
            >
              <option value="NO">{isEn ? 'Total only' : '只显示总量'}</option>
              <option value="YES">{isEn ? 'By customer' : '按客户展开'}</option>
            </select>
          </div>
          <button onClick={createUom} disabled={savingUom}
            className="h-9 px-4 text-white text-sm rounded disabled:opacity-40"
            style={{ background: PURPLE }}>
            {savingUom ? (isEn ? 'Creating…' : '创建中…') : (isEn ? 'Create Unit' : '创建单位')}
          </button>
        </div>
        <div className="text-xs text-gray-400 mt-2 space-y-1">
          <p>
            {isEn
              ? 'Goods Type: which picking list the item lands on — Bulk goes to the full case/bag sheet, Loose to the loose-goods sheet.'
              : '货物类型：决定这个货出现在哪张拣货单上——大货进整箱整袋单，散货进零散货单。'}
          </p>
          <p>
            {isEn
              ? 'Picking Detail: whether that sheet lists each customer separately. Pick "By customer" for goods cut/weighed per order at picking (e.g. winter melon by KG — one customer wants 2.5kg, another 6.2kg). Keep "Total only" for pre-packed units where the picker just counts packs (e.g. 1KG — one pack is 1kg, an order of 2kg is two packs). Lines with a note always show that customer regardless.'
              : '拣货明细：决定那张单上要不要逐个客户列出来。配货时现切现称、每份贴客户标签的选「按客户展开」（如冬瓜按 KG 卖，一家要 2.5kg、另一家 6.2kg，拣货员得知道每家各多少）；提前备好按包数拿的保持「只显示总量」（如 1KG 一包就是 1kg，点 2 公斤给两包）。写了备注的行不受此设置影响，永远会列出该客户。'}
          </p>
        </div>
      </div>

      <BulkImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={load}
        templateFileName="uoms-import-template"
        endpoint="/api/uoms/bulk"
        title={{ zh: '批量导入计量单位(CSV)', en: 'Bulk Import Units of Measure (CSV)' }}
        hint={{
          zh: '第一行为表头。「名称」「分类」必填。',
          en: 'Row 1 is the header. Name and Category are required.',
        }}
        extraHint={{
          zh: <>只支持新建：按名称全局判重(不分单位分类)，撞了跳过，不会更新已有单位；需要改已有单位请到上方表格直接编辑。「分类」填已有的单位分类名称(中英文均可)，查不到会跳过该行。</>,
          en: <>Create-only: name collisions (across all categories) are skipped, never updated — edit existing units directly in the table above. Category must match an existing unit category name (English or Chinese); unmatched rows are skipped.</>,
        }}
        columns={[
          { key: 'name', label: isEn ? 'Name' : '名称', required: true },
          { key: 'nameZh', label: isEn ? 'Chinese Name' : '中文名称' },
          { key: 'category', label: isEn ? 'Category' : '单位分类', required: true },
          { key: 'goodsType', label: isEn ? 'Goods Type (BULK/LOOSE)' : '货物类型(BULK/LOOSE)' },
          { key: 'expandByCustomer', label: isEn ? 'Expand By Customer (Y/N)' : '拣货按客户展开(Y/N)' },
        ]}
        exampleRows={[['Demo Bag', '示例包', 'Weight', 'BULK', 'N']]}
      />
      {exportAction.dialog}
    </div>
  )
}

// ─── Product Category Section ─────────────────────────────────────────────────

function ProductCategorySection({ isEn }: { isEn: boolean }) {
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [newParentId, setNewParentId] = useState('')
  const [editParentId, setEditParentId] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const tree = buildCategoryTree(categories)
  const allNodes: CategoryTreeNode<ProductCategory>[] = []
  const visibleNodes: CategoryTreeNode<ProductCategory>[] = []
  function collect(nodes: CategoryTreeNode<ProductCategory>[], visible: boolean) {
    for (const node of nodes) {
      allNodes.push(node)
      if (visible) visibleNodes.push(node)
      collect(node.children, visible && !collapsed.has(node.id))
    }
  }
  collect(tree, true)
  function parentOptions(id: string | null) {
    return allNodes.filter(node => {
      try { validateCategoryMove(categories, id, node.id); return true } catch { return false }
    }).map(node => <option key={node.id} value={node.id}>{'— '.repeat(node.depth - 1)}{isEn ? node.name : node.nameZh || node.name}</option>)
  }
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [newNameZh, setNewNameZh] = useState('')
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editNameZh, setEditNameZh] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const exportAction = useCsvExport({ entity: 'product-categories', params: () => '', columns: PRODUCT_CATEGORY_EXPORT_COLUMNS })

  async function load() {
    try {
      const cats = await apiGet<ProductCategory[]>('/api/product-categories?fresh=1')
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
      await apiPost('/api/product-categories', { name: newName.trim(), nameZh: newNameZh.trim() || undefined, parentId: newParentId || null })
      toast.success(isEn ? 'Category created' : '商品分类已创建')
      setNewName(''); setNewNameZh(''); setNewParentId('')
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
      await apiPut(`/api/product-categories/${id}`, { name: editName.trim(), nameZh: editNameZh.trim() || null, parentId: editParentId || null })
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
      <div className="flex justify-end gap-2">
        <button onClick={() => setImportOpen(true)}
          className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50">
          {isEn ? 'Import' : '导入'}
        </button>
        <button onClick={exportAction.onClick} disabled={exportAction.disabled}
          className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40">
          {exportAction.label}
        </button>
      </div>
      <div className="border border-gray-200 rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200" style={{ background: '#f3eff5' }}>
            <tr className="text-left text-xs text-gray-600">
              <th className="px-4 py-2 font-medium">{isEn ? 'English Name' : '英文名'}</th>
              <th className="px-4 py-2 font-medium">{isEn ? 'Chinese Name' : '中文名'}</th>
              <th className="px-4 py-2 font-medium">{isEn ? 'Parent Category' : '父分类'}</th>
              <th className="px-4 py-2 w-28"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {categories.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-400">{isEn ? 'No categories' : '暂无分类'}</td></tr>
            )}
            {visibleNodes.map(cat => (
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
                      <select aria-label={isEn ? 'Parent Category' : '父分类'} value={editParentId} onChange={event => setEditParentId(event.target.value)} className="border rounded p-2 max-w-48">
                        <option value="">{isEn ? 'Top level' : '顶级分类'}</option>
                        {parentOptions(cat.id)}
                      </select>
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
                    <td className="px-4 py-2 font-medium">
                      <div className="flex items-center gap-2" style={{ paddingLeft: (cat.depth - 1) * 20 }}>
                        {cat.children.length > 0 ? <button aria-label={`${collapsed.has(cat.id) ? (isEn ? 'Expand' : '展开') : (isEn ? 'Collapse' : '折叠')} ${cat.name}`} aria-expanded={!collapsed.has(cat.id)} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(cat.id)) next.delete(cat.id); else next.add(cat.id); return next })} className="w-8 h-8">{collapsed.has(cat.id) ? '▸' : '▾'}</button> : <span className="w-8 shrink-0" />}
                        <span>{cat.name}</span><span className="text-xs text-gray-400">L{cat.depth}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-gray-500">{cat.nameZh || '-'}</td>
                    <td className="px-4 py-2 text-gray-500">{categories.find(parent => parent.id === cat.parentId)?.name || (isEn ? 'Top level' : '顶级分类')}</td>
                    <td className="px-4 py-2">
                      <div className="flex gap-2">
                        <button onClick={() => { setEditingId(cat.id); setEditName(cat.name); setEditNameZh(cat.nameZh ?? ''); setEditParentId(cat.parentId ?? '') }}
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
            <label className="block text-xs text-gray-500 mb-1" htmlFor="new-category-parent">{isEn ? 'Parent Category (up to 3 levels)' : '父分类（最多三级）'}</label>
            <select id="new-category-parent" value={newParentId} onChange={event => setNewParentId(event.target.value)} className="border border-gray-300 rounded px-3 py-1.5 text-sm max-w-64">
              <option value="">{isEn ? 'Top level' : '顶级分类'}</option>
              {parentOptions(null)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{isEn ? 'Name (EN)' : '英文名'}</label>
            <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
              placeholder={isEn ? 'e.g. Vegetables' : '如 Vegetables'}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-40 focus:outline-none focus:border-purple-400" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">{isEn ? 'Name (ZH, optional)' : '中文名（可选）'}</label>
            <input type="text" value={newNameZh} onChange={e => setNewNameZh(e.target.value)}
              placeholder={isEn ? 'optional' : '如 蔬菜'}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm w-40 focus:outline-none focus:border-purple-400" />
          </div>
          <button onClick={create} disabled={saving}
            className="h-9 px-4 text-white text-sm rounded disabled:opacity-40"
            style={{ background: PURPLE }}>
            {saving ? (isEn ? 'Creating…' : '创建中…') : (isEn ? 'Create' : '创建')}
          </button>
        </div>
      </div>

      <BulkImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={load}
        templateFileName="product-categories-import-template"
        endpoint="/api/product-categories/bulk"
        title={{ zh: '批量导入商品分类(CSV)', en: 'Bulk Import Product Categories (CSV)' }}
        hint={{
          zh: '第一行为表头。仅「英文名」必填。',
          en: 'Row 1 is the header. English Name is the only required column.',
        }}
        extraHint={{
          zh: <>按「ID」精确匹配更新对应分类——保留从导出文件带出的「ID」列可可靠更新;没传/没匹配上则按名称判重(撞了跳过,不覆盖),否则新建。「采购品类分组」「应放温区」填已有名称(中英文均可),查不到会留空(不阻断整行)。</>,
          en: <>Matched by ID (exact match) updates that category — keep the ID column from an exported file to reliably update; otherwise a name collision is skipped, no match creates a new one. Purchase Group / Required Zone must match an existing name (English or Chinese); unmatched values are left unset, not blocking.</>,
        }}
        columns={[
          { key: 'externalId', label: isEn ? 'ID' : 'ID' },
          { key: 'name', label: isEn ? 'Name (EN)' : '英文名', required: true },
          { key: 'nameZh', label: isEn ? 'Name (ZH)' : '中文名' },
          { key: 'group', label: isEn ? 'Purchase Group' : '采购品类分组' },
          { key: 'requiredZone', label: isEn ? 'Required Zone' : '应放温区' },
        ]}
        exampleRows={[['', 'Vegetables', '蔬菜', '', '']]}
      />
      {exportAction.dialog}
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
    { id: 'uom', label: isEn ? 'Units of Measure' : '计量单位' },
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
              {isEn ? 'Units of Measure' : '计量单位'}
            </h2>
            <p className="text-sm text-gray-500 mb-5">
              {isEn ? 'Manage UoM categories and units for products and inventory.' : '管理计量单位分类和单位，用于商品规格和库存管理。'}
            </p>
            <UomSection isEn={isEn} />
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
