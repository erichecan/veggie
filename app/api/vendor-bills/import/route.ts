import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { round2 } from '@/lib/decimal-helpers'
import { parseImportFile, matchProducts, matchStats } from '@/lib/import-parser'

/**
 * 供应商账单 PDF/Excel/CSV 导入
 *
 * POST /api/vendor-bills/import  (multipart/form-data)
 *   file        — PDF / Excel(.xlsx/.xls) / CSV，最大 10MB
 *   supplierId  — 供应商 ID
 *   createDraft — 'false' 时仅返回解析预览，不创建草稿（默认创建）
 *
 * 解析文件提取行项目 → 按商品名模糊匹配 → 生成 DRAFT 状态供应商账单（仅含匹配到的行）。
 */
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const formData = await req.formData()
      const file = formData.get('file') as File | null
      const supplierId = formData.get('supplierId')?.toString().trim() ?? ''
      const createDraft = formData.get('createDraft') !== 'false'

      if (!file) return NextResponse.json({ error: '请上传文件' }, { status: 400 })
      if (!supplierId) return NextResponse.json({ error: '请选择供应商' }, { status: 400 })
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

      const allProducts = await prisma.product.findMany({ select: { id: true, name: true } })
      const parsedLines = matchProducts(rawLines, allProducts)

      let createdBill: { id: string; name: string } | null = null
      if (createDraft) {
        // 账单允许未匹配商品（仅凭名称登记应付），故全部行都纳入
        const lineCreates = parsedLines.map((l, idx) => {
          const subtotal = round2(l.quantity * l.unitCost)
          return {
            productId: l.matchedProductId,
            productName: l.matchedProductName ?? l.rawProductName,
            qty: l.quantity,
            unitCost: l.unitCost,
            taxRate: 0,
            subtotalExTax: subtotal,
            subtotalIncTax: subtotal,
            sequence: idx * 10,
          }
        })
        const subtotalExTax = round2(lineCreates.reduce((s, l) => s + l.subtotalExTax, 0))

        const count = await prisma.vendorBill.count()
        const name = `VB-${String(count + 1).padStart(5, '0')}`

        const bill = await prisma.vendorBill.create({
          data: {
            name,
            supplierId,
            billDate: new Date(),
            dueDate: null,
            notes: `从文件导入: ${file.name}`,
            status: 'DRAFT',
            subtotalExTax,
            totalTax: 0,
            totalIncTax: subtotalExTax,
            amountPaid: 0,
            amountDue: subtotalExTax,
            // VendorBill.lines 是 Json 列(无 VendorBillLine 模型),直接存数组,不能用关系 create(P1-6)
            lines: lineCreates,
          },
        })
        createdBill = { id: bill.id, name: bill.name }

        await writeLog({
          userId: user.userId, userEmail: user.email, userName: user.name,
          action: 'CREATE', resource: 'vendor_bill', resourceId: bill.id,
          detail: `从文件导入创建供应商账单 ${name} — ${lineCreates.length}行 — €${subtotalExTax}`,
        })
      }

      return NextResponse.json(serializeApi({
        ok: true,
        fileName: file.name,
        stats: matchStats(parsedLines),
        lines: parsedLines,
        createdBill,
      }))
    } catch (error) {
      console.error('[POST /api/vendor-bills/import]', error)
      return NextResponse.json({ error: '导入失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'FINANCE', 'WAREHOUSE'])
}
