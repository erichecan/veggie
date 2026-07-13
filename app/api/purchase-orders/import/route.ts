import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { round2 } from '@/lib/decimal-helpers'
import { parseImportFile, matchProducts, matchStats } from '@/lib/import-parser'

/**
 * P0-2: 采购单 PDF/Excel 导入
 *
 * POST /api/purchase-orders/import
 * Content-Type: multipart/form-data
 *
 * Fields:
 *   file       — PDF or Excel file (.pdf / .xlsx / .xls / .csv)
 *   supplierId — 供应商 ID
 *
 * 逻辑：
 * 1. 解析文件提取行项目（productName, qty, unitCost）
 * 2. 按 productName 模糊匹配已有商品
 * 3. 生成 DRAFT 状态的采购订单
 * 4. 返回解析结果 + 匹配情况（前端可再修正后确认）
 */

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const formData = await req.formData()
      const file = formData.get('file') as File | null
      const supplierId = formData.get('supplierId')?.toString().trim() ?? ''
      const createDraft = formData.get('createDraft') !== 'false'

      if (!file) {
        return NextResponse.json({ error: '请上传文件' }, { status: 400 })
      }
      if (!supplierId) {
        return NextResponse.json({ error: '请选择供应商' }, { status: 400 })
      }

      // 文件大小限制 10MB
      if (file.size > 10 * 1024 * 1024) {
        return NextResponse.json({ error: '文件不能超过 10MB' }, { status: 400 })
      }

      const buffer = Buffer.from(await file.arrayBuffer())

      let rawLines
      try {
        rawLines = await parseImportFile(file.name, buffer)
      } catch {
        return NextResponse.json(
          { error: '不支持的文件格式，请上传 PDF / Excel / CSV' },
          { status: 400 },
        )
      }

      if (rawLines.length === 0) {
        return NextResponse.json({ error: '未能从文件中解析到商品数据' }, { status: 400 })
      }

      // 从数据库获取所有商品用于匹配
      const allProducts = await prisma.product.findMany({
        select: { id: true, name: true },
      })
      const parsedLines = matchProducts(rawLines, allProducts)

      // 如果 createDraft=true 且有匹配结果，自动创建 DRAFT PO
      let createdPO = null
      if (createDraft) {
        const matchedLines = parsedLines.filter(l => l.matchedProductId)
        if (matchedLines.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const p = prisma as any
          const count = await p.purchaseOrder.count()
          const name = `PO-${String(count + 1).padStart(5, '0')}`

          let subtotalExTax = 0
          const lineData = matchedLines.map((l, idx) => {
            const ex = round2(l.quantity * l.unitCost)
            subtotalExTax += ex
            return {
              productId: l.matchedProductId!,
              productName: l.matchedProductName ?? l.rawProductName,
              orderedQty: l.quantity,
              receivedQty: 0,
              invoicedQty: 0,
              unitCost: l.unitCost,
              taxRate: 0,
              subtotalExTax: ex,
              taxAmount: 0,
              subtotalIncTax: ex,
              // 导入固定 EUR，汇率恒 1，Eur 字段直接等于原币字段(20260713 汇率换算改造)
              unitCostEur: l.unitCost,
              subtotalExTaxEur: ex,
              taxAmountEur: 0,
              subtotalIncTaxEur: ex,
              sequence: idx * 10,
            }
          })
          subtotalExTax = round2(subtotalExTax)

          createdPO = await p.purchaseOrder.create({
            data: {
              name,
              supplierId,
              status: 'DRAFT',
              orderDate: new Date(),
              currency: 'EUR',
              subtotalExTax,
              totalTax: 0,
              totalIncTax: subtotalExTax,
              subtotalExTaxEur: subtotalExTax,
              totalTaxEur: 0,
              totalIncTaxEur: subtotalExTax,
              freightAmountEur: 0,
              notes: `从文件导入: ${file.name}`,
              createdBy: user.userId,
              lines: { create: lineData },
            },
            include: { lines: true },
          })

          await writeLog({
            userId: user.userId, userEmail: user.email, userName: user.name,
            action: 'CREATE', resource: 'purchase_order',
            resourceId: createdPO.id,
            detail: `从文件导入创建采购订单 ${name} — ${matchedLines.length}行 — €${subtotalExTax}`,
          })
        }
      }

      const stats = matchStats(parsedLines)

      return NextResponse.json(serializeApi({
        ok: true,
        fileName: file.name,
        stats,
        lines: parsedLines,
        createdPO: createdPO ? { id: createdPO.id, name: createdPO.name } : null,
      }))
    } catch (error) {
      console.error('[POST /api/purchase-orders/import]', error)
      return NextResponse.json({ error: '导入失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'WAREHOUSE'])
}
