import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'

// 一趟车能装的托盘数是固定的，不能无限新增(见调度台"新增托盘")。
const MAX_PALLETS_PER_DRIVER = 5

/**
 * 司机配置是主数据：改了它，销售单的司机下拉、调度台的托盘 lane、
 * 已排波次的归属会一起变。所以写操作只给运营与老板。
 *
 * 2026-08-06 审计发现这三个写操作**连 withAuth 都没有** —— 只有 middleware
 * 验了「有没有 token」，任何登录用户（包括司机本人、餐厅客户）都能改。
 */
const CONFIG_WRITERS = ['OPERATOR', 'BOSS']

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const showArchived = searchParams.get('archived') === 'true'
    const slots = await prisma.driverSlot.findMany({
      where: { archived: showArchived },
      orderBy: [{ timeOfDay: 'asc' }, { batchNum: 'asc' }],
    })
    return NextResponse.json(slots)
  } catch (e) {
    console.error('[driver-slots GET]', e)
    return NextResponse.json({ error: 'Failed to fetch driver slots' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, () => createSlot(req), { require: 'dispatch.driver_slot.manage' })
}

async function createSlot(req: Request) {
  try {
    const body = await req.json()
    const { timeOfDay, batchNum, driverName, userId } = body
    if (!timeOfDay || !batchNum || !driverName?.trim()) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    const num = Number(batchNum)
    const boundUserId = userId ? String(userId) : null
    // 身份以 userId 为准，driverName 只是显示快照(见 schema DriverSlot 注释)：绑定了系统用户就
    // 强制把 driverName 同步成该用户的 name，堵住手填导致同一人两种拼写(如 Moazzam/Mozzam)的口子。
    const boundUser = boundUserId ? await prisma.user.findUnique({ where: { id: boundUserId }, select: { name: true } }) : null
    const name = boundUser?.name ?? driverName.trim()
    // 唯一约束含归档：撞到归档记录则自动恢复（复活），撞到活跃记录才报冲突
    const existing = await prisma.driverSlot.findUnique({
      where: { timeOfDay_batchNum_driverName: { timeOfDay, batchNum: num, driverName: name } },
    })
    if (existing) {
      if (existing.archived) {
        const activeCount = await prisma.driverSlot.count({ where: { timeOfDay, driverName: name, archived: false } })
        if (activeCount >= MAX_PALLETS_PER_DRIVER) {
          return NextResponse.json({ error: `托盘数已达上限(${MAX_PALLETS_PER_DRIVER})，无法恢复` }, { status: 409 })
        }
        const restored = await prisma.driverSlot.update({
          where: { id: existing.id },
          data: { archived: false, userId: boundUserId },
        })
        return NextResponse.json(restored, { status: 200 })
      }
      return NextResponse.json({ error: '该司机已在相同时段和批次中' }, { status: 409 })
    }
    const activeCount = await prisma.driverSlot.count({ where: { timeOfDay, driverName: name, archived: false } })
    if (activeCount >= MAX_PALLETS_PER_DRIVER) {
      return NextResponse.json({ error: `托盘数已达上限(${MAX_PALLETS_PER_DRIVER})，无法新增` }, { status: 409 })
    }
    const slot = await prisma.driverSlot.create({
      data: { timeOfDay, batchNum: num, driverName: name, userId: boundUserId },
    })
    return NextResponse.json(slot, { status: 201 })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('Unique constraint')) {
      return NextResponse.json({ error: '该司机已在相同时段和批次中（若在归档里请先恢复）' }, { status: 409 })
    }
    console.error('[driver-slots POST]', e)
    return NextResponse.json({ error: 'Failed to create driver slot' }, { status: 500 })
  }
}
