'use client'
/**
 * 供应商详情/编辑/新建（Purchases → Vendors → 点进去 / 新建）
 * ============================================================================
 * 客户 20260907 决策：客户与供应商字段"彻底分离"——不再复用 Customers 模块那张
 * 大表单（`customers/[id]/page.tsx` 已经把 Purchase/Fiscal/Loyalty 三块删掉）。
 * 「一个联系人既是客户又是供应商」按客户原话"建议分两条编辑"处理：这里创建的
 * 供应商记录固定 `isVendor:true、isCustomer:false`，编辑时也**不提交** isCustomer/
 * isVendor 字段，绝不会把已有客户记录的身份标记翻掉，也不提供"转成客户"的入口——
 * 真要两者都做，去两个模块各建一条。
 *
 * 底层仍是同一张 Customer 表、同一套 `/api/customers` 增删改查——没有必要为了
 * "UI 分离"再造一整套后端，本来就是同一个实体的两个不同字段子集。
 */
import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import { PURCHASE_TAX_RATES } from '@/lib/purchase/tax-rates'
import type { Customer } from '@/lib/types'

const PURPLE = '#875A7B'
const DARK = '#1f2d3d'

interface FormState {
  name: string
  street: string
  street2: string
  city: string
  state: string
  zip: string
  country: string
  phone: string
  email: string
  vatNumber: string
  supplierPaymentTerm: string
  /** 与 PURCHASE_TAX_RATES 三档对齐（'0'/'13.5'/'23'），空串=未设置 */
  vendorTaxRate: string
  notes: string
  isActive: boolean
}

function emptyForm(): FormState {
  return {
    name: '', street: '', street2: '', city: '', state: '', zip: '', country: 'Ireland',
    phone: '', email: '', vatNumber: '',
    supplierPaymentTerm: '', vendorTaxRate: '',
    notes: '', isActive: true,
  }
}

function vendorToForm(c: Customer): FormState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cAny = c as any
  return {
    name: c.name,
    street: (cAny.street ?? '') || (c.address ?? ''),
    street2: (cAny.street2 ?? '') as string,
    city: c.city ?? '',
    state: (cAny.state ?? '') as string,
    zip: (cAny.zip ?? '') as string,
    country: ((cAny.country as string) || 'Ireland'),
    phone: c.phone ?? '',
    email: c.email ?? '',
    vatNumber: c.vatNumber ?? '',
    supplierPaymentTerm: c.supplierPaymentTerm ?? '',
    vendorTaxRate: c.vendorTaxRate != null ? String(Number(c.vendorTaxRate) * 100) : '',
    notes: c.notes ?? '',
    isActive: cAny.isActive !== false,
  }
}

const inputCls = [
  'w-full border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-800 bg-white',
  'hover:border-gray-400 focus:border-[#875A7B] focus:outline-none transition-colors',
].join(' ')

const selectCls = inputCls + ' cursor-pointer'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start py-1.5">
      <span className="flex-shrink-0 w-40 text-sm text-gray-600 pt-1.5">{label}</span>
      <div className="flex-1 min-w-0">
        {children}
        {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
      </div>
    </div>
  )
}

