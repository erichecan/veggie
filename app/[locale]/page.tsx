'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

const ROLE_PATHS: Record<string, string> = {
  OPERATOR: '/classic/operator',
  RESTAURANT: '/classic/restaurant',
  PICKER: '/classic/operator',
  SORTER: '/classic/sorter',
  DRIVER: '/classic/driver',
  BOSS: '/classic/boss',
  FINANCE: '/classic/accounting',
  WAREHOUSE: '/classic/warehouse',
}

export default function RootPage() {
  const router = useRouter()

  useEffect(() => {
    try {
      const raw = localStorage.getItem('veggie_user')
      if (raw) {
        const user = JSON.parse(raw)
        const path = ROLE_PATHS[user.role] ?? '/enter'
        router.replace(path)
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
