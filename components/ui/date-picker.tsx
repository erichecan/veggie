"use client"

import * as React from "react"
import { format, isValid, parse } from "date-fns"
import { CalendarIcon, XIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

const DISPLAY_FORMAT = "dd/MM/yyyy"
const VALUE_FORMAT = "yyyy-MM-dd"
/** 严格校验「日/月/4 位年」的形状，date-fns 的 parse 本身对年份位数不设限
 *  （"1/1/26" 会被解析成公元 26 年而不是拒绝），必须在调用 parse 前先卡掉。 */
const STRICT_DMY = /^\d{1,2}\/\d{1,2}\/\d{4}$/

function toDate(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const parsed = parse(value, VALUE_FORMAT, new Date())
  return isValid(parsed) ? parsed : undefined
}

/**
 * 日期选择器：对外的 value/onChange 契约与原生 `<input type="date">` 完全一致
 * （yyyy-MM-dd 字符串），只是显示和录入固定按「日/月/年」（dd/MM/yyyy），
 * 不受浏览器/系统 locale 影响。支持直接键入数字或点击图标弹出日历两种方式。
 */
function DatePicker({
  value,
  onChange,
  min,
  max,
  disabled,
  placeholder = "dd/mm/yyyy",
  className,
  wrapperClassName,
  clearable = true,
  autoFocus,
  title,
  style,
  onKeyDown,
}: {
  value: string
  onChange: (value: string) => void
  min?: string
  max?: string
  disabled?: boolean
  placeholder?: string
  className?: string
  /** 应用在最外层容器上，用于在 flex/grid 布局里控制宽度（如 flex-1） */
  wrapperClassName?: string
  clearable?: boolean
  autoFocus?: boolean
  title?: string
  style?: React.CSSProperties
  /** 在本组件的 Enter 提交逻辑跑完之后再转发（用于订单行 Tab/Enter 跳格这类外部键盘导航） */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
}) {
  const selectedDate = toDate(value)
  const [text, setText] = React.useState(() =>
    selectedDate ? format(selectedDate, DISPLAY_FORMAT) : ""
  )
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    setText(selectedDate ? format(selectedDate, DISPLAY_FORMAT) : "")
  }, [value])

  /** 返回 true 代表值已经确定（清空或成功解析），false 代表输入非法、已回退——
   *  调用方（如行内 Tab/Enter 跳格）应该只在 true 时继续往下走，否则用户会在没意识到
   *  的情况下丢了刚打的日期还被跳去下一行。 */
  const commitText = (raw: string): boolean => {
    const trimmed = raw.trim()
    if (!trimmed) {
      onChange("")
      setText("")
      return true
    }
    if (!STRICT_DMY.test(trimmed)) {
      setText(selectedDate ? format(selectedDate, DISPLAY_FORMAT) : "")
      return false
    }
    const parsed = parse(trimmed, DISPLAY_FORMAT, new Date())
    if (isValid(parsed)) {
      onChange(format(parsed, VALUE_FORMAT))
      setText(format(parsed, DISPLAY_FORMAT))
      return true
    }
    // 输入无法解析（如 31/02）：回退到上一个合法值，不污染上游状态
    setText(selectedDate ? format(selectedDate, DISPLAY_FORMAT) : "")
    return false
  }

  const minDate = toDate(min)
  const maxDate = toDate(max)

  return (
    <div className={cn("relative inline-flex items-center", wrapperClassName)} title={title}>
      <input
        type="text"
        inputMode="numeric"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        style={style}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commitText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            if (!commitText((e.target as HTMLInputElement).value)) return
          }
          onKeyDown?.(e)
        }}
        className={cn(
          "pr-6 disabled:bg-gray-100 disabled:text-gray-400",
          className
        )}
      />
      {clearable && !disabled && text && (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => {
            onChange("")
            setText("")
          }}
          className="absolute right-6 text-gray-300 hover:text-gray-500"
          aria-label="清除日期"
        >
          <XIcon className="size-3" />
        </button>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          disabled={disabled}
          className="absolute right-1.5 text-gray-400 hover:text-gray-600 disabled:pointer-events-none disabled:opacity-40"
          aria-label="打开日历"
        >
          <CalendarIcon className="size-3.5" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            mode="single"
            selected={selectedDate}
            defaultMonth={selectedDate}
            onSelect={(date) => {
              if (date) {
                onChange(format(date, VALUE_FORMAT))
                setText(format(date, DISPLAY_FORMAT))
              }
              setOpen(false)
            }}
            disabled={[
              ...(minDate ? [{ before: minDate }] : []),
              ...(maxDate ? [{ after: maxDate }] : []),
            ]}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}

export { DatePicker }
