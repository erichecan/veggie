'use client'

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface TimedConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void | Promise<void>
  /** Block Escape/backdrop/cancel until the countdown ends. */
  lockDismissUntilReady?: boolean
  seconds?: number
  destructive?: boolean
}

export default function TimedConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  lockDismissUntilReady = false,
  seconds = 3,
  destructive = false,
}: TimedConfirmDialogProps) {
  const [remaining, setRemaining] = useState(seconds)
  const [busy, setBusy] = useState(false)
  const ready = remaining <= 0

  useEffect(() => {
    if (!open) return
    setRemaining(seconds)
    setBusy(false)
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const left = Math.max(0, seconds - Math.floor((Date.now() - startedAt) / 1000))
      setRemaining(left)
      if (left === 0) window.clearInterval(timer)
    }, 100)
    return () => window.clearInterval(timer)
  }, [open, seconds])

  async function confirm() {
    if (!ready || busy) return
    setBusy(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next && lockDismissUntilReady && !ready) return
        if (!busy) onOpenChange(next)
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            disabled={busy || (lockDismissUntilReady && !ready)}
            onClick={() => onOpenChange(false)}
            className="min-h-10 rounded border border-gray-300 px-4 text-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cancelLabel}{lockDismissUntilReady && !ready ? ` (${remaining})` : ''}
          </button>
          <button
            type="button"
            disabled={!ready || busy}
            onClick={confirm}
            className={`min-h-10 rounded px-4 text-white disabled:cursor-not-allowed disabled:opacity-50 ${destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-[#875A7B] hover:opacity-90'}`}
          >
            {busy ? '…' : !ready ? `${confirmLabel} (${remaining})` : confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
