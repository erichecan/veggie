import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function GET(req: Request) {
  return withAuth(req, async user => {
    const rows = await prisma.creditNoteRequest.findMany({
      where: { requestedById: user.userId }, orderBy: { createdAt: 'desc' }, take: 300,
    })
    return NextResponse.json(serializeApi(rows))
  }, { require: 'sales.order.read' })
}
