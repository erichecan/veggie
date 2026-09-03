'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { getDefaultLandingPath } from '@/lib/rbac/page-guard'

export default function RootPage() {
  const router = useRouter()

  useEffect(() => {
    try {
      const raw = localStorage.getItem('veggie_user')
      if (raw) {
        router.replace(getDefaultLandingPath(JSON.parse(raw), ''))
        return
      }
    } catch {}
    router.replace('/enter')
  }, [router])

  return (
    <div className="min-h-screen flex items-center justify-center text-gray-400 text-sm">
      正在加载...
    </div>
  )
}
