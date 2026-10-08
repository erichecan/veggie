import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth, userHasPermission } from '@/lib/auth'

/**
 * GET /api/import-history?resource=product —— 导入历史(20261008)
 * ============================================================================
 * 每次导入(导入弹窗里选一个文件点一次)会分批提交，每批在 ActionLog 留一条汇总，
 * changes.import 里带 { importId, fileName, batch, created, updated, skipped, failed }
 * (见 lib/import/bulk-import-engine.ts importHistoryChanges)。这里按 importId 把同一次
 * 导入的各批合并成一行：谁、什么时候、哪个文件、新建/更新/跳过/失败各多少。
 *
 * 能看哪个模块的导入历史，跟能不能导入那个模块是同一个权限点。
 */

const RESOURCE_PERMISSION: Record<string, string> = {
  product: 'master.product.update',
  customer: 'master.customer.bulk_import',
  supplier: 'master.customer.bulk_import',
  pricelist: 'master.pricelist.update',
  uom: 'master.uom.create',
  product_category: 'master.product_category.update',
  user: 'system.user.manage',
}

interface ImportPayload {
  importId?: string
  fileName?: string
  batch?: number
  created?: number
  updated?: number
  skipped?: number
  failed?: number
}

export async function GET(req: Request) {
  return withAuth(req, async (user) => {
    const resource = new URL(req.url).searchParams.get('resource') ?? ''
    const perm = RESOURCE_PERMISSION[resource]
    if (!perm) return NextResponse.json({ error: '不支持的模块' }, { status: 400 })
    if (!userHasPermission(user, perm)) return NextResponse.json({ error: '权限不足' }, { status: 403 })

    const since = new Date(Date.now() - 180 * 86_400_000)
    const logs = await prisma.actionLog.findMany({
      where: { resource, resourceId: 'bulk', createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 2000,
      select: { userName: true, userEmail: true, changes: true, createdAt: true },
    })

    const byImport = new Map<string, {
      importId: string; fileName: string; userName: string; startedAt: Date; finishedAt: Date
      batches: number; created: number; updated: number; skipped: number; failed: number
    }>()
    for (const log of logs) {
      const imp = ((log.changes as Record<string, { after?: ImportPayload }> | null)?.import?.after) ?? null
      if (!imp?.importId) continue
      const cur = byImport.get(imp.importId) ?? {
        importId: imp.importId, fileName: imp.fileName ?? '', userName: log.userName || log.userEmail,
        startedAt: log.createdAt, finishedAt: log.createdAt, batches: 0, created: 0, updated: 0, skipped: 0, failed: 0,
      }
      cur.batches += 1
      cur.created += imp.created ?? 0
      cur.updated += imp.updated ?? 0
      cur.skipped += imp.skipped ?? 0
      cur.failed += imp.failed ?? 0
      if (log.createdAt < cur.startedAt) cur.startedAt = log.createdAt
      if (log.createdAt > cur.finishedAt) cur.finishedAt = log.createdAt
      byImport.set(imp.importId, cur)
    }

    const items = [...byImport.values()].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()).slice(0, 50)
    return NextResponse.json({ items })
  })
}
