import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getObjectStore } from '@/lib/storage/object-store'

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MAX_SIZE = 5 * 1024 * 1024 // 5 MB
// 只允许这几个角色上传图片（餐馆/司机不能）
const ALLOWED_ROLES = ['OPERATOR', 'BOSS', 'WAREHOUSE', 'FINANCE']

export async function POST(req: NextRequest) {
  // 每用户每分钟最多 30 次上传（防恶意刷存储）
  const denied = rateLimit(req, { id: 'upload', max: 30, windowMs: 60_000 })
  if (denied) return denied

  return withAuth(req, async (user) => {
    try {
      const formData = await req.formData()
      const file = formData.get('file') as File | null

      if (!file) {
        return NextResponse.json({ error: 'No file provided' }, { status: 400 })
      }

      if (!ALLOWED_TYPES.has(file.type)) {
        return NextResponse.json(
          { error: '仅支持 JPG、PNG、WebP、GIF 格式图片' },
          { status: 400 },
        )
      }

      if (file.size > MAX_SIZE) {
        return NextResponse.json(
          { error: '图片大小不能超过 5MB' },
          { status: 400 },
        )
      }

      const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
      const objectPath = `products/${Date.now()}-${crypto.randomUUID()}.${ext}`

      const buffer = Buffer.from(await file.arrayBuffer())

      const { url } = await getObjectStore().put(objectPath, buffer, file.type, {
        // 追溯上传人，方便后续审计/清理
        uploadedBy: user.userId,
        uploadedByEmail: user.email,
      })

      return NextResponse.json({ url })
    } catch (err) {
      console.error('[upload-image] error:', err)
      return NextResponse.json({ error: '图片上传失败，请稍后重试' }, { status: 500 })
    }
  }, ALLOWED_ROLES)
}
