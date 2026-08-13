/**
 * 司机身份校验器的**自检**（台账 C6）
 * ============================================================================
 * 一条永远绿的检查等于没有检查。这个项目已经五次踩到「度量工具自身失真」：
 * 假阴性的可达性检测器、插进注释里的批量改写、被分支丢掉的行级条件、
 * 只判 isArray 的筛选断言、把跳过记成通过的打印矩阵。
 *
 * 所以这里逐条**故意造出分叉**，断言检查器真的会红，再把数据清干净。
 * 跑完之后库应回到与开跑前一致的状态。
 *
 * ⚠️ 会写库（随即删除）。只允许打向本机 veggie_test。
 * 用法：npm run test:driver-identity
 */
import { createPrismaClient } from '../../lib/prisma-factory'
import { checkDriverIdentity } from '../../lib/validation/driver-identity'

interface Case { name: string; state: 'pass' | 'fail'; detail: string }
const cases: Case[] = []
const add = (name: string, ok: boolean, detail: string) =>
  cases.push({ name, state: ok ? 'pass' : 'fail', detail })

const prisma = createPrismaClient()

async function badCount(key: string): Promise<number> {
  const findings = await checkDriverIdentity(prisma)
  return findings.find(f => f.key === key)?.bad ?? -1
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? ''
  if (!/localhost|127\.0\.0\.1/.test(dbUrl)) {
    console.error('⛔ 本脚本会写库，只允许打向本机测试库'); process.exit(1)
  }
  const stamp = Date.now()

  // 起跑线：全部不变量必须是 0，否则后面的「+1」证明不了任何事
  const baseline = await checkDriverIdentity(prisma)
  const dirty = baseline.filter(f => !f.advisory && f.bad > 0)
  if (dirty.length > 0) {
    console.error('⛔ 开跑前库里已有分叉，自检无法进行：')
    for (const f of dirty) console.error(`   ${f.title} — ${f.bad}/${f.total}`)
    console.error('   先跑 scripts/audit/driver-identity-probe.ts 看清楚再来。')
    process.exit(1)
  }
  const base = new Map(baseline.map(f => [f.key, f.bad]))

  // ── 1. 档位不绑账号 → slot_bound 必须报出来 ───────────────────────────────
  {
    const slot = await prisma.driverSlot.create({
      data: { timeOfDay: 'pm', batchNum: 9, driverName: `自检-未绑 ${stamp}`, userId: null },
      select: { id: true },
    })
    const n = await badCount('slot_bound')
    add('注入「档位未绑账号」→ 检查器报错', n === (base.get('slot_bound') ?? 0) + 1, `bad=${n}（基线 ${base.get('slot_bound')}）`)
    await prisma.driverSlot.delete({ where: { id: slot.id } })
  }

  // ── 2. 档位绑到一个非 DRIVER 的人 → slot_user_valid 必须报 ────────────────
  {
    const op = await prisma.user.findFirst({
      where: { OR: [{ role: 'OPERATOR' }, { roles: { has: 'OPERATOR' } }] },
      select: { id: true },
    })
    if (op) {
      const slot = await prisma.driverSlot.create({
        data: { timeOfDay: 'pm', batchNum: 8, driverName: `自检-绑错人 ${stamp}`, userId: op.id },
        select: { id: true },
      })
      const n = await badCount('slot_user_valid')
      add('注入「档位绑到非司机账号」→ 检查器报错', n === (base.get('slot_user_valid') ?? 0) + 1, `bad=${n}`)
      await prisma.driverSlot.delete({ where: { id: slot.id } })
    } else {
      add('注入「档位绑到非司机账号」→ 检查器报错', false, '库里找不到 OPERATOR 账号，无法构造')
    }
  }

  // ── 3. 一单挂在两个司机的行程上 → order_single_driver 必须报 ──────────────
  {
    const order = await prisma.order.findFirst({ select: { id: true } })
    const drivers = await prisma.user.findMany({
      where: { OR: [{ role: 'DRIVER' }, { roles: { has: 'DRIVER' } }] },
      select: { id: true, name: true }, take: 2,
    })
    if (order && drivers.length >= 2) {
      const mk = (d: { id: string; name: string }, i: number) => prisma.trip.create({
        data: {
          name: `自检-双挂${i} ${stamp}`, driverId: d.id, driverName: d.name,
          status: 'PENDING_ASSIGNMENT', totalPayment: 0,
          restaurants: [{ restaurantId: 'x', restaurantName: 'x', orderIds: [order.id] }] as never,
        },
        select: { id: true },
      })
      const t1 = await mk(drivers[0]!, 1)
      const t2 = await mk(drivers[1]!, 2)
      const n = await badCount('order_single_driver')
      add('注入「同一单挂在两个司机的行程上」→ 检查器报错',
        n === (base.get('order_single_driver') ?? 0) + 1, `bad=${n}`)
      await prisma.trip.deleteMany({ where: { id: { in: [t1.id, t2.id] } } })
    } else {
      add('注入「同一单挂在两个司机的行程上」→ 检查器报错', false, '缺少订单或第二个司机账号')
    }
  }

  // ── 4. 行程挂一个不存在的 driverId → trip_driver_exists 必须报 ────────────
  {
    const wave = await prisma.pickingWave.findFirst({ select: { id: true } })
    const t = await prisma.trip.create({
      data: {
        name: `自检-幽灵司机 ${stamp}`, driverId: `ghost-${stamp}`, driverName: '幽灵',
        status: 'PENDING_ASSIGNMENT', totalPayment: 0, waveId: wave?.id ?? null,
        restaurants: [] as never,
      },
      select: { id: true },
    })
    const n = await badCount('trip_driver_exists')
    add('注入「行程 driverId 查无此人」→ 检查器报错',
      n === (base.get('trip_driver_exists') ?? 0) + 1, `bad=${n}`)
    await prisma.trip.delete({ where: { id: t.id } })
  }

  // ── 5. 未完成行程与档位绑定不一致 → trip_slot_user 必须报 ─────────────────
  {
    const slotWithUser = await prisma.driverSlot.findFirst({
      where: { archived: false, userId: { not: null } }, select: { id: true, userId: true },
    })
    const other = await prisma.user.findFirst({
      where: { AND: [{ OR: [{ role: 'DRIVER' }, { roles: { has: 'DRIVER' } }] }, { id: { not: slotWithUser?.userId ?? '' } }] },
      select: { id: true, name: true },
    })
    if (slotWithUser && other) {
      const w = await prisma.pickingWave.create({
        data: { name: `自检波次 ${stamp}`, orderIds: [], zones: [] as never, driverSlotId: slotWithUser.id },
        select: { id: true },
      })
      const t = await prisma.trip.create({
        data: {
          name: `自检-行程司机对不上 ${stamp}`, waveId: w.id,
          driverId: other.id, driverName: other.name,
          status: 'IN_PROGRESS', totalPayment: 0, restaurants: [] as never,
        },
        select: { id: true },
      })
      const n = await badCount('trip_slot_user')
      add('注入「未完成行程的司机与档位绑定不一致」→ 检查器报错',
        n === (base.get('trip_slot_user') ?? 0) + 1, `bad=${n}`)
      await prisma.trip.delete({ where: { id: t.id } })
      await prisma.pickingWave.delete({ where: { id: w.id } })
    } else {
      add('注入「未完成行程的司机与档位绑定不一致」→ 检查器报错', false, '缺少已绑档位或第二个司机账号')
    }
  }

  // ── 收尾：库必须回到开跑前的状态 ──────────────────────────────────────────
  {
    const after = await checkDriverIdentity(prisma)
    const same = after.every(f => f.bad === (base.get(f.key) ?? -1))
    add('自检清理干净：所有计数回到开跑前', same,
      after.map(f => `${f.key}=${f.bad}/${base.get(f.key)}`).join(' '))
  }

  await prisma.$disconnect()
  report()
}

function report() {
  const pass = cases.filter(c => c.state === 'pass').length
  const fail = cases.filter(c => c.state === 'fail').length
  console.log('\n司机身份校验器 · 自检（故意造分叉，看它会不会红）\n' + '='.repeat(78))
  for (const c of cases) {
    console.log(`${c.state === 'pass' ? '✅' : '❌'} ${c.name}\n     ${c.detail}`)
  }
  console.log('='.repeat(78))
  console.log(`通过 ${pass} · 失败 ${fail} · 共 ${cases.length}`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
