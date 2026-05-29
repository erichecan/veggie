import { NextRequest, NextResponse } from 'next/server'

const TILE_URL = 'https://tile.openstreetmap.org'

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const z = searchParams.get('z')
  const x = searchParams.get('x')
  const y = searchParams.get('y')

  if (!z || !x || !y) {
    return NextResponse.json({ error: 'Missing z/x/y' }, { status: 400 })
  }

  try {
    const res = await fetch(`${TILE_URL}/${z}/${x}/${y}.png`, {
      headers: {
        'User-Agent': 'VeggieSupplyApp/1.0',
      },
    })

    if (!res.ok) {
      return new NextResponse(null, { status: res.status })
    }

    const buffer = await res.arrayBuffer()
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch {
    return new NextResponse(null, { status: 502 })
  }
}
