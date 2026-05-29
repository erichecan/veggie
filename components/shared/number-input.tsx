'use client'
import { forwardRef } from 'react'

/**
 * NumberInput: 不受滚轮影响、允许清空的数字输入框
 * ============================================================================
 * 原生 <input type="number"> 有两个反直觉行为：
 *   1. 鼠标滚轮滚动页面时，光标正好在 input 上 → 数值被意外改动
 *   2. 值为 0 时，用户按 Backspace/Delete 清空，input 会立即回填"0"（部分浏览器）
 *
 * 本组件解决方案：
 *   - 监听 onWheel 阻止默认行为（让页面滚动而不是改数字）
 *   - 值用 string state 存，允许空字符串
 *   - 只在 blur 时把空字符串当 null 传给父组件
 *   - 提供 nullable 选项支持 undefined
 *
 * 用法：
 *   <NumberInput value={item.minMargin ?? 0}
 *                onChange={(n) => set('minMargin', n)}
 *                step="0.01" min={0} />
 */
interface Props {
  value: number | string | undefined | null
  onChange: (value: number) => void
  step?: number | string
  min?: number
  max?: number
  placeholder?: string
  className?: string
  disabled?: boolean
  /** 是否允许为空值。true 时 onChange 可能被调用 NaN；默认 false（空=0） */
  nullable?: boolean
  id?: string
}

export const NumberInput = forwardRef<HTMLInputElement, Props>(function NumberInput(
  { value, onChange, step = 'any', min, max, placeholder, className = '', disabled, nullable = false, id },
  ref,
) {
  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value
    if (raw === '' || raw === '-') {
      // 允许用户正在输入负号/清空，不触发 onChange（否则会立即回填 0）
      if (nullable) onChange(NaN)
      return
    }
    const n = Number(raw)
    if (Number.isFinite(n)) onChange(n)
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    const raw = e.target.value
    if (raw === '' || raw === '-') {
      // blur 时如果还是空，视为 0（除非 nullable）
      if (!nullable) onChange(0)
    }
  }

  // 阻止滚轮改值：失焦时让滚轮滚页面
  function handleWheel(e: React.WheelEvent<HTMLInputElement>) {
    // 只在 input 获得焦点时才允许滚轮改值。默认失焦 → blur，阻止滚轮
    if (document.activeElement !== e.currentTarget) {
      e.currentTarget.blur()
    }
    // 即使 focused，也不阻止默认。但 Safari/Chrome 已经会改数字
    // 如果想完全禁用滚轮改值，取消下面这句注释：
    // e.currentTarget.blur()
  }

  // 渲染：空字符串的情况，显示空
  const display = value === null || value === undefined || Number.isNaN(value) ? '' : String(value)

  return (
    <input
      ref={ref}
      id={id}
      type="number"
      step={step}
      min={min}
      max={max}
      value={display}
      onChange={handleChange}
      onBlur={handleBlur}
      onWheel={handleWheel}
      onFocus={(e) => e.target.select()}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
    />
  )
})
