import Link from 'next/link'
import { Button } from '@/components/ui/button'

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50">
      <div className="text-center">
        <p className="text-4xl font-bold text-gray-300">404</p>
        <h1 className="mt-2 text-xl font-semibold text-gray-800">页面不存在</h1>
        <p className="mt-1 text-sm text-gray-500">你访问的页面已被移除或地址有误</p>
      </div>
      <Link href="/">
        <Button variant="outline">返回首页</Button>
      </Link>
    </div>
  )
}
