'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

/**
 * 全局错误边界
 * ============================================================================
 * Next.js 16 App Router 的错误边界。任何未被捕获的渲染错误或 fetch 抛出都会落到这里。
 *
 * 设计原则（生产环境）：
 *   - 不暴露 stack trace / 内部 message（可能含数据库/路径/秘钥提示）
 *   - 给支持工单用的 "digest" ID 让用户报告
 *   - 提供 "重试" 和 "回首页" 两条路径
 *   - dev 环境保留详情方便排查
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // 生产环境 Sentry 会自动捕获；本地 dev 打印到 console
    console.error('[GlobalError]', error)
  }, [error])

  const isDev = process.env.NODE_ENV !== 'production'

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-gray-50 p-6">
      <div className="text-center max-w-md">
        <p className="text-5xl font-bold text-gray-300">500</p>
        <h1 className="mt-3 text-xl font-semibold text-gray-800">页面出现错误</h1>
        <p className="mt-2 text-sm text-gray-500">
          我们遇到了意外问题。已自动记录日志，请稍后重试，或联系管理员。
        </p>
        {error.digest && (
          <p className="mt-3 text-xs text-gray-400 font-mono">
            错误 ID：{error.digest}
          </p>
        )}
        {isDev && error.message && (
          <details className="mt-4 text-left text-xs bg-red-50 border border-red-200 rounded p-3">
            <summary className="cursor-pointer text-red-700 font-medium">
              开发者调试信息（生产环境不显示）
            </summary>
            <pre className="mt-2 text-red-800 whitespace-pre-wrap break-all">
              {error.message}
              {error.stack && '\n\n' + error.stack}
            </pre>
          </details>
        )}
      </div>
      <div className="flex gap-2">
        <Button onClick={reset} variant="outline">重新加载</Button>
        <Button onClick={() => (window.location.href = '/')} className="bg-[#875A7B] hover:bg-[#6d4963] text-white">
          回到首页
        </Button>
      </div>
    </div>
  )
}
