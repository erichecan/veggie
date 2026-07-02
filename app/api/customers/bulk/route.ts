import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'

/**
 * POST /api/customers/bulk — 客户批量导入(CSV)
 * body: { rows: [{ name*, phone?, email?, address?, city?, zip?, paymentTerm?, salesman?, vatNumber?, notes? }] }
 * 重名(不区分大小写)跳过,一次最多 500 行。
 */

const VALID_TERMS = new Set(['cash', 'weekly', 'monthly'])

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*\(/g, '(')
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const rows = Array.isArray(data.rows) ? data.rows : []
      if (rows.length === 0) return NextResponse.json({ error: 'rows 不能为空' }, { status: 400 })
      if (rows.length > 500) return NextResponse.json({ error: '一次最多导入 500 行' }, { status: 400 })

      // salesman 列是导入文件里的姓名文本,需要匹配到真实的 SALES 用户账号才能写 salesUserId
      const salesUsers = await prisma.user.findMany({
        where: { OR: [{ role: 'SALES' }, { roles: { has: 'SALES' } }] },
        select: { id: true, name: true },
      })
      const salesUserByName = new Map(salesUsers.map(u => [normalizeName(u.name), u.id]))
      const unmatchedSalesman = new Set<string>()

      const cleaned = rows
        .map((r: Record<string, unknown>) => {
          const salesmanRaw = r.salesman ? String(r.salesman).trim().slice(0, 100) : ''
          let salesUserId: string | null = null
          if (salesmanRaw) {
            salesUserId = salesUserByName.get(normalizeName(salesmanRaw)) ?? null
            if (!salesUserId) unmatchedSalesman.add(salesmanRaw)
          }
          return {
            // phone/email/address/zip/vatNumber 在 schema 中非空(默认 ""),不可传 null
            name: String(r.name ?? '').trim().slice(0, 200),
            phone: r.phone ? String(r.phone).trim().slice(0, 50) : '',
            email: r.email ? String(r.email).trim().slice(0, 200) : '',
            address: r.address ? String(r.address).trim().slice(0, 500) : '',
            city: r.city ? String(r.city).trim().slice(0, 100) : null,
            zip: r.zip ? String(r.zip).trim().slice(0, 20) : '',
            paymentTerm: VALID_TERMS.has(String(r.paymentTerm ?? '').toLowerCase())
              ? String(r.paymentTerm).toLowerCase()
              : 'monthly',
            salesUserId,
            vatNumber: r.vatNumber ? String(r.vatNumber).trim().slice(0, 50) : '',
            notes: r.notes ? String(r.notes).trim().slice(0, 1000) : null,
          }
        })
        .filter((r: { name: string }) => r.name.length > 0)

      if (cleaned.length === 0) {
        return NextResponse.json({ error: '没有有效行(name 必填)' }, { status: 400 })
      }

      // 重名跳过:与库内现有客户名 + 本批次内部去重(不区分大小写)
      const existing = await prisma.customer.findMany({ select: { name: true } })
      const taken = new Set(existing.map(c => c.name.toLowerCase()))
      const toCreate: typeof cleaned = []
      const skipped: string[] = []
      for (const r of cleaned) {
        const key = r.name.toLowerCase()
        if (taken.has(key)) { skipped.push(r.name); continue }
        taken.add(key)
        toCreate.push(r)
      }

      if (toCreate.length > 0) {
        await prisma.customer.createMany({ data: toCreate })
      }

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'customer', resourceId: 'bulk',
        detail: `批量导入客户:成功 ${toCreate.length},重名跳过 ${skipped.length}`,
      })
      return NextResponse.json({
        created: toCreate.length,
        skipped,
        // 导入文件里的业务员姓名匹配不到任何 SALES 账号,这些行的 salesUserId 已置空,需要事后手动补
        unmatchedSalesman: [...unmatchedSalesman],
      })
    } catch (error) {
      console.error('[POST /api/customers/bulk]', error)
      return NextResponse.json({ error: '批量导入失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS'])
}
