'use client'
/**
 * DynamicForm —— 轻量配置化表单组件
 * ============================================================================
 * 为什么自研而非用 react-hook-form / formik？
 *   1. 沙箱无法新增 npm 依赖
 *   2. 我们需要非常简单的模型：值 + 错误 + 条件显示 + 校验，不需要复杂字段数组
 *   3. 与 Prisma 生成的 Customer/Product 类型天然契合（Record<string, unknown>）
 *
 * 核心能力：
 *   - 支持 15+ 种字段类型（text/number/select/checkbox/textarea/date/radio/...）
 *   - 支持 Tab 布局 + 两列布局（col: 'left' | 'right' | 'full'）
 *   - 支持条件渲染（visible(values) => boolean）
 *   - 前端级校验（required / min / max / pattern / 自定义 validate）
 *   - 不依赖任何外部 state 库，受控 value + onChange
 *   - 首次 onBlur 才显示错误；submit 时全部字段触发校验
 *
 * 用法：
 *   const schema: FormSchema = {
 *     header: [...],
 *     tabs: [
 *       { id: 'contact', label: 'Contacts', fields: [...] },
 *     ],
 *   }
 *   <DynamicForm schema={schema} value={state} onChange={setState} onSubmit={save} />
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { NumberInput } from './number-input'

// ─── 类型 ─────────────────────────────────────────────────────────────────
export type FieldType =
  | 'text' | 'email' | 'tel' | 'password'
  | 'number' | 'decimal' | 'percent'
  | 'textarea' | 'select' | 'checkbox' | 'radio'
  | 'date' | 'datetime-local'
  | 'section-title' | 'divider' | 'hint'
  | 'readonly'        // 只读展示文本
  | 'custom'          // 完全自定义渲染

export type FormValues = Record<string, unknown>

export interface FieldOption {
  value: string
  label: string
}

export interface FieldConfig {
  type: FieldType
  /** 状态键（存/读 value 用）。`section-title` / `divider` / `hint` 可省略 */
  name?: string
  label?: string
  placeholder?: string
  required?: boolean
  disabled?: boolean
  /** 字段下方的提示文字 */
  hint?: string
  /** select / radio 的选项 */
  options?: FieldOption[]
  /** 数字字段 */
  min?: number
  max?: number
  step?: number | string
  /** 字符串字段 */
  maxLength?: number
  pattern?: string
  rows?: number  // textarea
  /** 自定义校验。返回错误信息或 null */
  validate?: (val: unknown, all: FormValues) => string | null
  /** 条件显示 */
  visible?: (all: FormValues) => boolean
  /** 栅格列：'left' | 'right' | 'full' */
  col?: 'left' | 'right' | 'full'
  /** custom 类型专用：自定义渲染函数 */
  render?: (args: {
    value: unknown
    onChange: (v: unknown) => void
    all: FormValues
    error: string | null
  }) => React.ReactNode
  /** readonly 展示的文本 */
  displayValue?: (all: FormValues) => string
}

export interface TabConfig {
  id: string
  label: string
  icon?: string
  fields: FieldConfig[]
  visible?: (all: FormValues) => boolean
}

export interface FormSchema {
  /** 顶部固定区域（如名称 + 状态勾选），不放在 tab 里 */
  header?: FieldConfig[]
  /** Tab 布局（与 fields 二选一） */
  tabs?: TabConfig[]
  /** 单页布局 */
  fields?: FieldConfig[]
}

// ─── 内部工具 ─────────────────────────────────────────────────────────────
function runValidate(field: FieldConfig, val: unknown, all: FormValues): string | null {
  // required
  if (field.required) {
    const isEmpty =
      val === undefined || val === null || val === '' ||
      (typeof val === 'number' && Number.isNaN(val))
    if (isEmpty) return `${field.label || field.name} 不能为空`
  }
  // custom validator
  if (field.validate) {
    const err = field.validate(val, all)
    if (err) return err
  }
  // number range
  if ((field.type === 'number' || field.type === 'decimal' || field.type === 'percent')
      && typeof val === 'number' && Number.isFinite(val)) {
    if (field.min !== undefined && val < field.min) return `不能小于 ${field.min}`
    if (field.max !== undefined && val > field.max) return `不能大于 ${field.max}`
  }
  // pattern
  if (field.pattern && typeof val === 'string' && val !== '') {
    const re = new RegExp(field.pattern)
    if (!re.test(val)) return `格式不正确`
  }
  // maxLength
  if (field.maxLength && typeof val === 'string' && val.length > field.maxLength) {
    return `长度不能超过 ${field.maxLength} 字符`
  }
  return null
}

function collectAllFields(schema: FormSchema): FieldConfig[] {
  const out: FieldConfig[] = []
  if (schema.header) out.push(...schema.header)
  if (schema.fields) out.push(...schema.fields)
  if (schema.tabs) for (const t of schema.tabs) out.push(...t.fields)
  return out.filter(f => f.name)
}

