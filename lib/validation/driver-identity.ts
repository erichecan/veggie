/**
 * 司机身份单一真相校验（台账 C6）
 * ============================================================================
 * 需求原文点名了这条**翻过车**：`Order.driverSlotId` 与 `wave.orderIds` 曾是两套
 * 真相，导致详情页显示与编辑态司机名不一致、57 单历史脏数据，且发票 PDF 与日报
 * 两条打印路径漏注入，102 单里 83 单司机错（20260708）。
 *
 * 所以这里不是"查一遍就完事"，而是把「司机只有一处真相」写成可长期复跑的不变量，
 * 接进 `npm run db:validate`。链条是：
 *
 *     User（登录身份）
 *       ↑ DriverSlot.userId          ← 档位绑到人
 *     DriverSlot（配送中心的档位）
 *       ↑ PickingWave.driverSlotId   ← 波次派给档位
 *     PickingWave.orderIds（调度的唯一真相）
 *       ↓                    ↓
 *     Order.driverSlotId    Trip.driverId / driverName（司机端按 driverId 查）
 *
 * 每一层往下派生，任何一层自己存一份就是分叉。下面每条不变量守的都是某一处派生
 * 与源头对不上。
 *
 * ## 哪些「不一致」是合法的，不能当违例
 *
 * - **司机改名**：`DriverSlot.driverName` 改了之后，历史 `Trip.driverName` 保留旧名
 *   —— 这是 20260705 定的规则（改名只对未来生效，快照不级联）。所以「同一个
 *   driverId 挂过多个名字」是正常的，只作提示不算错。
 * - **手工建的 Trip**（没有 waveId）：不受波次那几条约束，跳过而不是判错。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export interface IdentityFinding {
  /** 不变量的短名，用于报表标题 */
  key: string
  title: string
  bad: number
  total: number
  examples: string[]
  /** true = 只是提示，不参与 db:validate 的成败判定 */
  advisory?: boolean
}

const MAX_EX = 3

/**
 * 跑全部司机身份不变量。
 * 返回顺序即报告顺序：从源头（档位绑人）往下游（订单/行程）排。
 */
