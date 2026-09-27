'use client'
import { useEffect, useState } from 'react'
import type { PortalBanner } from './use-customer-portal'

const AUTO_ROTATE_MS = 4500

export function BannerCarousel({ banners, onBannerClick }: { banners: PortalBanner[]; onBannerClick: (b: PortalBanner) => void }) {
  const [idx, setIdx] = useState(0)

  useEffect(() => {
    if (banners.length <= 1) return
    const t = setInterval(() => setIdx((i) => (i + 1) % banners.length), AUTO_ROTATE_MS)
    return () => clearInterval(t)
  }, [banners.length])

  if (banners.length === 0) return null

  const current = banners[Math.min(idx, banners.length - 1)]

  return (
    <div className="relative rounded-xl overflow-hidden">
      {/* eslint-disable-next-line @next/next/no-img-element -- 轮播图来自任意外部/对象存储 URL，不走 next/image 的域名白名单 */}
      <img
        src={current.imageUrl}
        alt={current.title}
        className="w-full h-32 sm:h-44 object-cover cursor-pointer"
        onClick={() => onBannerClick(current)}
      />
      {banners.length > 1 && (
        <div className="absolute bottom-2 left-0 right-0 flex items-center justify-center gap-1.5">
          {banners.map((b, i) => (
            <button
              key={b.id}
              onClick={() => setIdx(i)}
              className="w-1.5 h-1.5 rounded-full transition-all"
              style={{ background: i === idx ? 'white' : 'rgba(255,255,255,0.5)', width: i === idx ? '16px' : '6px' }}
              aria-label={`banner ${i + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}
