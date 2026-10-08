'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ChevronRight, Folder, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPost, apiPut } from '@/lib/api'
import type { ProductCategory } from '@/lib/types'
import { buildCategoryNavigation, categoryParentChoices } from '@/lib/product-category-navigation'
import { validateCategoryMove, type CategoryTreeNode } from '@/lib/product-category-tree'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import BulkImportDialog from '@/components/shared/BulkImportDialog'
import { useCsvExport } from '@/hooks/use-csv-export'
import { PRODUCT_CATEGORY_EXPORT_COLUMNS } from '@/lib/export/columns/product-categories'

type Category = CategoryTreeNode<ProductCategory>
type Editor = { id: string | null; parentId: string; name: string; nameZh: string }

export default function ProductCategoryManager({ isEn }: { isEn: boolean }) {
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mobileLevel, setMobileLevel] = useState(1)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [deleting, setDeleting] = useState<Category | null>(null)
  const [saving, setSaving] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const navigation = useMemo(() => buildCategoryNavigation(categories), [categories])
  const selectedPath = navigation.find(entry => entry.node.id === selectedId)?.path ?? []
  const levelNames = isEn ? ['Level 1', 'Level 2', 'Level 3'] : ['一级分类', '二级分类', '三级分类']
  const displayName = (category: ProductCategory) => isEn ? category.name : category.nameZh || category.name
  const pathLabel = (path: ProductCategory[]) => path.map(displayName).join(' → ')
  const exportAction = useCsvExport({ entity: 'product-categories', params: () => '', columns: PRODUCT_CATEGORY_EXPORT_COLUMNS })
  const parentPath = navigation.find(entry => entry.node.id === editor?.parentId)?.path ?? []
  const editorLevel = parentPath.length + 1
  const parentChoices = useMemo(() => categoryParentChoices(categories, editor?.id ?? null), [categories, editor?.id])
  const searchTerm = search.trim().toLocaleLowerCase()
  const matches = searchTerm ? navigation.filter(entry => entry.path.some(category => `${category.name} ${category.nameZh ?? ''}`.toLocaleLowerCase().includes(searchTerm))) : []

  async function load() {
    const data = await apiGet<ProductCategory[]>('/api/product-categories?fresh=1')
    setCategories(data)
  }

  useEffect(() => {
    load().catch(error => toast.error(error instanceof Error ? error.message : (isEn ? 'Load failed' : '加载失败'))).finally(() => setLoading(false))
  }, [isEn])

  function select(category: Category, nextLevel = true) {
    setSelectedId(category.id)
    setMobileLevel(nextLevel ? Math.min(3, category.depth + 1) : category.depth)
    setSearch('')
  }

  function openCreate(parentId: string | null) {
    setEditor({ id: null, parentId: parentId ?? '', name: '', nameZh: '' })
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!editor || saving) return
    if (!editor.name.trim()) { toast.error(isEn ? 'Please enter an English name' : '请输入英文名'); return }
    setSaving(true)
    try {
      validateCategoryMove(categories, editor.id, editor.parentId || null)
      const payload = { name: editor.name.trim(), nameZh: editor.nameZh.trim() || null, parentId: editor.parentId || null }
      const category = editor.id
        ? await apiPut<ProductCategory>(`/api/product-categories/${editor.id}`, payload)
        : await apiPost<ProductCategory>('/api/product-categories', payload)
      await load()
      setSelectedId(category.id)
      setMobileLevel(editor.id ? editorLevel : Math.min(3, editorLevel + 1))
      setSearch('')
      setEditor(null)
      toast.success(isEn ? 'Category saved' : '分类已保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : (isEn ? 'Save failed' : '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!deleting || saving) return
    setSaving(true)
    try {
      await apiDelete(`/api/product-categories/${deleting.id}`)
      await load()
      if (selectedId === deleting.id) setSelectedId(deleting.parentId ?? null)
      setDeleting(null)
      toast.success(isEn ? 'Category deleted' : '分类已删除')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : (isEn ? 'Delete failed' : '删除失败'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="py-6 text-sm text-gray-500">{isEn ? 'Loading…' : '加载中…'}</p>

  return (
    <div className="space-y-4 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border bg-white px-3">
          <Search className="size-4 shrink-0 text-gray-400" />
          <input aria-label={isEn ? 'Search categories' : '搜索分类'} value={search} onChange={event => setSearch(event.target.value)} placeholder={isEn ? 'Search category name or path' : '搜索分类名称或归属路径'} className="h-11 w-full min-w-0 bg-transparent text-sm outline-none" />
        </label>
        <button onClick={() => setImportOpen(true)} className="min-h-11 rounded-lg border px-4 text-sm">{isEn ? 'Import' : '导入'}</button>
        <button onClick={exportAction.onClick} disabled={exportAction.disabled} className="min-h-11 rounded-lg border px-4 text-sm disabled:opacity-40">{exportAction.label}</button>
      </div>

      <nav aria-label={isEn ? 'Category path' : '分类路径'} className="flex flex-wrap items-center gap-2 text-sm">
        <button onClick={() => { setSelectedId(null); setMobileLevel(1); setSearch('') }} className="min-h-11 text-purple-800">{isEn ? 'All categories' : '全部分类'}</button>
        {selectedPath.map(category => <span key={category.id} className="flex min-w-0 items-center gap-2"><ChevronRight className="size-4 shrink-0 text-gray-400" /><button onClick={() => select(category)} className="min-h-11 break-words text-purple-800">{displayName(category)}</button></span>)}
      </nav>

      {searchTerm && <section aria-label={isEn ? 'Search results' : '搜索结果'} className="max-h-80 overflow-y-auto rounded-xl border bg-white p-3">
        <div className="mb-2 flex items-center justify-between gap-2 text-sm"><span>{isEn ? `${matches.length} matches` : `${matches.length} 个匹配分类`}</span><button onClick={() => setSearch('')} className="min-h-11 text-purple-800">{isEn ? 'Clear search' : '清除搜索'}</button></div>
        {matches.map(({ node, path }) => <button key={node.id} onClick={() => select(node, false)} className="block min-h-11 w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-purple-50"><span className="font-medium">{displayName(node)}</span><span className="mt-1 block break-words text-xs text-gray-500">{pathLabel(path)}</span></button>)}
        {!matches.length && <p className="p-3 text-sm text-gray-500">{isEn ? 'No matching categories' : '没有找到匹配分类'}</p>}
      </section>}

      <div className="grid min-w-0 gap-4 md:grid-cols-3">
        {[1, 2, 3].map(level => {
          const parent = level > 1 ? selectedPath[level - 2] : null
          const nodes = level === 1 ? navigation.filter(entry => entry.node.depth === 1).map(entry => entry.node) : parent?.children ?? []
          const ready = level === 1 || Boolean(parent)
          return <section key={level} aria-label={levelNames[level - 1]} className={`${mobileLevel === level ? 'flex' : 'hidden'} min-w-0 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white md:flex`}>
            <header className="border-b bg-gray-50 p-4"><h3 className="flex items-center justify-between gap-2 font-semibold"><span>{levelNames[level - 1]}</span><span className="rounded-full bg-white px-2 py-1 text-xs text-gray-500">{nodes.length}</span></h3><p className="mt-1 truncate text-xs text-gray-500">{parent ? pathLabel(selectedPath.slice(0, level - 1)) : level === 1 ? (isEn ? 'Top-level categories' : '商品分类入口') : (isEn ? 'Select a parent to view children' : '选择上级后展示子分类')}</p></header>
            <ul className="min-h-56 flex-1 divide-y divide-gray-100 md:max-h-[32rem] md:overflow-y-auto">
              {nodes.map(category => {
                const active = selectedPath.some(node => node.id === category.id)
                return <li key={category.id} className={active ? 'border-l-4 border-l-purple-700 bg-purple-50' : 'border-l-4 border-l-transparent'}>
                  <button onClick={() => select(category)} aria-pressed={active} className="flex min-h-14 w-full min-w-0 items-center gap-2 px-3 py-3 text-left hover:bg-purple-50">
                    <Folder className="size-4 shrink-0 text-purple-700" /><span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium">{displayName(category)}</span><span className="mt-1 block break-words text-xs text-gray-500">{isEn ? category.nameZh : category.name}</span></span>
                    {level < 3 && <><span className="text-xs text-gray-500">{category.children.length}</span><ChevronRight className="size-4 shrink-0 text-gray-400" /></>}
                  </button>
                  <div className="flex flex-wrap gap-1 px-3 pb-2">
                    {level < 3 && <button aria-label={`${isEn ? 'Add child to' : '添加子分类到'} ${displayName(category)}`} onClick={() => openCreate(category.id)} className="inline-flex min-h-11 items-center gap-1 rounded px-2 text-xs text-purple-800 hover:bg-purple-100"><Plus className="size-3" />{isEn ? 'Add child' : '添加子分类'}</button>}
                    <button aria-label={`${isEn ? 'Edit' : '编辑'} ${displayName(category)}`} onClick={() => setEditor({ id: category.id, parentId: category.parentId ?? '', name: category.name, nameZh: category.nameZh ?? '' })} className="inline-flex min-h-11 items-center gap-1 rounded px-2 text-xs text-gray-600 hover:bg-gray-100"><Pencil className="size-3" />{isEn ? 'Edit' : '编辑'}</button>
                    <button aria-label={`${isEn ? 'Delete' : '删除'} ${displayName(category)}`} disabled={category.children.length > 0} title={category.children.length ? (isEn ? 'Move or delete child categories first' : '请先移动或删除子分类') : undefined} onClick={() => setDeleting(category)} className="inline-flex min-h-11 items-center gap-1 rounded px-2 text-xs text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-3" />{isEn ? 'Delete' : '删除'}</button>
                  </div>
                </li>
              })}
              {!nodes.length && <li className="px-5 py-12 text-center text-sm text-gray-500">{!ready ? (isEn ? `Select a level ${level - 1} category first` : `请先选择${level === 2 ? '一级' : '二级'}分类`) : (isEn ? 'No categories yet. Add one below.' : '暂无分类，点击下方按钮创建')}</li>}
            </ul>
            <footer className="border-t p-3"><button disabled={!ready} onClick={() => openCreate(parent?.id ?? null)} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-purple-300 text-sm font-medium text-purple-800 hover:bg-purple-50 disabled:cursor-not-allowed disabled:opacity-40"><Plus className="size-4" />{isEn ? `Add level ${level}` : `新增${levelNames[level - 1]}`}</button></footer>
          </section>
        })}
      </div>

      <Dialog open={editor !== null} onOpenChange={open => { if (!open && !saving) setEditor(null) }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>{editor?.id ? (isEn ? 'Edit category' : '编辑分类') : (isEn ? `New level ${editorLevel} category` : `新建${levelNames[editorLevel - 1]}`)}</DialogTitle><DialogDescription>{isEn ? 'Up to three levels. Product associations are preserved.' : '最多支持三级，保留现有商品关联。'}</DialogDescription></DialogHeader>
          {editor && <form onSubmit={save} className="space-y-4">
            <div className="rounded-lg bg-purple-50 p-3 text-sm"><span className="block text-xs text-gray-500">{isEn ? 'Parent path' : '所属路径'}</span><span className="mt-1 block break-words font-medium text-purple-900">{parentPath.length ? pathLabel(parentPath) : (isEn ? 'All categories (top level)' : '全部分类（一级）')}</span></div>
            {editor.id && <label className="block space-y-1 text-sm"><span>{isEn ? 'Parent category' : '所属分类'}</span><select aria-label={isEn ? 'Parent category' : '所属分类'} value={editor.parentId} onChange={event => setEditor({ ...editor, parentId: event.target.value })} className="min-h-11 w-full rounded-lg border px-3"><option value="">{isEn ? 'Top level' : '一级分类（无上级）'}</option>{parentChoices.map(({ node, path }) => <option key={node.id} value={node.id}>{pathLabel(path)}</option>)}</select><span className="block text-xs text-gray-500">{isEn ? `Result: level ${editorLevel}` : `调整后为${levelNames[editorLevel - 1]}`}</span></label>}
            <label className="block space-y-1 text-sm"><span>{isEn ? 'English name' : '英文名'} *</span><input required autoFocus value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} className="min-h-11 w-full rounded-lg border px-3" /></label>
            <label className="block space-y-1 text-sm"><span>{isEn ? 'Chinese name (optional)' : '中文名（可选）'}</span><input value={editor.nameZh} onChange={event => setEditor({ ...editor, nameZh: event.target.value })} className="min-h-11 w-full rounded-lg border px-3" /></label>
            <div className="flex justify-end gap-2"><button type="button" disabled={saving} onClick={() => setEditor(null)} className="min-h-11 rounded-lg border px-4">{isEn ? 'Cancel' : '取消'}</button><button type="submit" disabled={saving} className="min-h-11 rounded-lg bg-[#875A7B] px-4 text-white disabled:opacity-40">{saving ? (isEn ? 'Saving…' : '保存中…') : (isEn ? 'Save' : '保存')}</button></div>
          </form>}
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={open => { if (!open && !saving) setDeleting(null) }}>
        <DialogContent><DialogHeader><DialogTitle>{isEn ? 'Delete category?' : '删除分类？'}</DialogTitle><DialogDescription>{deleting && displayName(deleting)} — {isEn ? 'Categories with child categories or linked products cannot be deleted.' : '有关联商品或子分类的分类不能删除。'}</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><button disabled={saving} onClick={() => setDeleting(null)} className="min-h-11 rounded-lg border px-4">{isEn ? 'Cancel' : '取消'}</button><button disabled={saving} onClick={remove} className="min-h-11 rounded-lg bg-red-600 px-4 text-white disabled:opacity-40">{saving ? (isEn ? 'Deleting…' : '删除中…') : (isEn ? 'Delete' : '删除')}</button></div></DialogContent>
      </Dialog>

      <BulkImportDialog open={importOpen} onClose={() => setImportOpen(false)} onDone={load} templateFileName="product-categories-import-template" endpoint="/api/product-categories/bulk" historyResource="product_category" title={{ zh: '批量导入商品分类(CSV)', en: 'Bulk Import Product Categories (CSV)' }} hint={{ zh: '第一行为表头。仅「英文名」必填。', en: 'Row 1 is the header. English Name is the only required column.' }} extraHint={{ zh: <>按 ID 更新已有分类；无 ID 时按名称判重。采购品类分组、应放温区使用已有名称。新增分类默认为一级，可在编辑窗口调整所属分类。</>, en: <>Update existing categories by ID; otherwise check names for duplicates. Purchase Group / Required Zone must match existing names. New categories start at level 1; edit their parent afterward.</> }} columns={[{ key: 'externalId', label: 'ID' }, { key: 'name', label: isEn ? 'Name (EN)' : '英文名', required: true }, { key: 'nameZh', label: isEn ? 'Name (ZH)' : '中文名' }, { key: 'group', label: isEn ? 'Purchase Group' : '采购品类分组' }, { key: 'requiredZone', label: isEn ? 'Required Zone' : '应放温区' }]} exampleRows={ [['', 'Vegetables', '蔬菜', '', '']] } />
      {exportAction.dialog}
    </div>
  )
}
