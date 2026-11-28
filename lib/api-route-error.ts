import { NextResponse } from 'next/server'

/**
 * Keep expected client errors thrown inside a route's main try block as 4xx.
 * Unexpected failures stay 500 and keep the route's generic public message.
 */
export function apiRouteErrorResponse(error: unknown, fallback: string) {
  const err = error as { status?: unknown; message?: unknown } | null
  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500
    ? err.status
    : 500
  const message = status < 500 && typeof err?.message === 'string' && err.message.trim()
    ? err.message
    : fallback
  return NextResponse.json({ error: message }, { status })
}
