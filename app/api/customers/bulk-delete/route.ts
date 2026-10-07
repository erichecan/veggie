import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { salesRowScope, isRowVisible } from '@/lib/row-scope'
import { findDeleteBlockers, type DeleteBlocker } from '@/lib/customer-delete'

/**
 * POST /api/customers/bulk-delete —— 删除 / 批量删除客户或供应商(20261007)
 * body: { ids: string[] }  → { deleted: [{id,name}], blocked: [{id,name,reasons}], notFound: number }
 *
 * 只物理删除"没有任何业务单据"的档案(规则见 lib/customer-delete.ts)；有单据的整条
 * 拒绝并说明原因，前端据此提示改用归档。一次请求里能删的删、不能删的列出来，互不影响。
 * 客户与供应商同表，供应商列表也走这里。
 */

const MAX_IDS = 200

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const body = await req.json().catch(() => ({}))
      const ids = Array.isArray(body.ids) ? [...new Set((body.ids as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0))] : []
      if (ids.length === 0) return NextResponse.json({ error: 'ids 不能为空' }, { status: 400 })
      if (ids.length > MAX_IDS) return NextResponse.json({ error: `单次最多删除 ${MAX_IDS} 条` }, { status: 400 })

      const found = await prisma.customer.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, salesUserId: true, salesUser: { select: { managerId: true } } },
      })
      // 行级隔离：看不到的档案按"不存在"处理，不泄露它存在与否
      const scope = salesRowScope(user)
      const visible = found.filter(c => isRowVisible(c, scope))
      const notFound = ids.length - visible.length

      const blockers = await findDeleteBlockers(visible.map(c => c.id))
      const blocked: Array<{ id: string; name: string; reasons: DeleteBlocker[] }> = []
      const deletable: Array<{ id: string; name: string }> = []
      for (const c of visible) {
        const reasons = blockers.get(c.id)
        if (reasons) blocked.push({ id: c.id, name: c.name, reasons })
        else deletable.push({ id: c.id, name: c.name })
      }

      const deleted: Array<{ id: string; name: string }> = []
      for (const c of deletable) {
        try {
          await prisma.$transaction(async (tx) => {
            // 采购建议是按需重算的临时数据，只把指向这个供应商的引用清掉
            await tx.purchaseSuggestion.updateMany({ where: { supplierId: c.id }, data: { supplierId: null } })
            await tx.customer.delete({ where: { id: c.id } })
          }, { timeout: 15000 })
          deleted.push(c)
          await writeLog({
            userId: user.userId, userEmail: user.email, userName: user.name,
            action: 'DELETE', resource: 'customer', resourceId: c.id,
            detail: `删除客户: ${c.name}`,
          })
        } catch (e) {
          console.error('[POST /api/customers/bulk-delete]', c.id, e)
          blocked.push({ id: c.id, name: c.name, reasons: [{ zh: '删除失败，请稍后重试', en: 'delete failed, please retry' }] })
        }
      }

      return NextResponse.json({ deleted, blocked, notFound })
    } catch (error) {
      console.error('[POST /api/customers/bulk-delete]', error)
      return NextResponse.json({ error: '删除失败' }, { status: 500 })
    }
  }, { require: 'master.customer.delete' })
}
