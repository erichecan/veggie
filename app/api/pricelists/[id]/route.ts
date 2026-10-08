import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog, diffChanges } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { normalizeItems } from '@/lib/pricelist-item'
import { diffPricelistItems } from '@/lib/pricelist-diff'
import { pricelistRuleLogChanges, writeProductRuleLogs } from '@/lib/pricelist-rule-log'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const pricelist = await prisma.odooPricelist.findUnique({ where: { id } })
    if (!pricelist) return NextResponse.json({ error: '价格表不存在' }, { status: 404 })
    return NextResponse.json(serializeApi(pricelist))
  } catch (error) {
    console.error('[GET /api/pricelists/[id]]', error)
    return NextResponse.json({ error: '获取价格表失败' }, { status: 500 })
  }
}

/**
 * PUT /api/pricelists/:id
 *
 * ── 商业级修复（2026-04-19） ─────────────────────────────────────────────
 * 1. 字段白名单：只接受明确允许的字段，过滤掉 id / createdAt / 关联字段
 * 2. Items 规范化：
 *    - 缺 id 的自动生成；id 重复的去重（保留首次出现）
 *    - fixedPrice/percentDiscount/priceDiscount/priceSurcharge 范围校验
 *    - applyOn 必须是 4 个合法值之一；对应字段必填
 * 3. 写审计日志含 items count / name 变更，以及逐条规则的改价 before → after(lib/pricelist-diff.ts)
 */

const ALLOWED_KEYS = new Set([
  'name', 'currency', 'items', 'sequence', 'selectable', 'active',
  'promotionalCode', 'notes', 'website', 'countryGroups',
])

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()

      // 白名单过滤
      const cleaned: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(data ?? {})) {
        if (ALLOWED_KEYS.has(k)) cleaned[k] = v
      }

      // 校验必填
      if (cleaned.name !== undefined) {
        const nm = String(cleaned.name).trim()
        cleaned.name = nm.slice(0, 200)
      }

      // items 规范化
      if (cleaned.items !== undefined) {
        cleaned.items = normalizeItems(cleaned.items)
      }

      // 强制 updatedAt = now
      cleaned.updatedAt = new Date()

      // 取旧数据做 diff（审计）
      const before = await prisma.odooPricelist.findUnique({ where: { id } })
      if (!before) return NextResponse.json({ error: '价格表不存在' }, { status: 404 })

      const pricelist = await prisma.odooPricelist.update({
        where: { id },
        data: cleaned as Parameters<typeof prisma.odooPricelist.update>[0]['data'],
      })

      // 字段级 diff
      const changed = diffChanges(
        before as unknown as Record<string, unknown>,
        pricelist as unknown as Record<string, unknown>,
        ['name', 'sequence', 'selectable', 'active', 'notes', 'currency'],
      )
      const beforeItems = (before.items as unknown[]) ?? []
      const afterItems = (pricelist.items as unknown[]) ?? []
      if (beforeItems.length !== afterItems.length) {
        changed.itemCount = { before: beforeItems.length, after: afterItems.length }
      }
      // 逐条规则的改价留痕(20261008)：价格表 chatter 记「商品 · 字段 before → after」，
      // 商品页按商品 id 另查(resource='pricelist-rule')
      const ruleChanges = cleaned.items !== undefined ? diffPricelistItems(beforeItems, afterItems) : []
      Object.assign(changed, await pricelistRuleLogChanges(ruleChanges))

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'pricelist', resourceId: id,
        detail: `更新价格表: ${pricelist.name || id} (items ${beforeItems.length} → ${afterItems.length})`,
        changes: Object.keys(changed).length > 0 ? changed : undefined,
      })
      await writeProductRuleLogs({ userId: user.userId, email: user.email, name: user.name }, pricelist.name || id, ruleChanges)
      return NextResponse.json(serializeApi(pricelist))
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: err.status })
      }
      console.error('[PUT /api/pricelists/[id]]', error)
      return NextResponse.json({ error: '更新价格表失败' }, { status: 500 })
    }
  }, { require: 'master.pricelist.update' })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      // 删除前看有没有客户在用，防止"孤儿客户"
      const inUse = await prisma.customerPricelist.count({ where: { pricelistId: id } })
      if (inUse > 0) {
        return NextResponse.json({
          error: `价格表被 ${inUse} 个客户使用中，无法删除。请先在客户管理里换成其他价格表。`,
        }, { status: 409 })
      }

      await prisma.odooPricelist.delete({ where: { id } })
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'pricelist', resourceId: id,
        detail: `删除价格表: ${id}`,
      })
      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/pricelists/[id]]', error)
      return NextResponse.json({ error: '删除价格表失败' }, { status: 500 })
    }
  }, { require: 'master.pricelist.delete' })
}
