import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

/**
 * GET /api/health
 * ============================================================================
 * 健康检查端点。GCP Cloud Run、Kubernetes livenessProbe 都可以接这个。
 *
 * 返回：
 *   200 {status: 'ok',     db: 'ok',   version: '...', uptimeSec: N}
 *   503 {status: 'degraded' | 'error', db: 'fail', error: '...'}
 *
 * 不受认证保护（必须让负载均衡能访问）。
 */

const START_TIME = Date.now()

export async function GET() {
  const ts = new Date().toISOString()
  const uptimeSec = Math.floor((Date.now() - START_TIME) / 1000)
  const version = process.env.BUILD_VERSION ?? 'dev'

  try {
    // 对 Postgres 发起极轻 ping（避免查真数据）
    await prisma.$queryRaw`SELECT 1`
    return NextResponse.json({
      status: 'ok',
      db: 'ok',
      version,
      uptimeSec,
      timestamp: ts,
    })
  } catch (err) {
    console.error('[health] db check failed:', err)
    return NextResponse.json(
      {
        status: 'error',
        db: 'fail',
        version,
        uptimeSec,
        timestamp: ts,
        error: (err as Error).message,
      },
      { status: 503 },
    )
  }
}
