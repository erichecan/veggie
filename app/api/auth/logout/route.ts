import { NextResponse } from 'next/server'

/**
 * POST /api/auth/logout —— 清掉服务端下发的 HttpOnly 登录 cookie。
 * JS 删不掉 HttpOnly cookie，退出必须走这一趟；否则「退出登录」后
 * 刷新页面又自动登回去了。
 *
 * 故意放在公开白名单里（见 lib/public-routes.ts）：token 已失效的人
 * 也得能退出。本接口不读不写任何业务数据，只删自己浏览器里的 cookie。
 */
export async function POST(req: Request) {
  const res = NextResponse.json({ ok: true })
  res.cookies.set('veggie_token', '', {
    httpOnly: true,
    path: '/',
    maxAge: 0,
    sameSite: 'lax',
    secure: req.headers.get('x-forwarded-proto') === 'https',
  })
  return res
}
