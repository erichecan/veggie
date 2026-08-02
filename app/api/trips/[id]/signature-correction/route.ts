import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { applySignatureCorrection, type CorrectionInput } from '@/lib/trip-signature'

/**
 * POST /api/trips/[id]/signature-correction —— 主管更正客户签收
 *
 * 为什么单开一个接口：签收签名在 `PUT /api/trips/[id]` 里是**不可变**的（409），
 * 否则整包覆盖 restaurants JSON 的那条路径能让任何人悄悄改掉收货凭证。
 * 但现场确实会签错（签错人、签错站、客户签完反悔），得有一条正规路径。
 *
 * 这条路径与普通保存的三点不同：
 *   1. 只有 OPERATOR / BOSS 能调，司机不能自己改自己收的签名
 *   2. 必须填更正原因
 *   3. **旧签名归档进 signatureCorrections，不是覆盖掉**——凭证销毁了就没法举证
 *
 * body: { restaurantId, action: 'void' | 'replace', reason, signature?, signerName? }
 */

const ALLOWED_ROLES = ['OPERATOR', 'BOSS']

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const body = await req.json() as Partial<CorrectionInput>

      if (!body.restaurantId) {
        return NextResponse.json({ error: '缺少 restaurantId' }, { status: 400 })
      }
      if (body.action !== 'void' && body.action !== 'replace') {
        return NextResponse.json({ error: "action 只能是 'void'（作废）或 'replace'（换签）" }, { status: 400 })
      }
      if (!body.reason || !String(body.reason).trim()) {
        return NextResponse.json({ error: '必须填写更正原因' }, { status: 400 })
      }

      const trip = await prisma.trip.findUnique({ where: { id } })
      if (!trip) return NextResponse.json({ error: '行程不存在' }, { status: 404 })

      const result = applySignatureCorrection(
        trip.restaurants,
        {
          restaurantId: String(body.restaurantId),
          action: body.action,
          reason: String(body.reason).trim(),
          signature: body.signature ?? null,
          signerName: body.signerName ?? null,
        },
        { userId: user.userId, userName: user.name || user.email },
        new Date(),
      )

      if (result.error) {
        return NextResponse.json({ error: result.error }, { status: result.status ?? 400 })
      }

      const updated = await prisma.trip.update({
        where: { id },
        data: { restaurants: result.restaurants as never },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'trip', resourceId: id,
        detail: `签收更正（${body.action === 'void' ? '作废' : '换签'}）站点 ${body.restaurantId}：${String(body.reason).trim()}`,
        // 不把签名图本身写进日志——base64 会把 ActionLog 撑爆；原图已归档在
        // Trip.restaurants[].signatureCorrections 里，追责时从那里取
        changes: {
          signature: {
            before: { restaurantId: body.restaurantId, signed: true },
            after: { action: body.action, reason: String(body.reason).trim() },
          },
        },
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[POST /api/trips/[id]/signature-correction]', error)
      return NextResponse.json({ error: '签收更正失败' }, { status: 500 })
    }
  }, ALLOWED_ROLES)
}
