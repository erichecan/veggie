import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

/**
 * /api/uoms
 * ============================================================================
 * UoM（计量单位）管理，对应 Odoo uom.uom。
 *
 * GET  → 返回全部 UoM（含 category），用于商品编辑下拉框和订单选单位
 * POST → 新建 UoM（只有 OPERATOR/BOSS 能建）
 *
 * 注意：修改 reference 单位的 factor 会破坏已有换算关系，生产环境应锁死。
 */

export async function GET() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const uoms = await p.uom.findMany({
      where: { active: true },
      include: { category: true },
      orderBy: [{ category: { name: 'asc' } }, { factor: 'asc' }],
    })
    return NextResponse.json(serializeApi(uoms))
  } catch (error) {
    console.error('[GET /api/uoms]', error)
    return NextResponse.json({ error: '获取 UoM 失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const name = String(data.name ?? '').trim()
      const categoryId = String(data.categoryId ?? '').trim()
      if (!name) return NextResponse.json({ error: '名称不能为空' }, { status: 400 })
      if (!categoryId) return NextResponse.json({ error: '必须选择 Category' }, { status: 400 })

      const factor = Number(data.factor ?? 1)
      const rounding = Number(data.rounding ?? 0.01)
      if (!Number.isFinite(factor) || factor <= 0) {
        return NextResponse.json({ error: 'factor 必须 > 0' }, { status: 400 })
      }
      const type: 'REFERENCE' | 'SMALLER' | 'BIGGER' =
        factor === 1 ? 'REFERENCE' : factor < 1 ? 'SMALLER' : 'BIGGER'

      // 货物类型白名单（BULK 大货 / LOOSE 散货 / null 未分类）
      const rawGoodsType = data.goodsType
      const goodsType: 'BULK' | 'LOOSE' | null =
        rawGoodsType === 'BULK' ? 'BULK' :
        rawGoodsType === 'LOOSE' ? 'LOOSE' : null

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const created = await p.uom.create({
        data: {
          name,
          nameZh: data.nameZh ?? null,
          categoryId,
          factor,
          rounding,
          type,
          goodsType,
        },
      })
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'uom', resourceId: created.id,
        detail: `新建 UoM: ${name} (factor=${factor}${goodsType ? `, ${goodsType}` : ''})`,
      })
      return NextResponse.json(serializeApi(created), { status: 201 })
    } catch (error) {
      console.error('[POST /api/uoms]', error)
      return NextResponse.json({ error: '创建 UoM 失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS'])
}
