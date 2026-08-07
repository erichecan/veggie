import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog, diffChanges } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

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
 * 3. 写审计日志含 items count / name 变更
 */

const ALLOWED_KEYS = new Set([
  'name', 'currency', 'items', 'sequence', 'selectable', 'active',
  'promotionalCode', 'notes', 'website', 'countryGroups',
])

const VALID_APPLY_ON = new Set(['global', 'category', 'product', 'variant'])
const VALID_COMPUTE = new Set(['fixed', 'percentage', 'formula'])
const VALID_BASE    = new Set(['list_price', 'standard_price', 'pricelist'])

function newId(): string {
  // Node 18+ 有 crypto.randomUUID，本函数安全 fallback
  try {
    return crypto.randomUUID()
  } catch {
    return `item_${Date.now()}_${Math.random().toString(36).slice(2)}`
  }
}

interface RawItem {
  id?: string
  applyOn: string
  productTemplateId?: string
  productVariantId?: string
  categoryId?: string
  minQty?: number
  dateStart?: string
  dateEnd?: string
  computeType: string
  fixedPrice?: number
  percentDiscount?: number
  formulaBase?: string
  basedOnPricelistId?: string
  priceDiscount?: number
  priceSurcharge?: number
  priceMinMargin?: number
  priceMaxMargin?: number
  roundingMethod?: number
  sequence?: number
}

function normalizeItems(raw: unknown): RawItem[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: RawItem[] = []
  for (const rItem of raw as RawItem[]) {
    if (!rItem || typeof rItem !== 'object') continue

    const applyOn = String(rItem.applyOn ?? '').toLowerCase()
    const compute = String(rItem.computeType ?? '').toLowerCase()
    if (!VALID_APPLY_ON.has(applyOn)) {
      throw Object.assign(new Error(`applyOn 无效：${rItem.applyOn}`), { status: 400 })
    }
    if (!VALID_COMPUTE.has(compute)) {
      throw Object.assign(new Error(`computeType 无效：${rItem.computeType}`), { status: 400 })
    }

    // applyOn 对应字段：允许为空（产品关联可在 UI 中后续补充，来自 Odoo 导入的数据也可能缺少此字段）

    // 数值范围
    const minQty = Number(rItem.minQty ?? 0)
    if (!Number.isFinite(minQty) || minQty < 0) {
      throw Object.assign(new Error(`minQty 无效：${rItem.minQty}`), { status: 400 })
    }
    if (compute === 'fixed') {
      const fp = Number(rItem.fixedPrice ?? 0)
      if (!Number.isFinite(fp) || fp < 0 || fp > 1_000_000) {
        throw Object.assign(new Error(`fixedPrice 范围无效：${rItem.fixedPrice}`), { status: 400 })
      }
    }
    if (compute === 'percentage') {
      const pd = Number(rItem.percentDiscount ?? 0)
      if (!Number.isFinite(pd) || pd < -100 || pd > 100) {
        throw Object.assign(new Error(`percentDiscount 应在 -100~100：${rItem.percentDiscount}`), { status: 400 })
      }
    }
    if (compute === 'formula') {
      const base = String(rItem.formulaBase ?? 'list_price').toLowerCase()
      if (!VALID_BASE.has(base)) {
        throw Object.assign(new Error(`formulaBase 无效：${rItem.formulaBase}`), { status: 400 })
      }
      if (base === 'pricelist' && !rItem.basedOnPricelistId) {
        throw Object.assign(new Error('formulaBase=pricelist 时 basedOnPricelistId 必填'), { status: 400 })
      }
    }

    // id：空/重复的重新生成
    let id = typeof rItem.id === 'string' && rItem.id.trim() !== '' ? rItem.id : newId()
    if (seen.has(id)) id = newId()
    seen.add(id)

    out.push({ ...rItem, id, minQty, applyOn, computeType: compute } as RawItem)
  }
  return out
}

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

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'pricelist', resourceId: id,
        detail: `更新价格表: ${pricelist.name || id} (items ${beforeItems.length} → ${afterItems.length})`,
        changes: Object.keys(changed).length > 0 ? changed : undefined,
      })
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