export default function VendorDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const isNew = id === 'new'

  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale

  const [form, setForm] = useState<FormState>(emptyForm())
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)

  function setField<K extends keyof FormState>(key: K, val: FormState[K]) {
    setForm(f => ({ ...f, [key]: val }))
  }

  useEffect(() => {
    if (isNew) return
    setLoading(true)
    apiGet<Customer>(`/api/customers/${id}`)
      .then(c => setForm(vendorToForm(c)))
      .catch(() => {
        toast.error(isEn ? 'Failed to load vendor' : '加载供应商失败')
        router.push(`${prefix}/classic/operator/purchases`)
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  function goBack() {
    router.push(`${prefix}/classic/operator/purchases`)
  }

  async function handleSave() {
    if (saving) return
    if (!form.name.trim()) { toast.error(isEn ? 'Vendor name is required' : '供应商名称不能为空'); return }

    const street = form.street.trim()
    const street2 = form.street2.trim()
    const state = form.state.trim()
    const zip = form.zip.trim()
    const country = form.country.trim()
    const composedAddress = [street, street2, [form.city.trim(), state, zip].filter(Boolean).join(' '), country]
      .filter(Boolean)
      .join(', ')

    const fields = {
      name: form.name.trim(),
      address: composedAddress,
      street, street2, state, zip, country,
      city: form.city.trim() || undefined,
      phone: form.phone.trim(),
      email: form.email.trim(),
      vatNumber: form.vatNumber.trim().toUpperCase(),
      supplierPaymentTerm: form.supplierPaymentTerm || null,
      vendorTaxRate: form.vendorTaxRate !== '' ? Number(form.vendorTaxRate) / 100 : null,
      notes: form.notes.trim() || undefined,
    }

    setSaving(true)
    try {
      if (isNew) {
        // 新建的供应商记录固定 isVendor:true / isCustomer:false —— 见文件头注释
        const created = await apiPost<Customer>('/api/customers', {
          ...fields,
          isVendor: true,
          isCustomer: false,
        })
        toast.success(isEn ? 'Vendor created' : '供应商已创建')
        router.replace(`${prefix}/classic/operator/purchases/vendors/${created.id}`)
      } else {
        // 编辑时不提交 isVendor/isCustomer，绝不改动这条记录的身份标记
        await apiPut(`/api/customers/${id}`, { ...fields, isActive: form.isActive })
        toast.success(isEn ? 'Saved successfully' : '保存成功')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-400">
        <div className="w-5 h-5 border-2 border-gray-300 rounded-full animate-spin mr-3" style={{ borderTopColor: PURPLE }} />
        {isEn ? 'Loading...' : '加载中...'}
      </div>
    )
  }

  return (
    <div style={{ background: '#f3f4f5' }} className="min-h-full">
      <div className="bg-white border-b border-gray-200">
        <div className="px-6 pt-3 pb-1 text-xs text-gray-500">
          <button onClick={goBack} className="hover:underline" style={{ color: PURPLE }}>
            {isEn ? 'Purchases' : '采购'}
          </button>
          <span className="mx-1 text-gray-400">/</span>
          <button onClick={goBack} className="hover:underline" style={{ color: PURPLE }}>
            {isEn ? 'Vendors' : '供应商'}
          </button>
          <span className="mx-1 text-gray-400">/</span>
          <span className="text-gray-700 font-medium">{isNew ? (isEn ? 'New' : '新建') : form.name}</span>
        </div>
        <div className="px-6 py-2.5 flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="h-8 px-4 text-sm font-medium rounded text-white disabled:opacity-50"
            style={{ background: PURPLE }}
          >
            {saving ? (isEn ? 'Saving…' : '保存中…') : (isEn ? 'Save' : '保存')}
          </button>
          <button
            onClick={goBack}
            className="h-8 px-4 text-sm rounded border font-medium hover:bg-gray-50"
            style={{ borderColor: '#d0d5dd', color: DARK }}
          >
            {isEn ? 'Cancel' : '取消'}
          </button>
        </div>
      </div>

      <div className="p-6">
        <div className="bg-white rounded border border-gray-200 shadow-sm p-6 max-w-2xl">
          <div className="grid grid-cols-2 gap-x-10">
            <div>
              <Field label={isEn ? 'Vendor Name *' : '供应商名称 *'}>
                <input type="text" value={form.name} onChange={e => setField('name', e.target.value)} className={inputCls} autoFocus />
              </Field>
              <Field label={isEn ? 'Street' : '街道'}>
                <input type="text" value={form.street} onChange={e => setField('street', e.target.value)} className={inputCls} />
              </Field>
              <Field label={isEn ? 'Street 2' : '街道 2'}>
                <input type="text" value={form.street2} onChange={e => setField('street2', e.target.value)} className={inputCls} />
              </Field>
              <Field label={isEn ? 'City' : '城市'}>
                <input type="text" value={form.city} onChange={e => setField('city', e.target.value)} className={inputCls} />
              </Field>
              <Field label={isEn ? 'State/County' : '州/郡'}>
                <input type="text" value={form.state} onChange={e => setField('state', e.target.value)} className={inputCls} />
              </Field>
              <Field label="ZIP">
                <input type="text" value={form.zip} onChange={e => setField('zip', e.target.value)} className={inputCls} />
              </Field>
              <Field label={isEn ? 'Country' : '国家'}>
                <input type="text" value={form.country} onChange={e => setField('country', e.target.value)} className={inputCls} />
              </Field>
            </div>
            <div>
              <Field label={isEn ? 'Phone' : '电话'}>
                <input type="text" value={form.phone} onChange={e => setField('phone', e.target.value)} className={inputCls} />
              </Field>
              <Field label={isEn ? 'Email' : '邮箱'}>
                <input type="text" value={form.email} onChange={e => setField('email', e.target.value)} className={inputCls} />
              </Field>
              <Field label={isEn ? 'VAT Number' : '税号'}>
                <input type="text" value={form.vatNumber} onChange={e => setField('vatNumber', e.target.value)} className={inputCls} placeholder="e.g. IE0477472D" />
              </Field>
              <Field label={isEn ? 'Payment Terms' : '付款条款'}>
                <select value={form.supplierPaymentTerm} onChange={e => setField('supplierPaymentTerm', e.target.value)} className={selectCls}>
                  <option value=""></option>
                  <option value="immediate">{isEn ? 'Immediate Payment' : '即时付款'}</option>
                  <option value="30days">{isEn ? 'Net 30 Days' : '30天账期'}</option>
                </select>
              </Field>
              <Field
                label={isEn ? 'Vendor Tax Rate' : '采购税率'}
                hint={isEn
                  ? 'Default tax rate used when this vendor\'s products don\'t have their own vendor tax set (purchase suggestions).'
                  : '该供应商商品自身未设置采购税率时的兜底默认值（用于采购建议）。'}
              >
                <select value={form.vendorTaxRate} onChange={e => setField('vendorTaxRate', e.target.value)} className={selectCls}>
                  <option value="">{isEn ? 'Unset' : '未设置'}</option>
                  {PURCHASE_TAX_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                </select>
              </Field>
              {!isNew && (
                <Field label={isEn ? 'Active' : '启用状态'}>
                  <div className="flex items-center h-8">
                    <input type="checkbox" checked={form.isActive} onChange={e => setField('isActive', e.target.checked)} className="accent-[#875A7B] w-4 h-4" />
                    <span className="ml-2 text-sm text-gray-600">{form.isActive ? (isEn ? 'Active' : '活跃') : (isEn ? 'Archived' : '已归档')}</span>
                  </div>
                </Field>
              )}
            </div>
          </div>

          <div className="mt-4">
            <label className="block text-sm text-gray-500 mb-1.5">{isEn ? 'Notes' : '备注'}</label>
            <textarea
              value={form.notes}
              onChange={e => setField('notes', e.target.value)}
              rows={3}
              placeholder={isEn ? 'Internal notes...' : '内部备注...'}
              className={`w-full ${inputCls} resize-none`}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
