'use client'
import React, { useState, useEffect, useRef, forwardRef } from 'react'

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>

/**
 * NumericInput — drop-in replacement for <input type="number"> that fixes:
 * 1. Cannot clear to empty: internal string state is guarded by focus ref,
 *    so parent's re-render (converting "" → 0) won't overwrite what the user
 *    is currently typing.
 * 2. Scroll wheel accidentally changes value: blur on wheel prevents it.
 */
export const NumericInput = forwardRef<HTMLInputElement, Props>(
  function NumericInput({ value, onChange, onBlur, onFocus, className, ...rest }, ref) {
    const [display, setDisplay] = useState(
      value !== undefined && value !== null && value !== '' ? String(value) : '',
    )
    const isFocused = useRef(false)

    // Sync from parent only when the field is not being edited
    useEffect(() => {
      if (!isFocused.current) {
        setDisplay(
          value !== undefined && value !== null && value !== '' ? String(value) : '',
        )
      }
    }, [value])

    return (
      <input
        ref={ref}
        type="number"
        value={display}
        onChange={e => {
          setDisplay(e.target.value)
          onChange?.(e)
        }}
        onFocus={e => {
          isFocused.current = true
          onFocus?.(e)
        }}
        onBlur={e => {
          isFocused.current = false
          onBlur?.(e)
        }}
        onWheel={e => e.currentTarget.blur()}
        className={`no-spinner ${className ?? ''}`}
        {...rest}
      />
    )
  },
)
