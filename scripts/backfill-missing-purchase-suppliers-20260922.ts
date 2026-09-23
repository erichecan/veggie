/**
 * scripts/backfill-missing-purchase-suppliers-20260922.ts
 *
 * 给 import-odoo-purchase-orders-20260922.ts 打前站：dry-run 发现 844/15510 张历史采购单
 * （5.4%）的供应商在 veggie Customer(isVendor=true) 里找不到，集中在 8 个 Odoo partner：
 *
 *   externalId | Odoo 名称           | 处理           | 涉及采购单
 *   1428       | Begleys             | 翻 isVendor=true（已有孤儿记录） | 518
 *   1431       | Carnival Asia Food  | 新建                | 59
 *   1446       | Hansung             | 新建                | 53
 *   1952       | C.A.F. Trading Ltd  | 翻 isVendor=true（已有孤儿记录） | 40
 *   1769       | Just Parckaging     | 新建                | 15
 *   1468       | Ruskim              | 新建                | 12
 *   1834       | Lin Kee Ltd         | 新建                | 11
 *   1441       | Fresh Point         | 翻 isVendor=true（已有孤儿记录） | 57
 *   1440       | Freshchoi           | 新建                | 1
 *
 * 判断依据（20260922 与用户确认范围为"全部供应商"后，我自行判断的技术细节，不逐条打断）：
 *   - Begleys/Carnival Asia Food/Hansung/C.A.F. Trading Ltd 在 Odoo 里 supplier 复选框是 false
 *     （2026-07-14 那次"只导有效供应商"脚本因此没覆盖它们），但它们身上挂着真实的 purchase.order
 *     交易——有采购单本身就是供应商关系存在的证据，比 Odoo 一个可能没人维护的勾选框更可信，
 *     所以按供应商处理，不因为一个复选框状态丢弃真实交易历史
 *   - Freshchoi/Ruskim/Just Parckaging/Lin Kee Ltd 在 Odoo 里 supplier=true 但 active=false
 *     （已归档），2026-07-14 那次刷新只拉了 Odoo 的"有效供应商"列表所以漏了，这次按 isActive=false
 *     补建（不出现在下单选品，但历史采购单能看到正确供应商名）
 *   - **Test-Vendor**（externalId=1476, 17 张单）明显是 Odoo 里的测试/演示记录，不补，
 *     其名下 17 张采购单在主导入脚本里会继续被跳过（符合预期，不是 bug）
 *   - 找不到 Odoo res_partner 记录（externalId 在 Odoo 库里查无此 id，供应商外键悬空，
 *     是 Odoo 自己的数据问题）的采购单无法归属供应商，无法修复，直接跳过
 *
 * 运行：
 *   node --import tsx -r dotenv/config scripts/backfill-missing-purchase-suppliers-20260922.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/backfill-missing-purchase-suppliers-20260922.ts dotenv_config_path=.env.local --apply    # 实际写入
 */
import { createPrismaClient } from '@/lib/prisma-factory'

const prisma = createPrismaClient()
const APPLY = process.argv.includes('--apply')

const FLIP_EXISTING: { externalId: string; name: string }[] = [
  { externalId: '1428', name: 'Begleys' },
  { externalId: '1952', name: 'C.A.F. Trading Ltd' },
  { externalId: '1441', name: 'Fresh Point' },
]

const CREATE_NEW: { externalId: string; name: string; isActive: boolean }[] = [
  { externalId: '1431', name: 'Carnival Asia Food', isActive: false },
  { externalId: '1446', name: 'Hansung', isActive: false },
  { externalId: '1769', name: 'Just Parckaging', isActive: false },
  { externalId: '1468', name: 'Ruskim', isActive: false },
  { externalId: '1834', name: 'Lin Kee Ltd', isActive: false },
  { externalId: '1440', name: 'Freshchoi', isActive: false },
]

async function main() {
  console.log('=== 翻转已有孤儿记录（isVendor: false -> true）===')
  for (const f of FLIP_EXISTING) {
    const cust = await prisma.customer.findUnique({ where: { externalId: f.externalId } })
    if (!cust) { console.log(`  ⚠️ externalId=${f.externalId}(${f.name}) 找不到，跳过`); continue }
    console.log(`  ${cust.name} (externalId=${f.externalId}) isVendor: ${cust.isVendor} -> true`)
    if (APPLY) await prisma.customer.update({ where: { id: cust.id }, data: { isVendor: true } })
  }

  console.log('\n=== 新建缺失的供应商档案（仅供应商基本信息，来自 Odoo 历史采购单归属）===')
  for (const c of CREATE_NEW) {
    const existing = await prisma.customer.findUnique({ where: { externalId: c.externalId } })
    if (existing) { console.log(`  ⚠️ externalId=${c.externalId}(${c.name}) 已存在（${existing.name}），跳过新建`); continue }
    console.log(`  新建 ${c.name} (externalId=${c.externalId}, isVendor=true, isActive=${c.isActive})`)
    if (APPLY) {
      await prisma.customer.create({
        data: {
          name: c.name,
          externalId: c.externalId,
          isVendor: true,
          isCustomer: false,
          isActive: c.isActive,
        },
      })
    }
  }

  if (!APPLY) console.log('\n(dry-run，未写入。加 --apply 才会真正执行)')
  else console.log('\n✅ 完成')
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
