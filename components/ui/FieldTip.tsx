'use client'
import { useState, useRef, useEffect } from 'react'

interface FieldTipProps {
  tip: string
  className?: string
}

export default function FieldTip({ tip, className = '' }: FieldTipProps) {
  const [visible, setVisible] = useState(false)
  const [position, setPosition] = useState<'top' | 'bottom'>('top')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (visible && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      const spaceAbove = rect.top
      setPosition(spaceAbove < 80 ? 'bottom' : 'top')
    }
  }, [visible])

  // Close on outside click
  useEffect(() => {
    if (!visible) return
    function handleClick(e: MouseEvent) {
      if (
        triggerRef.current && !triggerRef.current.contains(e.target as Node) &&
        tipRef.current && !tipRef.current.contains(e.target as Node)
      ) {
        setVisible(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [visible])

  return (
    <span className={`relative inline-flex items-center ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setVisible(v => !v)}
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        aria-label="字段说明"
        className="w-4 h-4 rounded-full bg-gray-200 hover:bg-emerald-200 text-gray-500 hover:text-emerald-700 text-[10px] font-bold flex items-center justify-center transition-colors cursor-help shrink-0"
      >
        ?
      </button>

      {visible && (
        <div
          ref={tipRef}
          role="tooltip"
          className={`absolute z-50 left-1/2 -translate-x-1/2 w-56 bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-xl leading-relaxed pointer-events-none ${
            position === 'top'
              ? 'bottom-full mb-2'
              : 'top-full mt-2'
          }`}
        >
          {tip}
          {/* Arrow */}
          <span
            className={`absolute left-1/2 -translate-x-1/2 border-4 border-transparent ${
              position === 'top'
                ? 'top-full border-t-gray-900'
                : 'bottom-full border-b-gray-900'
            }`}
          />
        </div>
      )}
    </span>
  )
}
