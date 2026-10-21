import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getObjectStore } from '@/lib/storage/object-store'
import { writeLog } from '@/lib/action-log'

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const MAX_SIZE = 5 * 1024 * 1024 // 5 MB，与 /api/upload-image 口径一致
const MAX_FILES = 60 // 一次请求上限，防表单体积失控，而不是防恶意刷量（见下方 rateLimit）

/**
 * 商品图片批量上传（20261020）——本地照片文件名跟商品对不上号（手机拍照
 * IMG_xxxx 命名），不能按文件名自动匹配，所以每张图片在表单里都带着调用方
 * （bulk-images 页面，用户手动用 useInlineProductPicker 逐张选商品）已经
 * 确定好的目标商品 id，字段名格式固定为 `image:<productId>`。
 *
 * 覆盖式写入 Product.images（单图，与详情页单图上传行为一致），不是追加。
 */
export async function POST(req: NextRequest) {
  // 批量场景一次能带几十张图，按文件数而不是请求数限流才不会卡住正常用户
  const denied = rateLimit(req, { id: 'bulk-upload', max: 10, windowMs: 60_000 })
  if (denied) return denied

  return withAuth(req, async (user) => {
    try {
      const formData = await req.formData()
      const entries = [...formData.entries()].filter(
        (e): e is [string, File] => e[0].startsWith('image:') && e[1] instanceof File,
      )

      if (entries.length === 0) {
        return NextResponse.json({ error: '没有收到任何图片' }, { status: 400 })
      }
      if (entries.length > MAX_FILES) {
        return NextResponse.json({ error: `单次最多 ${MAX_FILES} 张` }, { status: 400 })
      }

      const productIds = entries.map(([key]) => key.slice('image:'.length))
      const products = await prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true },
      })
      const validIds = new Set(products.map((p) => p.id))

      const results: { productId: string; ok: boolean; url?: string; error?: string }[] = []

      for (const [key, file] of entries) {
        const productId = key.slice('image:'.length)
        if (!validIds.has(productId)) {
          results.push({ productId, ok: false, error: '商品不存在' })
          continue
        }
        if (!ALLOWED_TYPES.has(file.type)) {
          results.push({ productId, ok: false, error: '仅支持 JPG、PNG、WebP、GIF 格式' })
          continue
        }
        if (file.size > MAX_SIZE) {
          results.push({ productId, ok: false, error: '图片大小不能超过 5MB' })
          continue
        }
        try {
          const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
          const objectPath = `products/${Date.now()}-${crypto.randomUUID()}.${ext}`
          const buffer = Buffer.from(await file.arrayBuffer())
          const { url } = await getObjectStore().put(objectPath, buffer, file.type, {
            uploadedBy: user.userId,
            uploadedByEmail: user.email,
          })
          await prisma.product.update({ where: { id: productId }, data: { images: [url] } })
          results.push({ productId, ok: true, url })
        } catch (err) {
          console.error('[bulk-images] upload failed:', productId, err)
          results.push({ productId, ok: false, error: '上传失败，请重试' })
        }
      }

      const okCount = results.filter((r) => r.ok).length
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'product', resourceId: 'bulk-images',
        detail: `批量上传商品图片：成功 ${okCount}/${results.length}`,
      })

      return NextResponse.json({ results })
    } catch (err) {
      console.error('[bulk-images] error:', err)
      return NextResponse.json({ error: '批量上传失败，请稍后重试' }, { status: 500 })
    }
  }, { require: 'master.product.update' })
}
