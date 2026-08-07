import createMiddleware from 'next-intl/middleware'
import { routing } from './i18n/routing'
import { type NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'
import { isPublicApiRoute } from './lib/public-routes'
import { homeFor } from './lib/role-access'
import { canAccessApi, canAccessPage, rolesOf } from './lib/rbac/gate'

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'veggie-demo-fallback-secret')

// 白名单与放行判定在 lib/public-routes.ts，由 tests/public-api-routes.test.ts 锁住。

const intlMiddleware = createMiddleware(routing)

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/favicon') ||
    pathname.includes('.')
  ) {
    return NextResponse.next()
  }

  if (isPublicApiRoute(pathname)) {
    return NextResponse.next()
  }

  if (pathname.startsWith('/api/')) {
    const token = req.headers.get('Authorization')?.slice(7)
    if (!token) {
      return NextResponse.json({ error: '未授权访问' }, { status: 401 })
    }
    try {
      const { payload } = await jwtVerify(token, secret)
      // 按 token 里的权限位图判定（旧 token 无位图时回退角色白名单，见 lib/rbac/gate.ts）。
      // 放在这里而不是逐个路由加 allowedRoles —— 后者要改 152 处且漏一处就还是漏，
      // 而且新增路由默认又是敞开的；这里未登记的路由默认拒绝。
      if (!canAccessApi(payload, pathname, req.method)) {
        return NextResponse.json({ error: '权限不足' }, { status: 403 })
      }
      return NextResponse.next()
    } catch {
      return NextResponse.json({ error: 'Token 无效或已过期' }, { status: 401 })
    }
  }

  const localePrefix = routing.locales.find(l => pathname.startsWith(`/${l}/`) || pathname === `/${l}`)
  const barePath = localePrefix ? pathname.slice(localePrefix.length + 1) || '/' : pathname

  if (barePath === '/' || barePath === '/enter' || barePath.startsWith('/enter')) {
    return intlMiddleware(req)
  }

  const token = req.cookies.get('veggie_token')?.value
  if (!token) {
    const enterUrl = new URL(localePrefix ? `/${localePrefix}/enter` : '/enter', req.url)
    return NextResponse.redirect(enterUrl)
  }

  try {
    const { payload } = await jwtVerify(token, secret)
    // 页面层同样收窄：餐馆客户不能登录运营后台（2026-08-06 用户明确要求），
    // 各内部岗位也只看得到自己那块。光挡 API 不够 —— 页面能打开但数据全 403，
    // 用户看到的是一堆空壳和报错，既暴露了别人后台的存在，也说不清是权限问题还是系统坏了。
    if (!canAccessPage(payload, barePath)) {
      const home = homeFor(rolesOf(payload))
      return NextResponse.redirect(new URL(localePrefix ? `/${localePrefix}${home}` : home, req.url))
    }
    return intlMiddleware(req)
  } catch {
    const enterUrl = new URL(localePrefix ? `/${localePrefix}/enter` : '/enter', req.url)
    const res = NextResponse.redirect(enterUrl)
    res.cookies.delete('veggie_token')
    return res
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
