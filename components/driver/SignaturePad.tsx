'use client'
import { useRef, useEffect, useState, useCallback } from 'react'

/**
 * Sign on Glass —— 客户在司机手机屏上手写签名。
 *
 * 合同第二条把「支持客户电子签名（Sign on Glass）」写进配送模块，第四条又把
 * 「司机电子签收」写进验收闭环。此前系统只有拍照 POD，没有手写捕获。
 *
 * 实现取舍：
 * - 纯 Canvas + Pointer Events，不引第三方签名库。签名板是几十行的事，
 *   引库反而多一份供应链与 CSP 风险。
 * - Pointer Events 一套代码同时吃触屏、手写笔和鼠标，不用分别处理 touch/mouse。
 * - 导出 PNG data URI，与现有退货照片、POD 照片同一种存储方式（Trip.restaurants JSON），
 *   不额外引入对象存储依赖——迁到自有服务器时少一个要搬的东西。
 * - 画布按 devicePixelRatio 放大再缩回，否则高分屏上签名是糊的。
 */

interface Props {
  onChange: (dataUrl: string | null) => void
  /** 签名区高度，默认 180px。太矮了写不下名字 */
  height?: number
  disabled?: boolean
}

export default function SignaturePad({ onChange, height = 180, disabled = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const hasInk = useRef(false)
  /** 每一笔的点集，用于撤销上一笔——直接擦画布没法只撤一笔 */
  const strokes = useRef<Array<Array<{ x: number; y: number }>>>([])
  const current = useRef<Array<{ x: number; y: number }>>([])
  const [empty, setEmpty] = useState(true)

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.scale(dpr, dpr)
    ctx.lineWidth = 2.2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#111827'

    for (const stroke of strokes.current) {
      if (stroke.length === 0) continue
      ctx.beginPath()
      ctx.moveTo(stroke[0].x, stroke[0].y)
      // 单点也要画出来，否则点一下没痕迹
      if (stroke.length === 1) ctx.lineTo(stroke[0].x + 0.1, stroke[0].y + 0.1)
      else for (let i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x, stroke[i].y)
      ctx.stroke()
    }
  }, [])

  /** 尺寸随容器变化时要重设画布并重画，否则签名会被拉伸 */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
      redraw()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [redraw])

  function pointFrom(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function emit() {
    const canvas = canvasRef.current
    if (!canvas) return
    const next = hasInk.current ? canvas.toDataURL('image/png') : null
    setEmpty(!hasInk.current)
    onChange(next)
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return
    // 捕获指针：手指滑出画布再回来仍属同一笔
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = true
    current.current = [pointFrom(e)]
    strokes.current.push(current.current)
    hasInk.current = true
    redraw()
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || disabled) return
    current.current.push(pointFrom(e))
    redraw()
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    drawing.current = false
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* 已释放 */ }
    emit()
  }

  function clear() {
    strokes.current = []
    current.current = []
    hasInk.current = false
    redraw()
    emit()
  }

  function undo() {
    strokes.current.pop()
    hasInk.current = strokes.current.length > 0
    redraw()
    emit()
  }

  return (
    <div className="space-y-2">
      <div className="relative rounded-lg border-2 border-dashed border-gray-300 bg-white overflow-hidden">
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height, touchAction: 'none', cursor: disabled ? 'not-allowed' : 'crosshair' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerUp}
        />
        {empty && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="text-sm text-gray-300">请客户在此签名</span>
          </div>
        )}
        {/* 签名基线，给一个书写参照 */}
        <div className="pointer-events-none absolute left-6 right-6" style={{ bottom: height * 0.22 }}>
          <div className="border-b border-gray-200" />
        </div>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={undo}
          disabled={disabled || empty}
          className="text-xs px-2.5 py-1 rounded border border-gray-300 text-gray-600 disabled:opacity-40"
        >
          ↩ 撤销一笔
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={disabled || empty}
          className="text-xs px-2.5 py-1 rounded border border-gray-300 text-gray-600 disabled:opacity-40"
        >
          ✕ 清空重签
        </button>
      </div>
    </div>
  )
}
