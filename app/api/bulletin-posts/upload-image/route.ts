import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getObjectStore } from '@/lib/storage/object-store'
import { assertInternalUser } from '@/lib/bulletin'

/**
 * 信息广场专用图片上传，独立于 `/api/upload-image`。
 *
 * `/api/upload-image` 挂在 `tool.upload.use` 权限点上，实际能上传的角色由
 * RBAC 配置决定；信息广场按设计不接正式权限点体系（DEV-PLAN §3），所有内部
 * 登录用户都要能带图发帖，所以单独开一条口径，而不是去放开那个权限点的授予面。
 */

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MAX_SIZE = 5 * 1024 * 1024 // 5 MB

export async function POST(req: NextRequest) {
  const denied = rateLimit(req, { id: 'bulletin-upload', max: 30, windowMs: 60_000 })
  if (denied) return denied

  return withAuth(req, async (user) => {
    const forbidden = assertInternalUser(user)
    if (forbidden) return forbidden

    try {
      const formData = await req.formData()
      const file = formData.get('file') as File | null

      if (!file) {
        return NextResponse.json({ error: 'No file provided' }, { status: 400 })
      }
      if (!ALLOWED_TYPES.has(file.type)) {
        return NextResponse.json({ error: '仅支持 JPG、PNG、WebP、GIF 格式图片' }, { status: 400 })
      }
      if (file.size > MAX_SIZE) {
        return NextResponse.json({ error: '图片大小不能超过 5MB' }, { status: 400 })
      }

      const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
      const objectPath = `bulletin/${Date.now()}-${crypto.randomUUID()}.${ext}`
      const buffer = Buffer.from(await file.arrayBuffer())

      const { url } = await getObjectStore().put(objectPath, buffer, file.type, {
        uploadedBy: user.userId,
        uploadedByEmail: user.email,
      })

      return NextResponse.json({ url })
    } catch (err) {
      console.error('[bulletin-posts/upload-image] error:', err)
      return NextResponse.json({ error: '图片上传失败，请稍后重试' }, { status: 500 })
    }
  })
}
