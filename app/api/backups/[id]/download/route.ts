import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { getBackupDownloadUrl } from '@/lib/backup'

const ALLOWED_ROLES = ['BOSS']

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    const { id } = await ctx.params
    const url = await getBackupDownloadUrl(id)
    if (!url) {
      return NextResponse.json({ error: '备份不存在或尚未完成' }, { status: 404 })
    }
    return NextResponse.json({ url })
  }, ALLOWED_ROLES)
}
