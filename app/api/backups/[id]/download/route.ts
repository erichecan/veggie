import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { getBackupDownload } from '@/lib/backup'

const ALLOWED_ROLES = ['BOSS']

/**
 * 备份下载。两种落点两种走法：
 *   对象存储（s3 / gcs）→ 返回 { url }，前端跳签名 URL，不占应用带宽
 *   本地磁盘（local）    → 没有 URL 可签，由本路由把文件流转发出去
 * 前端拿到 JSON 就跳 url，拿到 gzip 流就直接存盘，两种都兼容。
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    const { id } = await ctx.params
    const result = await getBackupDownload(id)
    if (!result) {
      return NextResponse.json({ error: '备份不存在或尚未完成' }, { status: 404 })
    }

    if (result.kind === 'url') {
      return NextResponse.json({ url: result.url })
    }

    return new Response(result.stream as unknown as ReadableStream, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Length': String(result.sizeBytes),
        'Content-Disposition': `attachment; filename="backup-${id}.sql.gz"`,
      },
    })
  }, { require: 'system.backup.read' })
}