export async function checkDriverIdentity(prisma: Db): Promise<IdentityFinding[]> {
  const out: IdentityFinding[] = []

  const slots = await prisma.driverSlot.findMany({
    select: { id: true, driverName: true, userId: true, archived: true, timeOfDay: true, batchNum: true },
  })
  const slotById = new Map<string, (typeof slots)[number]>(slots.map((s: { id: string }) => [s.id, s]))
  const activeSlots = slots.filter((s: { archived: boolean }) => !s.archived)

  // ── 1. 在用档位必须绑到系统账号 ────────────────────────────────────────────
  // 不绑 → 确认出发生成的 Trip.driverId 为空 → 司机端一条任务都看不到（C4 实测）。
  {
    const bad = activeSlots.filter((s: { userId: string | null }) => !s.userId)
    out.push({
      key: 'slot_bound',
      title: '司机档位已绑系统账号（不绑则司机端看不到任务）',
      bad: bad.length,
      total: activeSlots.length,
      examples: bad.slice(0, MAX_EX).map((s: { timeOfDay: string; batchNum: number; driverName: string }) =>
        `${s.timeOfDay.toUpperCase()}-${s.batchNum} ${s.driverName} 未绑账号`),
    })
  }

  // ── 2. 档位绑的必须是真实存在、启用中的 DRIVER 账号 ────────────────────────
  {
    const userIds = [...new Set(activeSlots.map((s: { userId: string | null }) => s.userId).filter(Boolean))] as string[]
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, role: true, roles: true, isActive: true },
        })
      : []
    const userById = new Map(users.map((u: { id: string }) => [u.id, u]))
    const ex: string[] = []
    let bad = 0
    for (const s of activeSlots) {
      if (!s.userId) continue
      const u = userById.get(s.userId) as
        { name: string; role: string; roles: string[]; isActive: boolean } | undefined
      const rolesOf = u ? (u.roles?.length ? u.roles : [u.role]) : []
      const ok = !!u && u.isActive !== false && rolesOf.includes('DRIVER')
      if (!ok) {
        bad++
        if (ex.length < MAX_EX) {
          ex.push(!u
            ? `档位「${s.driverName}」绑的账号 ${s.userId} 不存在`
            : `档位「${s.driverName}」绑的是 ${u.name}（角色 ${rolesOf.join('/')}${u.isActive === false ? '，已停用' : ''}）`)
        }
      }
    }
    out.push({
      key: 'slot_user_valid',
      title: '档位绑的是真实、启用中的 DRIVER 账号',
      bad, total: activeSlots.filter((s: { userId: string | null }) => !!s.userId).length, examples: ex,
    })
  }

  // ── 3. 一张订单不能同时挂在两个司机的行程上 ────────────────────────────────
  // 这才是需求说的「司机来源不一致」：同一单被两个人拿着，谁去送、谁收钱、
  // 提成算给谁全乱套。20260708 翻车的那次就是这个形态（显示一个、编辑态另一个）。
  //
  // ⚠️ **不比 `Order.driverSlotId` 与波次是否相等** —— 第一版这么写，报出 15 条
  // 假阳性。SSOT 设计（lib/wave-assign.ts 开头）写得很清楚：「这单归谁送」只存在
  // wave 上，`Order.driverSlotId` 是下单意向的存量值，**既不被信任也不再回写**，
  // 显示一律由「包含该订单的 wave + 实时 DriverSlot」派生。
  // 要求两者相等等于要求系统违背自己的 SSOT。
  {
    const trips = await prisma.trip.findMany({
      select: { id: true, name: true, driverId: true, driverName: true, restaurants: true },
    })
    const byOrder = new Map<string, Array<{ trip: string; driver: string }>>()
    for (const t of trips) {
      const rests = (Array.isArray(t.restaurants) ? t.restaurants : []) as Array<{ orderIds?: string[] }>
      for (const r of rests) {
        for (const oid of r.orderIds ?? []) {
          const who = t.driverId ?? `name:${t.driverName ?? '?'}`
          const list = byOrder.get(oid) ?? []
          list.push({ trip: t.name ?? t.id, driver: who })
          byOrder.set(oid, list)
        }
      }
    }
    const ex: string[] = []
    let bad = 0
    for (const [oid, list] of byOrder) {
      const distinct = new Set(list.map(l => l.driver))
      if (distinct.size > 1) {
        bad++
        if (ex.length < MAX_EX) {
          ex.push(`订单 ${oid} 同时挂在 ${list.map(l => `「${l.trip}」`).join(' 和 ')} 上，司机不是同一个`)
        }
      }
    }
    out.push({
      key: 'order_single_driver',
      title: '一张订单只挂在一个司机的行程上（司机来源不一致数）',
      bad, total: byOrder.size, examples: ex,
    })
  }

  // ── 3b. 提示项：下单意向与实际调度不同 ─────────────────────────────────────
  // `Order.driverSlotId` 是下单时按客户默认档位填的意向值，排波次后不回写。
  // 两者不同**完全正常**（客户默认给 BAO，今天实际派给了 SEAN），所以只作提示：
  // 数量异常地高时，可能说明有人在拿这个存量列当司机来源读。
  {
    const waves = await prisma.pickingWave.findMany({
      select: { orderIds: true, driverSlotId: true },
    })
    const slotByOrder = new Map<string, string | null>()
    for (const w of waves) {
      for (const oid of (w.orderIds as string[]) ?? []) slotByOrder.set(oid, w.driverSlotId)
    }
    const withSlot = [...slotByOrder.entries()].filter(([, sid]) => sid)
    const orders = withSlot.length
      ? await prisma.order.findMany({
          where: { id: { in: withSlot.map(([oid]) => oid) } },
          select: { id: true, code: true, driverSlotId: true },
        })
      : []
    const ex: string[] = []
    let differ = 0
    for (const o of orders) {
      const actual = slotByOrder.get(o.id) ?? null
      if (o.driverSlotId && o.driverSlotId !== actual) {
        differ++
        if (ex.length < MAX_EX) {
          ex.push(`订单 ${o.code ?? o.id}：下单意向「${slotById.get(o.driverSlotId)?.driverName ?? o.driverSlotId}」，实际派给「${actual ? slotById.get(actual)?.driverName ?? actual : '（未派）'}」`)
        }
      }
    }
    out.push({
      key: 'order_intent_vs_actual',
      title: '下单意向与实际调度不同（正常现象，仅供观察）',
      bad: differ, total: orders.length, examples: ex,
      advisory: true,
    })
  }

  // ── 4. 行程的司机身份 == 波次档位绑的账号 ──────────────────────────────────
  // 司机端按 Trip.driverId 查任务，这一层错了司机现在就看不到任务。
  //
  // ⚠️ 只校验**未跑完**的行程。`Trip.driverId` 是派车那一刻的快照，档位后来改绑
  // 到别人（换司机、离职），历史行程不该跟着变 —— 与「改名不级联」是同一个道理。
  // （TripStatus 只有 PENDING/PENDING_ASSIGNMENT/VERIFYING/IN_PROGRESS/COMPLETED，没有 SETTLED；
  //  交账状态在 settlementStatus 那个独立字段上。）
  // 第一版没限状态，165 条里报出 125 条：全是给档位补绑账号之前生成的历史行程。
  {
    const trips = await prisma.trip.findMany({
      where: { waveId: { not: null }, status: { notIn: ['COMPLETED'] } },
      select: { id: true, name: true, waveId: true, driverId: true, driverName: true },
    })
    const waveIds = [...new Set(trips.map((t: { waveId: string | null }) => t.waveId).filter(Boolean))] as string[]
    const waves = waveIds.length
      ? await prisma.pickingWave.findMany({
          where: { id: { in: waveIds } },
          select: { id: true, name: true, driverSlotId: true },
        })
      : []
    const waveById = new Map(waves.map((w: { id: string }) => [w.id, w]))
    const ex: string[] = []
    let bad = 0
    for (const t of trips) {
      const w = waveById.get(t.waveId as string) as { name: string | null; driverSlotId: string | null } | undefined
      if (!w?.driverSlotId) continue          // 波次没派档位，无从比对
      const slot = slotById.get(w.driverSlotId)
      if (!slot) continue
      // 档位没绑账号时，Trip.driverId 为空是**正确**的派生结果 —— 那由第 1 条负责报
      if (!slot.userId) continue
      if (t.driverId !== slot.userId) {
        bad++
        if (ex.length < MAX_EX) {
          ex.push(`行程「${t.name ?? t.id}」driverId=${t.driverId ?? '（空）'}，但波次派的档位「${slot.driverName}」绑的是 ${slot.userId}`)
        }
      }
    }
    out.push({
      key: 'trip_slot_user',
      title: '未完成行程的司机身份 == 波次档位绑定的账号（司机端据此查任务）',
      bad, total: trips.length, examples: ex,
    })
  }

  // ── 5. 行程上的司机名 == 档位当时的司机名 ──────────────────────────────────
  // 只在 driverId 对得上时才比名字：名字是快照，改名不级联（20260705 的规则），
  // 所以这里比的是「同一个人的名字有没有被写成别人」，不是「有没有跟上最新名字」。
  {
    const trips = await prisma.trip.findMany({
      where: { waveId: { not: null }, driverId: { not: null } },
      select: { id: true, name: true, driverId: true, driverName: true },
    })
    const ids = [...new Set(trips.map((t: { driverId: string | null }) => t.driverId).filter(Boolean))] as string[]
    const users = ids.length
      ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      : []
    const nameById = new Map(users.map((u: { id: string; name: string }) => [u.id, u.name]))
    const ex: string[] = []
    let bad = 0
    for (const t of trips) {
      if (!nameById.has(t.driverId as string)) {
        bad++
        if (ex.length < MAX_EX) ex.push(`行程「${t.name ?? t.id}」的 driverId ${t.driverId} 查无此人`)
      }
    }
    out.push({
      key: 'trip_driver_exists',
      title: '行程上的 driverId 都指向真实存在的用户',
      bad, total: trips.length, examples: ex,
    })
  }

  // ── 6. 提示项：同一个 driverId 挂过多个名字 ────────────────────────────────
  // **不算违例**：司机改名后历史行程保留旧名是有意设计。但如果一个 id 下挂着
  // 几个毫不相干的名字，那多半是建 Trip 时 driverId 填了同一个占位值
  // （测试库的种子就是这样，H3 按司机筛选因此筛不动）。所以报出来供人看。
  {
    const trips = await prisma.trip.findMany({
      where: { driverId: { not: null } },
      select: { driverId: true, driverName: true },
    })
    const namesById = new Map<string, Set<string>>()
    for (const t of trips) {
      const id = t.driverId as string
      const set = namesById.get(id) ?? new Set<string>()
      if (t.driverName) set.add(t.driverName)
      namesById.set(id, set)
    }
    const multi = [...namesById.entries()].filter(([, s]) => s.size > 1)
    out.push({
      key: 'driver_id_name_fanout',
      title: '同一 driverId 对应多个司机名（改名是正常的，但也可能是 id 填成了占位值）',
      bad: multi.length,
      total: namesById.size,
      examples: multi.slice(0, MAX_EX).map(([id, s]) => `${id} → ${[...s].join(' / ')}`),
      advisory: true,
    })
  }

  return out
}