// ─── 主组件 ───────────────────────────────────────────────────────────────
export function DynamicForm({
  schema,
  value,
  onChange,
  errors: externalErrors,
  disabled = false,
  onSubmit,
}: {
  schema: FormSchema
  value: FormValues
  onChange: (v: FormValues) => void
  /** 父组件传入的服务端错误（保存后如果服务端返回字段级错误） */
  errors?: Record<string, string>
  disabled?: boolean
  /** 可选：提交钩子 */
  onSubmit?: () => void
}) {
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [activeTab, setActiveTab] = useState<string>(schema.tabs?.[0]?.id ?? '')

  // 计算所有字段的本地校验错误
  const localErrors = useMemo(() => {
    const errs: Record<string, string> = {}
    for (const f of collectAllFields(schema)) {
      if (!f.name) continue
      // visible=false 的字段不参与校验
      if (f.visible && !f.visible(value)) continue
      const err = runValidate(f, value[f.name], value)
      if (err) errs[f.name] = err
    }
    return errs
  }, [schema, value])

  // 合并本地 + 外部错误
  const allErrors = useMemo(
    () => ({ ...localErrors, ...(externalErrors ?? {}) }),
    [localErrors, externalErrors],
  )

  const setField = useCallback(
    (name: string, v: unknown) => {
      onChange({ ...value, [name]: v })
    },
    [value, onChange],
  )

  const markTouched = useCallback((name: string) => {
    setTouched((t) => (t[name] ? t : { ...t, [name]: true }))
  }, [])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    // 标记全部字段已 touched
    const all: Record<string, boolean> = {}
    for (const f of collectAllFields(schema)) if (f.name) all[f.name] = true
    setTouched(all)
    if (Object.keys(localErrors).length > 0) return
    onSubmit?.()
  }

  // ─── 渲染单个字段 ─────────────────────────────────────────────────────
  function renderField(field: FieldConfig, keyPrefix: string): React.ReactNode {
    if (field.visible && !field.visible(value)) return null

    // 非数据字段（标题、分隔等）
    if (field.type === 'section-title') {
      return (
        <div key={keyPrefix} className={`${colClass(field.col ?? 'full')} mt-2 mb-1`}>
          <h3 className="text-sm font-semibold text-gray-700 border-b pb-1">{field.label}</h3>
        </div>
      )
    }
    if (field.type === 'divider') {
      return <div key={keyPrefix} className={`${colClass(field.col ?? 'full')} border-t border-gray-100 my-3`} />
    }
    if (field.type === 'hint') {
      return (
        <div key={keyPrefix} className={`${colClass(field.col ?? 'full')} text-xs text-gray-500`}>
          {field.label}
        </div>
      )
    }

    if (!field.name) return null
    const name = field.name
    const val = value[name]
    const error = allErrors[name]
    const showErr = error && touched[name]

    const labelElem = field.label && (
      <label htmlFor={`df-${name}`} className="block text-xs font-medium text-gray-600 mb-1">
        {field.label}
        {field.required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
    )

    let control: React.ReactNode = null
    const isDisabled = disabled || field.disabled

    switch (field.type) {
      case 'text':
      case 'email':
      case 'tel':
      case 'password':
        control = (
          <input
            id={`df-${name}`}
            type={field.type}
            value={(val as string) ?? ''}
            onChange={(e) => setField(name, e.target.value)}
            onBlur={() => markTouched(name)}
            placeholder={field.placeholder}
            disabled={isDisabled}
            maxLength={field.maxLength}
            className={inputCls(!!showErr, isDisabled)}
          />
        )
        break

      case 'number':
      case 'decimal':
      case 'percent':
        control = (
          <NumberInput
            id={`df-${name}`}
            value={val as number | undefined}
            onChange={(n) => setField(name, Number.isFinite(n) ? n : undefined)}
            min={field.min}
            max={field.max}
            step={field.step ?? (field.type === 'percent' ? 0.001 : 'any')}
            placeholder={field.placeholder}
            disabled={isDisabled}
            nullable
            className={inputCls(!!showErr, isDisabled)}
          />
        )
        break

      case 'textarea':
        control = (
          <textarea
            id={`df-${name}`}
            value={(val as string) ?? ''}
            onChange={(e) => setField(name, e.target.value)}
            onBlur={() => markTouched(name)}
            rows={field.rows ?? 4}
            placeholder={field.placeholder}
            disabled={isDisabled}
            maxLength={field.maxLength}
            className={`${inputCls(!!showErr, isDisabled)} py-1.5`}
          />
        )
        break

      case 'select':
        control = (
          <select
            id={`df-${name}`}
            value={(val as string) ?? ''}
            onChange={(e) => { setField(name, e.target.value); markTouched(name) }}
            disabled={isDisabled}
            className={inputCls(!!showErr, isDisabled)}
          >
            <option value="">—</option>
            {(field.options ?? []).map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        )
        break

      case 'checkbox':
        control = (
          <label className="inline-flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              id={`df-${name}`}
              type="checkbox"
              checked={!!val}
              onChange={(e) => { setField(name, e.target.checked); markTouched(name) }}
              disabled={isDisabled}
              className="w-4 h-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
            />
            <span className="text-gray-700">{field.label}</span>
          </label>
        )
        return (
          <div key={keyPrefix} className={colClass(field.col ?? 'full')}>
            {control}
            {field.hint && <p className="text-xs text-gray-400 mt-0.5 ml-6">{field.hint}</p>}
          </div>
        )

      case 'radio':
        control = (
          <div className="flex items-center gap-4">
            {(field.options ?? []).map((opt) => (
              <label key={opt.value} className="inline-flex items-center gap-1.5 text-sm cursor-pointer">
                <input
                  type="radio"
                  name={name}
                  value={opt.value}
                  checked={val === opt.value}
                  onChange={() => { setField(name, opt.value); markTouched(name) }}
                  disabled={isDisabled}
                  className="w-4 h-4"
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        )
        break

      case 'date':
      case 'datetime-local':
        control = (
          <input
            id={`df-${name}`}
            type={field.type}
            value={(val as string) ?? ''}
            onChange={(e) => setField(name, e.target.value)}
            onBlur={() => markTouched(name)}
            disabled={isDisabled}
            className={inputCls(!!showErr, isDisabled)}
          />
        )
        break

      case 'readonly':
        control = (
          <div className="py-1.5 text-sm text-gray-700">
            {field.displayValue ? field.displayValue(value) : String(val ?? '—')}
          </div>
        )
        break

      case 'custom':
        control = field.render?.({
          value: val,
          onChange: (v) => setField(name, v),
          all: value,
          error: error ?? null,
        })
        break
    }

    return (
      <div key={keyPrefix} className={colClass(field.col ?? 'full')}>
        {labelElem}
        {control}
        {field.hint && <p className="text-xs text-gray-400 mt-0.5">{field.hint}</p>}
        {showErr && <p className="text-xs text-red-500 mt-0.5">{error}</p>}
      </div>
    )
  }

  // ─── 栅格布局：根据 col 决定单/双列 ─────────────────────────────
  function renderFieldGroup(fields: FieldConfig[], keyPrefix: string) {
    // 统计有没有 left/right 字段
    const hasCol = fields.some((f) => f.col === 'left' || f.col === 'right')
    if (!hasCol) {
      // 纯单列
      return (
        <div className="space-y-3">
          {fields.map((f, i) => renderField(f, `${keyPrefix}-${i}`))}
        </div>
      )
    }
    // 双列布局：full 字段占整行
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
        {fields.map((f, i) => renderField(f, `${keyPrefix}-${i}`))}
      </div>
    )
  }

  const visibleTabs = (schema.tabs ?? []).filter((t) => !t.visible || t.visible(value))

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {schema.header && schema.header.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-5">
          {renderFieldGroup(schema.header, 'header')}
        </div>
      )}

      {schema.tabs && schema.tabs.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="flex border-b border-gray-200 text-sm overflow-x-auto no-scrollbar">
            {visibleTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={`px-4 py-2.5 border-b-2 -mb-px font-medium whitespace-nowrap ${
                  activeTab === t.id
                    ? 'border-green-500 text-green-700 bg-green-50'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {t.icon && <span className="mr-1">{t.icon}</span>}
                {t.label}
              </button>
            ))}
          </div>
          {visibleTabs.map((t) => (
            <div key={t.id} className={`p-5 ${activeTab === t.id ? '' : 'hidden'}`}>
              {renderFieldGroup(t.fields, `tab-${t.id}`)}
            </div>
          ))}
        </div>
      )}

      {schema.fields && schema.fields.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-5">
          {renderFieldGroup(schema.fields, 'fields')}
        </div>
      )}

      {/* 外部提交：父组件自己提供按钮，submit 靠 form.onSubmit 触发 */}
    </form>
  )
}

// ─── 样式工具 ─────────────────────────────────────────────────────────────
function inputCls(error: boolean, disabled?: boolean): string {
  return [
    'w-full h-8 px-2 text-sm border rounded focus:outline-none',
    error ? 'border-red-400 focus:border-red-500' : 'border-gray-300 focus:border-green-500',
    disabled ? 'bg-gray-50 text-gray-500 cursor-not-allowed' : '',
  ].join(' ')
}

function colClass(col: 'left' | 'right' | 'full'): string {
  if (col === 'full') return 'md:col-span-2'
  return ''
}
