'use client'
import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { toast } from 'sonner'
import { apiGet, apiPost, apiPut } from '@/lib/api'
import { NumericInput } from '@/components/ui/numeric-input'
import ChatterFeed from '@/components/shared/chatter-feed'
import type { Customer, OdooPricelist } from '@/lib/types'

// ─── Types ────────────────────────────────────────────────────────────────────

interface CustomerSpecialPrice {
  id?: string
  productId: string
  minQty: number
  fixedPrice: number
  dateStart?: string
  dateEnd?: string
  note?: string
}

interface ProductOption {
  id: string
  name: string
}

const EMPTY_SP: CustomerSpecialPrice = { productId: '', minQty: 0, fixedPrice: 0 }

interface FormState {
  name: string
  individualOrCompany: 'individual' | 'company'
  companyName: string
  // Address
  street: string
  street2: string
  city: string
  state: string
  zip: string
  country: string
  vatNumber: string
  // Right column
  jobPosition: string
  phone: string
  mobile: string
  email: string
  website: string
  title: string
  language: string
  creditLimit: string
  tags: string
  commissionRate: string
  commissionFixed: string
  priceType: string
  // Sales & Purchases
  isCustomer: boolean
  salesperson: string
  salesTeam: string
  paymentTerm: string
  pricelistIds: string[]
  defaultDriverSlotId: string
  isVendor: boolean
  supplierPaymentTerm: string
  supplierCurrency: string
  internalReference: string
  barcode: string
  fiscalPosition: string
  notes: string
  externalNote: string
}

function emptyForm(): FormState {
  return {
    name: '',
    individualOrCompany: 'individual',
    companyName: '',
    street: '', street2: '', city: '', state: '', zip: '', country: '',
    vatNumber: '',
    jobPosition: '', phone: '', mobile: '', email: '', website: '',
    title: '', language: 'English (UK)',
    creditLimit: '0.00', tags: '', commissionRate: '1.00', commissionFixed: '0.00',
    priceType: 'Default Price',
    isCustomer: true, salesperson: '', salesTeam: '',
    paymentTerm: '', pricelistIds: [], defaultDriverSlotId: '',
    isVendor: false, supplierPaymentTerm: '', supplierCurrency: '',
    internalReference: '', barcode: '', fiscalPosition: '',
    notes: '',
    externalNote: '',
  }
}

function customerToForm(c: Customer): FormState {
  // 兼容旧数据：如果新字段 street 还没填、但 address 有内容，则把 address 作为 street1 显示
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cAny = c as any
  const newStreet = (cAny.street ?? '') as string
  const newStreet2 = (cAny.street2 ?? '') as string
  const fallbackStreet = newStreet || (c.address ?? '')
  return {
    name: c.name,
    individualOrCompany: 'company',
    companyName: '',
    street: fallbackStreet,
    street2: newStreet2,
    city: c.city ?? '',
    state: (cAny.state ?? '') as string,
    zip: (cAny.zip ?? '') as string,
    country: ((cAny.country as string) || 'Ireland'),
    vatNumber: c.vatNumber ?? '',
    jobPosition: '',
    phone: c.phone ?? '',
    mobile: '',
    email: c.email ?? '',
    website: '',
    title: '',
    language: 'English (UK)',
    creditLimit: c.creditLimit != null ? String(c.creditLimit) : '0.00',
    tags: '',
    commissionRate: c.commissionRate != null ? String(Math.round(c.commissionRate * 100)) : '1.00',
    commissionFixed: '0.00',
    priceType: c.priceType === 'multi' ? 'Multi Price' : c.priceType === 'last' ? 'Last Purchase Price' : 'Default Price',
    isCustomer: true,
    salesperson: (cAny.salesUserId ?? '') as string,
    salesTeam: '',
    paymentTerm: c.paymentTerm ?? '',
    pricelistIds: (c.pricelists ?? []).slice().sort((a, b) => a.sequence - b.sequence).map(p => p.pricelistId),
    defaultDriverSlotId: (cAny.defaultDriverSlotId ?? '') as string,
    isVendor: false,
    supplierPaymentTerm: '',
    supplierCurrency: '',
    internalReference: '',
    barcode: '',
    fiscalPosition: '',
    notes: c.notes ?? '',
    externalNote: c.externalNote ?? '',
  }
}

// ─── Tiny helpers ─────────────────────────────────────────────────────────────

const inputCls = [
  'w-full border border-gray-300 rounded px-2 py-1 text-sm text-gray-800 bg-white',
  'hover:border-gray-400 focus:border-[#875A7B] focus:outline-none transition-colors',
].join(' ')

const selectCls = [
  'w-full border border-gray-300 rounded px-2 py-1 text-sm text-gray-800 bg-white',
  'hover:border-gray-400 focus:border-[#875A7B] focus:outline-none transition-colors cursor-pointer',
].join(' ')

