/**
 * GET /api/trips/[id]/print-data
 *
 * 返回客户端打印页面需要的全部数据（trip + orders + lines + customers + goodsType），
 * 一次性加载好，避免客户端多次往返。
 *
 * 客户端打印模式：
 *   1. 客户端 React 页面调本接口拿 JSON
 *   2. 页面渲染 HTML 模板（lib/print/trip-*-template.ts）
 *   3. dangerouslySetInnerHTML 注入，模板内嵌 <script>window.print()</script> 触发浏览器打印
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { loadTripPrintData } from '@/lib/print/trip-loader'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = ['OPERATOR', 'BOSS', 'DRIVER', 'FINANCE', 'SALES']

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    const { id } = await params
    try {
      const data = await loadTripPrintData(id)
      if (!data) {
        return NextResponse.json({ error: '行程不存在' }, { status: 404 })
      }
      return NextResponse.json(data, {
        headers: { 'Cache-Control': 'no-store' },
      })
    } catch (error) {
      console.error('[GET /api/trips/[id]/print-data]', error)
      return NextResponse.json(
        {
          error: '获取打印数据失败',
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      )
    }
  }, ALLOWED_ROLES)
}
