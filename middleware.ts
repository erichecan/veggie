import createMiddleware from 'next-intl/middleware'
import { routing } from './i18n/routing'
import { type NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'veggie-demo-fallback-secret')

const PUBLIC_API_ROUTES = [
  '/api/auth/login',
  '/api/health',
  '/api/customers',
  '/api/tile',
]

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

  if (PUBLIC_API_ROUTES.some(r => pathname.startsWith(r))) {
    return NextResponse.next()
  }

  if (pathname.startsWith('/api/')) {
    const token = req.headers.get('Authorization')?.slice(7)
    if (!token) {
      return NextResponse.json({ error: '未授权访问' }, { status: 401 })
    }
    try {
      await jwtVerify(token, secret)
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
    await jwtVerify(token, secret)
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