function OdooField({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex items-start py-0.5">
      <span className={`flex-shrink-0 text-sm text-gray-600 pt-1.5 pr-3 ${wide ? 'w-52' : 'w-44'}`}>{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-sm font-semibold mb-2" style={{ color: '#875A7B' }}>{children}</h3>
  )
}

// ─── Tab definition ───────────────────────────────────────────────────────────

type Tab = 'contacts' | 'notes' | 'sales' | 'invoicing' | 'specialprices' | 'cards' | 'usedcards' | 'rechargedcards' | 'giftcards' | 'wallet' | 'creditdebit'

const ALL_TABS: { key: Tab; label: string }[] = [
  { key: 'contacts',     label: 'Contacts & Addresses' },
  { key: 'notes',        label: 'Internal Notes' },
  { key: 'sales',        label: 'Sales & Purchases' },
  { key: 'invoicing',    label: 'Invoicing' },
  { key: 'specialprices', label: 'Special Prices' },
  { key: 'cards',        label: 'Cards' },
  { key: 'usedcards',    label: 'Used Cards' },
  { key: 'rechargedcards', label: 'Recharged Cards' },
  { key: 'giftcards',   label: 'Exchange Gift Card History' },
  { key: 'wallet',       label: 'Wallet' },
  { key: 'creditdebit',  label: 'Credit/Debit' },
]

// ─── Stat Badge ───────────────────────────────────────────────────────────────

function StatBadge({
  value, label, color, icon,
}: { value: string; label: string; color?: string; icon?: React.ReactNode }) {
  return (
    <button className="flex flex-col items-center justify-center px-3 py-2 rounded hover:bg-gray-50 transition-colors min-w-[72px] border border-gray-100">
      <div className="flex items-center gap-1">
        {icon && <span className="text-xs" style={{ color: color ?? '#875A7B' }}>{icon}</span>}
        <span className="text-sm font-semibold" style={{ color: color ?? '#875A7B' }}>{value}</span>
      </div>
      <span className="text-[11px] text-gray-500 mt-0.5 text-center leading-tight">{label}</span>
    </button>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function ClassicCustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const isNew = id === 'new'

  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale

  const [form, setForm] = useState<FormState>(emptyForm())
  const [original, setOriginal] = useState<Customer | null>(null)
  const [pricelists, setPricelists] = useState<OdooPricelist[]>([])
  const [products, setProducts] = useState<ProductOption[]>([])
  const [specialPrices, setSpecialPrices] = useState<CustomerSpecialPrice[]>([])
  const [showSPDialog, setShowSPDialog] = useState(false)
  const [editingSP, setEditingSP] = useState<CustomerSpecialPrice>(EMPTY_SP)
  const [editingSPIdx, setEditingSPIdx] = useState<number | null>(null)
  const [salesUsers, setSalesUsers] = useState<{ id: string; name: string }[]>([])
  const [driverSlots, setDriverSlots] = useState<{ id: string; driverName: string; timeOfDay: string; batchNum: number }[]>([])
  const [activeTab, setActiveTab] = useState<Tab>('contacts')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(!isNew)
  const [dirty, setDirty] = useState(isNew)
  const [createdTime] = useState(() => new Date())

  function setField<K extends keyof FormState>(key: K, val: FormState[K]) {
    setForm(f => ({ ...f, [key]: val }))
    setDirty(true)
  }

  useEffect(() => {
    apiGet<OdooPricelist[]>('/api/pricelists')
      .then(d => setPricelists(d.filter(p => p.active)))
      .catch(() => {})

    apiGet<{ id: string; name: string; email: string; roles: string[] }[]>('/api/users?role=SALES')
      .then(users => setSalesUsers(users.map(u => ({ id: u.id, name: u.name || u.email }))))
      .catch(() => {})

    apiGet<{ id: string; driverName: string; timeOfDay: string; batchNum: number }[]>('/api/driver-slots')
      .then(setDriverSlots)
      .catch(() => {})

    apiGet<{ data?: ProductOption[]; items?: ProductOption[] } | ProductOption[]>('/api/products?pageSize=500')
      .then(resp => {
        const raw: ProductOption[] = Array.isArray(resp)
          ? resp
          : ((resp as { data?: ProductOption[] }).data ?? (resp as { items?: ProductOption[] }).items ?? [])
        setProducts(raw)
      })
      .catch(() => {})

    if (!isNew) {
      setLoading(true)
      apiGet<Customer & { specialPrices?: CustomerSpecialPrice[] }>(`/api/customers/${id}`)
        .then(c => {
          setOriginal(c)
          setForm(customerToForm(c))
          setSpecialPrices(c.specialPrices ?? [])
          setLoading(false)
        })
        .catch(() => { toast.error(isEn ? 'Failed to load customer' : '加载客户信息失败'); router.push(`${prefix}/classic/operator/customers`) })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  async function handleSave() {
    if (saving) return
    if (!form.name.trim()) { toast.error(isEn ? 'Customer name is required' : '客户名称不能为空'); return }

    const creditLimit = form.creditLimit !== '' ? Number(form.creditLimit) : undefined
    const commissionRate = form.commissionRate !== '' ? Number(form.commissionRate) / 100 : undefined

    const priceTypeMap: Record<string, 'multi' | 'default' | 'last'> = {
      'Multi Price': 'multi',
      'Default Price': 'default',
      'Last Purchase Price': 'last',
    }

    // 地址相关字段拆分独立保存（修复 Bug #3B：street2 不再被合并到 address）
    const street = form.street.trim()
    const street2 = form.street2.trim()
    const state = form.state.trim()
    const zip = form.zip.trim()
    const country = form.country.trim()
    // address 仍然保留：作为后端 / 旧屏幕的"展示用合并地址"
    // 但新前端不再读取这个字段做拆分——它由我们自动维护
    const composedAddress = [street, street2, [form.city.trim(), state, zip].filter(Boolean).join(' '), country]
      .filter(Boolean)
      .join(', ')

    const fields = {
      name: form.name.trim(),
      address: composedAddress,
      street,
      street2,
      state,
      zip,
      country,
      city: form.city.trim() || undefined,
      phone: form.phone.trim(),
      email: form.email.trim(),
      vatNumber: form.vatNumber.trim().toUpperCase(),
      paymentTerm: form.paymentTerm || 'monthly',
      pricelistIds: form.pricelistIds,
      creditLimit,
      commissionRate,
      notes: form.notes.trim() || undefined,
      externalNote: form.externalNote.trim() || undefined,
      priceType: priceTypeMap[form.priceType] ?? 'default',
      salesUserId: form.salesperson || null,
      defaultDriverSlotId: form.defaultDriverSlotId || null,
      specialPrices,
    }

    setSaving(true)
    try {
      if (isNew) {
        const created = await apiPost<Customer>('/api/customers', { ...fields, createdAt: new Date().toISOString() })
        toast.success(isEn ? 'Customer created' : '客户已创建')
        router.replace(`${prefix}/classic/operator/customers/${created.id}`)
      } else {
        await apiPut(`/api/customers/${id}`, { ...original, ...fields })
        toast.success(isEn ? 'Saved successfully' : '保存成功')
        setDirty(false)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : (isEn ? 'Save failed' : '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  // ─── Special Prices helpers ──────────────────────────────────────────────────
  function openAddSP() {
    setEditingSP(EMPTY_SP)
    setEditingSPIdx(null)
    setShowSPDialog(true)
  }

  function openEditSP(sp: CustomerSpecialPrice, idx: number) {
    setEditingSP({ ...sp })
    setEditingSPIdx(idx)
    setShowSPDialog(true)
  }

  function removeSP(idx: number) {
    setSpecialPrices(prev => prev.filter((_, i) => i !== idx))
    setDirty(true)
  }

  function saveSPDialog() {
    if (!editingSP.productId || editingSP.fixedPrice == null) {
      toast.error(isEn ? 'Please fill in product and fixed price' : '请填写商品和固定价格')
      return
    }
    setSpecialPrices(prev => {
      const next = [...prev]
      if (editingSPIdx === null) {
        next.push(editingSP)
      } else {
        next[editingSPIdx] = editingSP
      }
      return next
    })
    setDirty(true)
    setShowSPDialog(false)
  }

  function handleDiscard() {
    if (isNew) {
      // 新建场景：直接退出回列表
      router.push(`${prefix}/classic/operator/customers`)
      return
    }
    if (!original) {
      // 数据还没加载完就点了，给点反馈
      toast.info(isEn ? 'Data is still loading, please try again shortly' : '数据还在加载中，请稍候再试')
      return
    }
    if (dirty) {
      // 有未保存改动 → 还原到服务端最新值，并提示
      setForm(customerToForm(original))
      setSpecialPrices(original.specialPrices ?? [])
      setDirty(false)
      toast.success(isEn ? 'Unsaved changes discarded' : '未保存的修改已撤销')
    } else {
      // 没有改动时，跳回列表（让按钮一定有可见反馈）
      router.push(`${prefix}/classic/operator/customers`)
    }
  }

  const isActive = isNew ? true : (original?.isActive !== false)

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-400 text-sm">Loading...</div>
    )
  }

  return (
    <div className="min-h-screen" style={{ background: '#f5f5f5' }}>

      {/* ── Control Panel ────────────────────────────────────────────────────── */}
      <div className="bg-white border-b border-gray-200">
        {/* Breadcrumb */}
        <div className="px-5 pt-2.5 pb-0.5 text-sm flex items-center gap-1">
          <button
            onClick={() => router.push(`${prefix}/classic/operator/customers`)}
            className="hover:underline transition-colors text-sm"
            style={{ color: '#875A7B' }}
          >
            Contacts
          </button>
          <span className="text-gray-400 mx-1">/</span>
          <span className="text-gray-700 text-sm">{isNew ? 'New' : (form.name || id)}</span>
        </div>

        {/* Buttons row */}
        <div className="px-5 py-2 flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="h-8 px-5 text-sm font-medium rounded border transition-colors"
            style={{ background: '#875A7B', borderColor: '#875A7B', color: 'white' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#7a5070' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#875A7B' }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={handleDiscard}
            disabled={saving}
            className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Discard
          </button>
        </div>
      </div>

      {/* ── Archived banner ──────────────────────────────────────────────────── */}
      {!isNew && !isActive && (
        <div className="mx-auto mt-3 px-5 py-2 flex items-center gap-2 text-sm font-medium"
          style={{ background: '#fef3c7', color: '#92400e', borderBottom: '1px solid #fcd34d' }}
        >
          ⚠️ {isEn ? 'This customer is archived and will not appear in the regular list.' : '该客户已归档，不会出现在常规列表中。'}
        </div>
      )}

      {/* ── Main card ────────────────────────────────────────────────────────── */}
      <div className="mt-4 mx-auto bg-white rounded shadow-sm overflow-hidden" style={{ maxWidth: 1060 }}>

        {/* ── Card header: avatar | name area | stat badges ─────────────────── */}
        <div className="px-6 pt-5 pb-4">
          <div className="flex gap-5">

            {/* Avatar */}
            <div
              className="w-20 h-20 rounded flex-shrink-0 flex flex-col items-center justify-center cursor-pointer border border-dashed border-gray-300 hover:border-gray-400 transition-colors"
              style={{ background: '#f8f8f8' }}
            >
              {/* Camera + plus icon */}
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                <rect x="3" y="8" width="22" height="16" rx="2" stroke="#aaa" strokeWidth="1.5"/>
                <circle cx="14" cy="16" r="4.5" stroke="#aaa" strokeWidth="1.5"/>
                <path d="M10 8l1.5-3h5L18 8" stroke="#aaa" strokeWidth="1.5" strokeLinejoin="round"/>
                <path d="M20 12h2M21 11v2" stroke="#aaa" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <span className="text-[11px] text-gray-400 mt-1">+</span>
            </div>

            {/* Name + radio + sage account */}
            <div className="flex-1 min-w-0">
              {/* Individual / Company radio */}
              <div className="flex items-center gap-4 mb-2">
                <label className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-600">
                  <input type="radio" name="type" value="individual"
                    checked={form.individualOrCompany === 'individual'}
                    onChange={() => setField('individualOrCompany', 'individual')}
                    className="accent-[#875A7B]"
                  /> Individual
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer text-sm text-gray-600">
                  <input type="radio" name="type" value="company"
                    checked={form.individualOrCompany === 'company'}
                    onChange={() => setField('individualOrCompany', 'company')}
                    className="accent-[#875A7B]"
                  /> Company
                </label>
              </div>

              {/* Name input */}
              <input
                type="text"
                value={form.name}
                onChange={e => setField('name', e.target.value)}
                placeholder="Name"
                className="w-full text-xl font-semibold rounded px-2 py-1.5 focus:outline-none focus:border-[#875A7B] border border-transparent transition-colors"
                style={{ background: '#e8e0f0', color: '#333' }}
                onFocus={e => (e.currentTarget.style.borderColor = '#875A7B')}
                onBlur={e => (e.currentTarget.style.borderColor = 'transparent')}
              />

              {/* Sage Account label */}
              <div className="mt-1.5 ml-2 text-sm text-gray-600 font-medium">Sage Account:</div>

              {/* Company dropdown */}
              <div className="mt-1">
                <select
                  value={form.companyName}
                  onChange={e => setField('companyName', e.target.value)}
                  className="border border-gray-300 rounded px-2 py-1 text-sm text-gray-700 bg-white focus:outline-none focus:border-[#875A7B] w-48"
                >
                  <option value="">Company</option>
                </select>
              </div>
            </div>

            {/* Stat badges top-right */}
            <div className="flex-shrink-0">
              {/* Row 1: Opportunities | Meetings | Sales */}
              <div className="flex gap-1 mb-1">
                <StatBadge
                  icon={<StarIcon />}
                  value="0"
                  label="Opportunities"
                />
                <StatBadge
                  icon={<CalendarIcon />}
                  value="0"
                  label="Meetings"
                />
                <StatBadge
                  icon={<DollarIcon />}
                  value="0"
                  label="Sales"
                />
              </div>
              {/* Row 2: Invoiced | Analytic */}
              <div className="flex gap-1 mb-1">
                <StatBadge
                  icon={<InvoiceIcon />}
                  value="0.00"
                  label="Invoiced"
                />
                <StatBadge
                  icon={<AnalyticIcon />}
                  value="0"
                  label="Analytic Acc..."
                />
              </div>
              {/* Row 3: Unpublished | Active */}
              <div className="flex gap-1">
                <button className="flex items-center gap-1.5 px-3 py-2 rounded border border-gray-100 hover:bg-gray-50 text-[11px] font-medium" style={{ color: '#e84393' }}>
                  <GlobeIcon />
                  <span>Unpublished<br/>On Website</span>
                </button>
                <button
                  className="flex items-center gap-1.5 px-3 py-2 rounded border border-gray-100 hover:bg-gray-50 text-[11px] font-medium"
                  style={{ color: '#28a745' }}
                >
                  <span className="inline-block w-3 h-3 rounded-sm" style={{ background: '#28a745' }} />
                  Active
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-gray-100" />

        {/* ── Two-column main fields ────────────────────────────────────────── */}
        <div className="px-6 py-4 grid grid-cols-2 gap-x-10">

          {/* LEFT: Address + Tax ID */}
          <div>
            <OdooField label="Address">
              <input type="text" value={form.street} onChange={e => setField('street', e.target.value)}
                className={inputCls} placeholder="Street..." />
            </OdooField>
            <OdooField label="">
              <input type="text" value={form.street2} onChange={e => setField('street2', e.target.value)}
                className={inputCls} placeholder="Street 2..." />
            </OdooField>
            <OdooField label="">
              <div className="flex gap-1">
                <input type="text" value={form.city} onChange={e => setField('city', e.target.value)}
                  className={inputCls} placeholder="City" />
                <select value={form.state} onChange={e => setField('state', e.target.value)}
                  className={`${selectCls} w-28`}>
                  <option value="">State</option>
                </select>
                <input type="text" value={form.zip} onChange={e => setField('zip', e.target.value)}
                  className={`${inputCls} w-24`} placeholder="ZIP" />
              </div>
            </OdooField>
            <OdooField label="">
              <select value={form.country} onChange={e => setField('country', e.target.value)}
                className={selectCls}>
                <option value="">Country</option>
                <option value="Ireland">Ireland</option>
                <option value="United Kingdom">United Kingdom</option>
                <option value="France">France</option>
                <option value="Germany">Germany</option>
                <option value="China">China</option>
                <option value="United States">United States</option>
              </select>
            </OdooField>

            <div className="mt-3">
              <OdooField label="Tax ID">
                <input type="text" value={form.vatNumber} onChange={e => setField('vatNumber', e.target.value.toUpperCase())}
                  className={inputCls} placeholder="e.g. BE0477472701" />
              </OdooField>
            </div>
          </div>

          {/* RIGHT: other fields */}
          <div>
            {form.individualOrCompany === 'individual' && (
              <OdooField label="Job Position">
                <input type="text" value={form.jobPosition} onChange={e => setField('jobPosition', e.target.value)}
                  className={inputCls} placeholder="e.g. Sales Director" />
              </OdooField>
            )}
            <OdooField label="Phone">
              <input type="tel" value={form.phone} onChange={e => setField('phone', e.target.value)}
                className={inputCls} />
            </OdooField>
            <OdooField label="Mobile">
              <input type="tel" value={form.mobile} onChange={e => setField('mobile', e.target.value)}
                className={inputCls} />
            </OdooField>
            <OdooField label="Email">
              <input type="email" value={form.email} onChange={e => setField('email', e.target.value)}
                className={inputCls} />
            </OdooField>
            <OdooField label="Website">
              <input type="url" value={form.website} onChange={e => setField('website', e.target.value)}
                className={inputCls} placeholder="e.g. https://www.odoo.com" />
            </OdooField>
            {form.individualOrCompany === 'individual' && (
              <OdooField label="Title">
                <select value={form.title} onChange={e => setField('title', e.target.value)} className={selectCls}>
                  <option value=""></option>
                  <option value="Mr.">Mr.</option>
                  <option value="Mrs.">Mrs.</option>
                  <option value="Ms.">Ms.</option>
                  <option value="Dr.">Dr.</option>
                  <option value="Prof.">Prof.</option>
                </select>
              </OdooField>
            )}
            <OdooField label="Language">
              <select value={form.language} onChange={e => setField('language', e.target.value)} className={selectCls}>
                <option value="English (UK)">English (UK)</option>
                <option value="English (US)">English (US)</option>
                <option value="Chinese (Simplified)">Chinese (Simplified)</option>
                <option value="French">French</option>
                <option value="German">German</option>
              </select>
            </OdooField>
            <OdooField label="Credit Limit">
              <NumericInput min={0} value={form.creditLimit} onChange={e => setField('creditLimit', e.target.value)}
                className={inputCls} placeholder="0.00" />
            </OdooField>
            <OdooField label="Remaining Reservation Credit Limit">
              <span className="block px-2 py-1 text-sm text-gray-700">0.00</span>
            </OdooField>
            <OdooField label="Tags">
              <input type="text" value={form.tags} onChange={e => setField('tags', e.target.value)}
                className={inputCls} placeholder="Tags..." />
            </OdooField>
            <OdooField label="Commission Rate">
              <NumericInput min={0} max={100} value={form.commissionRate} onChange={e => setField('commissionRate', e.target.value)}
                className={inputCls} placeholder="1.00" />
            </OdooField>
            <OdooField label="Commission Fixed">
              <NumericInput min={0} value={form.commissionFixed} onChange={e => setField('commissionFixed', e.target.value)}
                className={inputCls} placeholder="0.00" />
            </OdooField>
            <OdooField label="Price Type">
              <select value={form.priceType} onChange={e => setField('priceType', e.target.value)} className={selectCls}>
                <option value="Multi Price">{isEn ? 'Multi Price (uses pricelist)' : 'Multi Price（走价格表）'}</option>
                <option value="Default Price">{isEn ? 'Default Price (uses list price)' : 'Default Price（用牌价）'}</option>
                <option value="Last Purchase Price">{isEn ? 'Last Purchase Price (last deal price)' : 'Last Purchase Price（上次成交价）'}</option>
              </select>
            </OdooField>
          </div>
        </div>

        {/* ── Tab bar ──────────────────────────────────────────────────────────── */}
        <div className="border-t border-gray-200 overflow-x-auto">
          <div className="flex" style={{ background: '#fafafa', minWidth: 'max-content' }}>
            {ALL_TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap"
                style={{
                  borderBottomColor: activeTab === t.key ? '#875A7B' : 'transparent',
                  color: activeTab === t.key ? '#875A7B' : '#6b7280',
                  background: activeTab === t.key ? '#fff' : 'transparent',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Tab content ──────────────────────────────────────────────────────── */}
        <div className="px-6 py-5 min-h-[180px]">

          {/* Contacts & Addresses */}
          {activeTab === 'contacts' && (
            <div>
              <button
                className="h-7 px-3 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
                onClick={() => toast.info(isEn ? 'Contacts feature coming soon' : '联系人功能即将推出')}
              >
                Add
              </button>
              <p className="mt-3 text-sm text-gray-400">No additional contacts or addresses.</p>
            </div>
          )}

          {/* Internal Notes + External Note */}
          {activeTab === 'notes' && (
            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Internal Notes</label>
                <p className="text-xs text-gray-400 mb-1.5">{isEn ? 'Internal use only, not printed for the customer' : '仅内部可见，不会打印给客户'}</p>
                <textarea
                  value={form.notes}
                  onChange={e => setField('notes', e.target.value)}
                  rows={5}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-700 focus:outline-none focus:border-[#875A7B] resize-none"
                  placeholder="Internal notes..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{isEn ? 'External Note / Customer-facing Note' : 'External Note / 客户外部备注'}</label>
                <p className="text-xs text-gray-400 mb-1.5">{isEn ? 'Visible to the customer, printed on this customer\'s quotations and delivery notes (e.g. receiving instructions, payment terms, back-door code, etc.)' : '客户可见，会打印在该客户的报价单和送货单上（如收货注意事项、结算方式、后门密码等）'}</p>
                <textarea
                  value={form.externalNote}
                  onChange={e => setField('externalNote', e.target.value)}
                  rows={4}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm text-gray-700 focus:outline-none focus:border-[#875A7B] resize-none"
                  placeholder={isEn ? 'e.g. Speaks Cantonese; cash payment; back-door code 1234…' : '例如：讲广东话；现金结算；后门密码 1234…'}
                />
              </div>
            </div>
          )}

          {/* Sales & Purchases */}
          {activeTab === 'sales' && (
            <div className="grid grid-cols-2 gap-x-12">

              {/* Left column: Sales + Misc */}
              <div>
                <SectionTitle>Sales</SectionTitle>
                <OdooField label="Is a Customer">
                  <div className="flex items-center h-8">
                    <input type="checkbox" checked={form.isCustomer}
                      onChange={e => setField('isCustomer', e.target.checked)}
                      className="accent-[#875A7B] w-4 h-4" />
                  </div>
                </OdooField>
                <OdooField label="Salesperson">
                  <select value={form.salesperson} onChange={e => setField('salesperson', e.target.value)} className={selectCls}>
                    <option value=""></option>
                    {salesUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </OdooField>
                <OdooField label="Default Driver">
                  <select value={form.defaultDriverSlotId} onChange={e => setField('defaultDriverSlotId', e.target.value)} className={selectCls}>
                    <option value=""></option>
                    {driverSlots.map(s => <option key={s.id} value={s.id}>{s.driverName} ({s.timeOfDay} #{s.batchNum})</option>)}
                  </select>
                </OdooField>
                <OdooField label="Sales Team">
                  <select value={form.salesTeam} onChange={e => setField('salesTeam', e.target.value)} className={selectCls}>
                    <option value=""></option>
                  </select>
                </OdooField>
                <OdooField label="Payment Terms">
                  <select value={form.paymentTerm} onChange={e => setField('paymentTerm', e.target.value)} className={selectCls}>
                    <option value=""></option>
                    <option value="cash">Immediate Payment</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </OdooField>
                <OdooField label="Pricelists" wide>
                  <div className="space-y-1">
                    {form.pricelistIds.length === 0 && (
                      <p className="text-xs text-gray-400 py-1">{isEn ? 'No pricelist assigned' : '未挂载价格表'}</p>
                    )}
                    {form.pricelistIds.map((plId, idx) => {
                      const pl = pricelists.find(p => p.id === plId)
                      return (
                        <div key={plId} className="flex items-center gap-2 border border-gray-200 rounded px-2 py-1">
                          <span className="text-xs text-gray-400 w-4 text-right">{idx + 1}</span>
                          <span className="flex-1 text-sm text-gray-800 truncate">{pl?.name ?? plId}</span>
                          <button
                            type="button"
                            disabled={idx === 0}
                            onClick={() => {
                              const next = [...form.pricelistIds]
                              ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
                              setField('pricelistIds', next)
                            }}
                            className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-gray-800 disabled:opacity-30 disabled:cursor-not-allowed"
                            title={isEn ? 'Move up (higher priority)' : '上移（优先级更高）'}
                          >↑</button>
                          <button
                            type="button"
                            disabled={idx === form.pricelistIds.length - 1}
                            onClick={() => {
                              const next = [...form.pricelistIds]
                              ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
                              setField('pricelistIds', next)
                            }}
                            className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-gray-800 disabled:opacity-30 disabled:cursor-not-allowed"
                            title={isEn ? 'Move down (lower priority)' : '下移（优先级更低）'}
                          >↓</button>
                          <button
                            type="button"
                            onClick={() => setField('pricelistIds', form.pricelistIds.filter(id => id !== plId))}
                            className="w-6 h-6 flex items-center justify-center text-gray-300 hover:text-red-500"
                            title={isEn ? 'Remove' : '移除'}
                          >×</button>
                        </div>
                      )
                    })}
                    <select
                      value=""
                      onChange={e => {
                        const val = e.target.value
                        if (val && !form.pricelistIds.includes(val)) {
                          setField('pricelistIds', [...form.pricelistIds, val])
                        }
                      }}
                      className={selectCls}
                    >
                      <option value="">{isEn ? '+ Add a pricelist…' : '+ 添加价格表…'}</option>
                      {pricelists.filter(pl => !form.pricelistIds.includes(pl.id)).map(pl => (
                        <option key={pl.id} value={pl.id}>{pl.name}</option>
                      ))}
                    </select>
                  </div>
                </OdooField>

                <div className="mt-5">
                  <SectionTitle>Misc</SectionTitle>
                  <OdooField label="Internal Reference">
                    <input type="text" value={form.internalReference} onChange={e => setField('internalReference', e.target.value)}
                      className={inputCls} />
                  </OdooField>
                  <OdooField label="Barcode">
                    <input type="text" value={form.barcode} onChange={e => setField('barcode', e.target.value)}
                      className={inputCls} />
                  </OdooField>
                </div>
              </div>

              {/* Right column: Purchase + Fiscal + Loyalty */}
              <div>
                <SectionTitle>Purchase</SectionTitle>
                <OdooField label="Is a Vendor">
                  <div className="flex items-center h-8">
                    <input type="checkbox" checked={form.isVendor}
                      onChange={e => setField('isVendor', e.target.checked)}
                      className="accent-[#875A7B] w-4 h-4" />
                  </div>
                </OdooField>
                <OdooField label="Payment Terms">
                  <select value={form.supplierPaymentTerm} onChange={e => setField('supplierPaymentTerm', e.target.value)} className={selectCls}>
                    <option value=""></option>
                    <option value="immediate">Immediate Payment</option>
                    <option value="30days">Net 30 Days</option>
                  </select>
                </OdooField>
                <OdooField label="Supplier Currency">
                  <select value={form.supplierCurrency} onChange={e => setField('supplierCurrency', e.target.value)} className={selectCls}>
                    <option value=""></option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                    <option value="USD">USD</option>
                  </select>
                </OdooField>

                <div className="mt-5">
                  <SectionTitle>Fiscal Information</SectionTitle>
                  <OdooField label="Fiscal Position">
                    <select value={form.fiscalPosition} onChange={e => setField('fiscalPosition', e.target.value)} className={selectCls}>
                      <option value=""></option>
                    </select>
                  </OdooField>
                </div>

                <div className="mt-5">
                  <SectionTitle>Loyalty</SectionTitle>
                  <OdooField label="Remaining Loyalty Points">
                    <span className="block px-2 py-1 text-sm text-gray-700">0.00</span>
                  </OdooField>
                  <OdooField label="Points to Amount">
                    <span className="block px-2 py-1 text-sm text-gray-700">0.00</span>
                  </OdooField>
                  <OdooField label="Total Loyalty Points">
                    <span className="block px-2 py-1 text-sm text-gray-700">0.00</span>
                  </OdooField>
                  <OdooField label="Send Loyalty Mail">
                    <div className="flex items-center h-8">
                      <input type="checkbox" defaultChecked className="accent-[#875A7B] w-4 h-4" />
                    </div>
                  </OdooField>
                </div>
              </div>
            </div>
          )}

          {/* Invoicing */}
          {activeTab === 'invoicing' && (
            <p className="text-sm text-gray-400">Invoicing settings and fiscal information.</p>
          )}

          {/* Special Prices */}
          {activeTab === 'specialprices' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">
                    {isEn
                      ? 'Customer-specific pricing — highest priority, overrides pricelist rules and the product list price. Matched exactly by product + minimum order quantity.'
                      : '客户专属定价——最高优先级，覆盖价格表规则和商品牌价。按商品 + 最小起订量精确匹配。'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={openAddSP}
                  className="h-7 px-4 text-xs rounded border font-medium transition-colors"
                  style={{ background: '#875A7B', borderColor: '#875A7B', color: 'white' }}
                >
                  Add a line
                </button>
              </div>

              {specialPrices.length === 0 ? (
                <div className="border border-dashed border-gray-300 rounded py-6 text-center text-sm text-gray-400">
                  No special prices configured
                </div>
              ) : (
                <table className="w-full text-sm border border-gray-200 rounded overflow-hidden">
                  <thead className="text-xs text-gray-500 bg-gray-50">
                    <tr>
                      <th className="text-left px-3 py-2">Product</th>
                      <th className="text-right px-3 py-2">Min. Qty</th>
                      <th className="text-right px-3 py-2">Fixed Price (€)</th>
                      <th className="text-left px-3 py-2">Date Range</th>
                      <th className="text-left px-3 py-2">Note</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {specialPrices.map((sp, idx) => {
                      const prod = products.find(p => p.id === sp.productId)
                      return (
                        <tr
                          key={idx}
                          className="hover:bg-[#875A7B]/20 cursor-pointer transition-colors"
                          onClick={() => openEditSP(sp, idx)}
                        >
                          <td className="px-3 py-2 font-medium">{prod?.name ?? sp.productId}</td>
                          <td className="px-3 py-2 text-right">{sp.minQty}</td>
                          <td className="px-3 py-2 text-right font-semibold" style={{ color: '#875A7B' }}>
                            €{Number(sp.fixedPrice).toFixed(2)}
                          </td>
                          <td className="px-3 py-2 text-gray-500 text-xs">
                            {sp.dateStart || sp.dateEnd
                              ? `${sp.dateStart ?? '∞'} → ${sp.dateEnd ?? '∞'}`
                              : 'Always'}
                          </td>
                          <td className="px-3 py-2 text-gray-500 text-xs">{sp.note ?? ''}</td>
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              onClick={e => { e.stopPropagation(); removeSP(idx) }}
                              className="text-red-400 hover:text-red-600 text-xs"
                            >
                              Delete
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Placeholder tabs */}
          {(activeTab === 'cards' || activeTab === 'usedcards' || activeTab === 'rechargedcards' || activeTab === 'giftcards' || activeTab === 'wallet' || activeTab === 'creditdebit') && (
            <p className="text-sm text-gray-400">No records found.</p>
          )}
        </div>
      </div>

      {/* ── Special Price Dialog ─────────────────────────────────────────────── */}
      {showSPDialog && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={() => setShowSPDialog(false)}
        >
          <div
            className="bg-white rounded-lg shadow-xl w-full max-w-md p-6 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="font-semibold text-gray-800" style={{ color: '#875A7B' }}>
              {editingSPIdx === null ? 'Add Special Price' : 'Edit Special Price'}
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-600 mb-1">Product *</label>
                <select
                  value={editingSP.productId}
                  onChange={e => setEditingSP(s => ({ ...s, productId: e.target.value }))}
                  className={selectCls}
                >
                  <option value="">— Select product —</option>
                  {products.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Fixed Price (€) *</label>
                <NumericInput
                  min={0} step={0.01}
                  value={editingSP.fixedPrice}
                  onChange={e => setEditingSP(s => ({ ...s, fixedPrice: parseFloat(e.target.value) || 0 }))}
                  className={inputCls}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Min. Quantity</label>
                <NumericInput
                  min={0} step={0.001}
                  value={editingSP.minQty}
                  onChange={e => setEditingSP(s => ({ ...s, minQty: parseFloat(e.target.value) || 0 }))}
                  className={inputCls}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Start Date</label>
                <input
                  type="date"
                  value={editingSP.dateStart ?? ''}
                  onChange={e => setEditingSP(s => ({ ...s, dateStart: e.target.value || undefined }))}
                  className={inputCls}
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">End Date</label>
                <input
                  type="date"
                  value={editingSP.dateEnd ?? ''}
                  onChange={e => setEditingSP(s => ({ ...s, dateEnd: e.target.value || undefined }))}
                  className={inputCls}
                />
              </div>

              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-600 mb-1">Note</label>
                <input
                  type="text"
                  value={editingSP.note ?? ''}
                  onChange={e => setEditingSP(s => ({ ...s, note: e.target.value || undefined }))}
                  placeholder="Optional note"
                  className={inputCls}
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowSPDialog(false)}
                className="h-8 px-4 text-sm font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveSPDialog}
                className="h-8 px-5 text-sm font-medium rounded border transition-colors"
                style={{ background: '#875A7B', borderColor: '#875A7B', color: 'white' }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Chatter ──────────────────────────────────────────────────────────── */}
      <div className="mt-4 mx-auto bg-white rounded shadow-sm" style={{ maxWidth: 1060 }}>
        {/* Chatter toolbar */}
        <div className="px-6 py-3 flex items-center justify-between border-b border-gray-100">
          <div className="flex items-center gap-4">
            <button className="text-sm font-medium text-gray-600 hover:text-gray-800 flex items-center gap-1.5 transition-colors">
              <span className="text-base">✉</span> Send message
            </button>
            <button className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1.5 transition-colors">
              <span className="text-base">📝</span> Log note
            </button>
            <button className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1.5 transition-colors">
              <span className="text-base">🕐</span> Schedule activity
            </button>
          </div>
          <div className="flex items-center gap-3 text-sm text-gray-400">
            <span>🔔 0</span>
            <button className="text-gray-600 hover:text-gray-800 font-medium transition-colors">Follow</button>
            <span>👤 0 ▾</span>
          </div>
        </div>

        {/* Log entries — 真实操作日志：谁 + 做了什么 + 时间（带字段级 diff） */}
        <div className="px-6 py-4">
          <ChatterFeed
            resource="customer"
            resourceId={isNew ? undefined : id}
            isNew={isNew}
            fallbackCreatedAt={createdTime.toISOString()}
            fallbackCreatedBy="Operator"
          />
        </div>
      </div>

      {/* bottom padding */}
      <div className="h-8" />
    </div>
  )
}

// ─── Inline SVG icons ─────────────────────────────────────────────────────────

function StarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
    </svg>
  )
}
function CalendarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  )
}
function DollarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
    </svg>
  )
}
function InvoiceIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/>
    </svg>
  )
}
function AnalyticIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>
    </svg>
  )
}
function GlobeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
    </svg>
  )
}
