import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { PERMISSION_GROUPS, PERMISSION_COUNT } from '@/lib/rbac/catalog'

/**
 * GET /api/rbac/permissions —— 权限点目录（配置页的勾选树）
 *
 * 直接回 lib/rbac/catalog.ts 的内容，不查库。库里的 Permission 表只是它的镜像，
 * 以代码为准可以避免「部署了新版本但库里还是旧目录」这种半新半旧的状态。
 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    return NextResponse.json({
      total: PERMISSION_COUNT,
      groups: PERMISSION_GROUPS.map((g) => ({
        key: g.key,
        labelZh: g.labelZh,
        labelEn: g.labelEn,
        modules: g.modules.map((m) => ({
          module: m.module,
          labelZh: m.labelZh,
          labelEn: m.labelEn,
          note: m.note ?? null,
          actions: m.actions.map((a) => ({
            id: `${m.module}.${a.action}`,
            action: a.action,
            labelZh: a.labelZh,
            labelEn: a.labelEn,
          })),
        })),
      })),
    })
  }, { require: 'system.rbac.read' })
}
