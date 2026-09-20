/**
 * 修复 Customer.phone 字段被当备注用的历史数据（20260920）
 * ============================================================================
 * 背景：销售单表头 PAYMENT 格第二行直接印 `Customer.phone`
 * （lib/print/trip-sales-template.ts）。生产库里有 19 条记录的 phone 完全不含数字，
 * 装的其实是送货指令，于是「Dont Collet Any Money of This Order！！」
 * 「务必当场检查」「back door」这些话被印在客户拿到的销售单上。
 *
 * 处置分三类（客户 20260920 确认按性质分类）：
 *   - RELOCATE_EXTERNAL：真实送货指令/位置 → 追加到 externalNote（司机和客户单据上都看得到，
 *     语义正确），phone 清空
 *   - RELOCATE_INTERNAL：看不出确切含义、但可能有业务约定 → 追加到 notes（内部备注，
 *     不印在单据上），phone 清空。保留信息，避免误删
 *   - CLEAR：确定无意义（占位符、纯空白）→ phone 直接清空
 *
 * ⛔ 运行前必须已备份：backups/phone-backup-20260920.csv（含 phone/externalNote/notes 原值）
 *
 * 用法：
 *   DRY_RUN=1 npx tsx --tsconfig tsconfig.print-preview.json scripts/fix-phone-field-misuse-20260920.ts
 *   npx tsx --tsconfig tsconfig.print-preview.json scripts/fix-phone-field-misuse-20260920.ts
 */
import { prisma } from '@/lib/db'

type Action = 'RELOCATE_EXTERNAL' | 'RELOCATE_INTERNAL' | 'CLEAR'

/** 按客户名匹配，避免 id 在不同环境不一致 */
const PLAN: { name: string; action: Action; reason: string }[] = [
  { name: 'Dingding',                              action: 'RELOCATE_EXTERNAL', reason: '收款指令：这单不收钱' },
  { name: 'V Food Shop',                           action: 'RELOCATE_EXTERNAL', reason: '验收指令：务必当场检查' },
  { name: 'V Food Warehouse',                      action: 'RELOCATE_EXTERNAL', reason: '验收指令：务必当场检查' },
  { name: 'Ocean Blue River Ltd D1',               action: 'RELOCATE_EXTERNAL', reason: '送货指令：钥匙还给超市' },
  { name: 'Lams Chinese Takeaway LTD Ballyfermot', action: 'RELOCATE_EXTERNAL', reason: '送货位置：走后门' },
  { name: 'Slice & Spice',                         action: 'RELOCATE_EXTERNAL', reason: '送货位置：Supervalu 旁前门' },

  { name: 'JG-M1',                                 action: 'RELOCATE_INTERNAL', reason: 'ALL BEST：含义待确认，先留内部备注' },
  { name: 'Joyous Garden Rush',                    action: 'RELOCATE_INTERNAL', reason: 'ALL BEST：同上' },
  { name: 'OG-Cashel',                             action: 'RELOCATE_INTERNAL', reason: 'ALL BEST：同上' },
  { name: 'Orchid Garden-M7',                      action: 'RELOCATE_INTERNAL', reason: 'ALL BEST：同上' },
  { name: 'ABC Restaurant Ltd',                    action: 'RELOCATE_INTERNAL', reason: '与韩国海军：含义待确认' },
  { name: 'Dublin Christ Life Church',             action: 'RELOCATE_INTERNAL', reason: 'Donation：含义待确认' },
  { name: 'JUJUBE ASIAN LTD',                      action: 'RELOCATE_INTERNAL', reason: 'Tide Wok：疑似店铺别名' },
  { name: 'Aromance catering Ltd',                 action: 'RELOCATE_INTERNAL', reason: 'yummy yaki：疑似店铺别名' },

  { name: '818 Cake Studio D13',                   action: 'CLEAR',             reason: 'password：明显是误填' },
]

const DRY = process.env.DRY_RUN === '1'

function appendNote(existing: string | null | undefined, addition: string): string {
  const base = (existing ?? '').trim()
  if (!base) return addition
  if (base.includes(addition)) return base
  return `${base}\n${addition}`
}

async function main() {
  // Prisma 7 不接受 { not: null }，用 isNot 语义的等价写法：先全取再过滤（客户表 1590 行，无压力）
  const targets = await prisma.customer.findMany({
    select: { id: true, name: true, phone: true, externalNote: true, notes: true },
  })
  // 「完全不含数字」= 这个字段装的肯定不是电话号码。
  // 注意纯空白（' '）也要收进来 —— 它同样不是电话，下面走清空分支。
  const dirty = targets.filter(c => c.phone != null && c.phone !== '' && !/[0-9]/.test(c.phone))

  console.log(`${DRY ? '[DRY RUN] ' : ''}发现 ${dirty.length} 条 phone 不含数字的记录\n`)

  let relocatedExt = 0, relocatedInt = 0, cleared = 0, blanked = 0, unplanned = 0

  for (const c of dirty) {
    const phone = (c.phone ?? '').trim()
    const plan = PLAN.find(p => p.name === c.name)

    // 纯空白字符串：没有任何内容可保留，直接清空
    if (phone === '') {
      console.log(`  [空白] ${c.name} → 清空`)
      if (!DRY) await prisma.customer.update({ where: { id: c.id }, data: { phone: '' } })
      blanked += 1
      continue
    }

    if (!plan) {
      // 计划外的新增脏数据：只报告不处理，避免误伤
      console.log(`  ⚠️ [计划外] ${c.name} = ${JSON.stringify(phone)} —— 跳过，需人工确认`)
      unplanned += 1
      continue
    }

    if (plan.action === 'CLEAR') {
      console.log(`  [清空] ${c.name} = ${JSON.stringify(phone)}（${plan.reason}）`)
      if (!DRY) await prisma.customer.update({ where: { id: c.id }, data: { phone: '' } })
      cleared += 1
    } else if (plan.action === 'RELOCATE_EXTERNAL') {
      const next = appendNote(c.externalNote, phone)
      console.log(`  [→对外备注] ${c.name} = ${JSON.stringify(phone)}（${plan.reason}）`)
      if (!DRY) await prisma.customer.update({ where: { id: c.id }, data: { phone: '', externalNote: next } })
      relocatedExt += 1
    } else {
      const next = appendNote(c.notes, phone)
      console.log(`  [→内部备注] ${c.name} = ${JSON.stringify(phone)}（${plan.reason}）`)
      if (!DRY) await prisma.customer.update({ where: { id: c.id }, data: { phone: '', notes: next } })
      relocatedInt += 1
    }
  }

  console.log(`\n小计：对外备注 ${relocatedExt} · 内部备注 ${relocatedInt} · 清空 ${cleared} · 空白清理 ${blanked} · 计划外跳过 ${unplanned}`)

  if (!DRY) {
    const left = (await prisma.customer.findMany({
      select: { name: true, phone: true },
    })).filter(c => c.phone != null && c.phone !== '' && !/[0-9]/.test(c.phone))
    console.log(`\n验证：处理后仍有 ${left.length} 条 phone 不含数字${left.length ? '：' + left.map(c => c.name).join(', ') : '（符合预期）'}`)
  }
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
