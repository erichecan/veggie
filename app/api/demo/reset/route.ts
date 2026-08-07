import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'

/**
 * POST /api/demo/reset
 * 清除演示期间产生的业务数据（订单、波次、行程、发票、库存流水）
 * 保留：商品、价格表、客户、用户账号等基础数据
 * 仅限 OPERATOR 角色
 */
export async function POST(req: Request) {
  return withAuth(req, async () => {
    try {
      // 按外键依赖顺序删除
      await prisma.invoice.deleteMany({})
      await prisma.trip.deleteMany({})
      await prisma.pickingWave.deleteMany({})
      await prisma.order.deleteMany({})
      await prisma.stockMove.deleteMany({})
      await prisma.purchaseRecord.deleteMany({})

      return NextResponse.json({
        ok: true,
        message: '演示数据已重置。商品、价格表、客户、账号均已保留。',
      })
    } catch (error) {
      console.error('[POST /api/demo/reset]', error)
      return NextResponse.json({ error: '重置失败' }, { status: 500 })
    }
  }, { require: 'system.settings.manage' })
}
