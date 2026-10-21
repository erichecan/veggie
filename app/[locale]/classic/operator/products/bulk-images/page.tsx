'use client'
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { apiGet, apiUpload, ApiError } from '@/lib/api'
import { useInlineProductPicker, type InlineProductPickerProduct } from '@/components/classic/useInlineProductPicker'

type SlimProduct = InlineProductPickerProduct

type PendingImage = {
  id: string
  file: File
  previewUrl: string
  productId: string | null
  productName: string | null
  status: 'pending' | 'uploading' | 'done' | 'error'
  error?: string
}

/**
 * 商品图片批量上传（20261020）。
 *
 * 本地照片是手机拍的，文件名（IMG_xxxx）跟商品对不上号，没法按文件名自动匹配
 * （用户已确认，见 docs/20261020-veggie-需求原话.md）。所以每张图片都要人工
 * 用下面这个选品框指定目标商品，跟订单行选商品用的是同一套交互
 * （components/classic/useInlineProductPicker），不是另起一套。
 */
export default function BulkProductImagesPage() {
  const router = useRouter()
  const locale = useLocale()
  const prefix = locale === routing.defaultLocale ? '' : `/${locale}`
  const isEn = locale !== routing.defaultLocale

  const [products, setProducts] = useState<SlimProduct[]>([])
  const [images, setImages] = useState<PendingImage[]>([])
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    apiGet<SlimProduct[]>('/api/products?slim=1')
      .then((rows) => setProducts(rows))
      .catch(() => setProducts([]))
  }, [])

  const onSelectProduct = useCallback((lineId: string, product: SlimProduct) => {
    setImages((prev) => prev.map((img) => (
      img.id === lineId ? { ...img, productId: product.id, productName: product.name } : img
    )))
  }, [])

  const picker = useInlineProductPicker<SlimProduct>({
    products,
    onSelect: onSelectProduct,
    placeholderText: isEn ? 'Click to assign product…' : '点击指定商品…',
    searchPlaceholder: isEn ? 'Search product…' : '搜索商品…',
  })

  function onFilesChosen(fileList: FileList | null) {
    if (!fileList) return
    const next: PendingImage[] = [...fileList].map((file) => ({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
      productId: null,
      productName: null,
      status: 'pending',
    }))
    setImages((prev) => [...prev, ...next])
  }

  function removeImage(id: string) {
    setImages((prev) => {
      const target = prev.find((img) => img.id === id)
      if (target) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((img) => img.id !== id)
    })
  }

  const assignedCount = images.filter((img) => img.productId).length

  async function submit() {
    const assigned = images.filter((img) => img.productId && img.status !== 'done')
    if (assigned.length === 0) return
    setSubmitting(true)
    setImages((prev) => prev.map((img) => (img.productId && img.status !== 'done' ? { ...img, status: 'uploading' } : img)))

    const formData = new FormData()
    for (const img of assigned) {
      formData.append(`image:${img.productId}`, img.file)
    }

    try {
      const data = await apiUpload<{ results: { productId: string; ok: boolean; error?: string }[] }>(
        '/api/products/bulk-images',
        formData,
      )
      const resultByProductId = new Map(data.results.map((r) => [r.productId, r]))
      setImages((prev) => prev.map((img) => {
        if (!img.productId) return img
        const r = resultByProductId.get(img.productId)
        if (!r) return img
        return r.ok ? { ...img, status: 'done' } : { ...img, status: 'error', error: r.error }
      }))
    } catch (err) {
      const message = err instanceof ApiError ? err.message : '网络错误'
      setImages((prev) => prev.map((img) => (
        assigned.some((a) => a.id === img.id) ? { ...img, status: 'error', error: message } : img
      )))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold">{isEn ? 'Bulk Upload Product Images' : '批量上传商品图片'}</h1>
        <button
          onClick={() => router.push(`${prefix}/classic/operator/products`)}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          {isEn ? '← Back to products' : '← 返回商品列表'}
        </button>
      </div>

      <div className="mb-4 flex items-center gap-3">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          multiple
          onChange={(e) => onFilesChosen(e.target.files)}
        />
        <span className="text-xs text-gray-400">
          {isEn ? 'JPG/PNG/WebP/GIF, up to 5MB each' : '支持 JPG/PNG/WebP/GIF，单张不超过 5MB'}
        </span>
      </div>

      {images.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mb-4">
            {images.map((img) => (
              <div key={img.id} className="rounded-lg border p-2 flex flex-col gap-2" style={{ borderColor: '#eee' }}>
                <div className="relative w-full aspect-square rounded bg-gray-50 overflow-hidden">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.previewUrl} alt="" className="w-full h-full object-cover" />
                  <button
                    onClick={() => removeImage(img.id)}
                    className="absolute top-1 right-1 bg-white/90 rounded-full w-5 h-5 text-xs leading-5 text-gray-500 hover:text-red-500"
                    title={isEn ? 'Remove' : '移除'}
                  >
                    ×
                  </button>
                </div>
                {picker.productCell({ lineId: img.id, productName: img.productName })}
                {img.status === 'uploading' && <span className="text-xs text-gray-400">{isEn ? 'Uploading…' : '上传中…'}</span>}
                {img.status === 'done' && <span className="text-xs text-green-600">{isEn ? 'Done' : '已完成'}</span>}
                {img.status === 'error' && <span className="text-xs text-red-500">{img.error}</span>}
              </div>
            ))}
          </div>

          <button
            onClick={submit}
            disabled={submitting || assignedCount === 0}
            className="px-4 py-1.5 rounded-md text-sm font-medium text-white disabled:opacity-40"
            style={{ background: '#875A7B' }}
          >
            {submitting
              ? (isEn ? 'Uploading…' : '上传中…')
              : (isEn ? `Upload ${assignedCount} assigned image(s)` : `上传 ${assignedCount} 张已指定商品的图片`)}
          </button>
          {images.some((img) => !img.productId) && (
            <span className="ml-3 text-xs text-gray-400">
              {isEn ? 'Unassigned images are skipped until a product is picked.' : '未指定商品的图片会跳过，指定后才会上传。'}
            </span>
          )}
        </>
      )}

      {picker.dropdown}
    </div>
  )
}
