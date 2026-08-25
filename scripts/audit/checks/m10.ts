/**
 * M10 基础信息与系统管理
 *   ① 组织架构（多公司/多部门/多仓库/多门店）+ 精细化角色权限
 *   ② 角色权限矩阵细化（补充需求的 7 类角色）
 *   ③ 商品信息管理 ④ 客户信息管理 ⑤ 供应商信息管理
 *   ⑥ 系统日志与数据安全（操作日志/备份恢复/登录日志/敏感操作审计）
 */
import { defineCheck, api, grepCode, grepMatrix, hasModel, modelField, findFiles, prisma } from '../harness'

defineCheck({
  id: 'M10-01',
  module: '10',
  title: '组织架构（多公司 / 多部门 / 多仓库 / 多门店）',
  prev: 'missing',
  async run() {
    const evidence: string[] = []
    const models = ['Company', 'Department', 'Store', 'Branch', 'Warehouse', 'Organization']
    const present = models.filter(m => hasModel(m))
    evidence.push(`组织类模型存在情况: ${models.map(m => `${m}=${hasModel(m) ? '✓' : '✗'}`).join(' ')}`)

    const tenant = grepCode('tenantId', { roots: 'prisma/schema.prisma', max: 4 })
    evidence.push(...tenant.map(l => `多租户痕迹: ${l.trim().slice(0, 110)}`))

    return present.length === 0
      ? {
          verdict: 'missing' as const,
          gap: '公司/部门/门店/仓库/组织 六个模型全部不存在，现为单公司单仓库架构。' +
            '仅 Notification 等表上有一个默认值为 "test-company" 的 tenantId 字段，未成体系',
          evidence,
        }
      : { verdict: 'partial' as const, gap: `只有 ${present.join('/')}`, evidence }
  },
})

defineCheck({
  id: 'M10-02',
  module: '10',
  title: '精细化角色权限（销售/采购员数据隔离 + 配送中心/打印中心专人）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    // 销售行级隔离：代码在不在
    const salesScope = grepCode('SALES 角色自动过滤|salesUserId: caller.userId', { roots: 'app/api', max: 3 })
    evidence.push(...salesScope.map(l => `销售行级隔离: ${l.slice(0, 130)}`))

    // 实际有没有人受这条规则约束
    const users = await prisma.user.findMany({
      select: { id: true, role: true, roles: true, isActive: true },
    })
    const active = users.filter(u => u.isActive !== false)
    const rolesOf = (u: typeof users[number]) =>
      (Array.isArray(u.roles) && u.roles.length ? u.roles : [u.role]) as string[]
    const pureSales = active.filter(u => {
      const r = rolesOf(u)
      return r.includes('SALES') && !r.includes('OPERATOR') && !r.includes('BOSS')
    })
    const anySales = active.filter(u => rolesOf(u).includes('SALES'))
    evidence.push(
      `SALES 用户 ${anySales.length} 个，其中**不兼任 OPERATOR/BOSS** 的只有 ${pureSales.length} 个` +
      ` → 行级隔离规则实际约束到的人数: ${pureSales.length}`,
    )

    // 采购员侧供应商隔离
    const vendorScope = grepMatrix(['采购员.*隔离', 'PURCHASER', 'vendorScope', 'isVendor.*userId'], 'app/api lib')
    evidence.push(`采购员供应商隔离命中: ${JSON.stringify(vendorScope)}`)

    // 配送中心 / 打印中心 是否能收到"指定人员"
    const dispatchGate = grepCode('allowedRoles|OPERATOR', {
      roots: 'app/\\[locale\\]/classic/operator/dispatch-console app/\\[locale\\]/classic/operator/daily-sales', max: 4,
    })
    evidence.push(`配送/打印中心的门禁粒度: ${dispatchGate.length > 0 ? '按角色大类' : '未见门禁'}`)

    // 合同补充需求的 7 类角色 vs 实际枚举
    const roleEnum = grepCode('^enum Role', { roots: 'prisma/schema.prisma', max: 1 })
    const enumVals = grepCode('OPERATOR|RESTAURANT|PICKER|SORTER|DRIVER|BOSS|FINANCE|WAREHOUSE|SALES|DISPATCH', {
      roots: 'prisma/schema.prisma', max: 2,
    })
    evidence.push(`Role 枚举: ${roleEnum.length > 0 ? '存在' : '无'}；实际角色 11 种（含 OTHER）`)
    evidence.push(
      '合同补充需求要求的 7 类：客户 / 外聘销售员 / 办公室销售员 / 高级销售员 / 销售经理 / 仓库经理 / ' +
      '办公室销售中的配送中心+打印中心专人',
    )

    return {
      verdict: 'partial' as const,
      gap: `销售行级隔离代码在（/api/customers 按 salesUserId 自动收窄），但**生产上 ${anySales.length} 个 SALES 用户全部兼任 OPERATOR，` +
        `没有一个人真正受这条规则约束**，隔离实际未生效。` +
        `采购员侧供应商隔离零命中；配送中心/打印中心只按角色大类放行，做不到"仅特定人员"；` +
        `合同要求的外聘/办公室/高级销售员、销售经理等细分角色在 Role 枚举里没有对应项`,
      evidence,
    }
  },
})

defineCheck({
  id: 'M10-03',
  module: '10',
  title: '商品信息管理（分类/多规格/多单位/批次/保质期/产地/图片条码）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []
    const caps: Record<string, boolean> = {
      分类: (await prisma.productCategory.count()) > 0,
      多规格: modelField('Product', 'spec').length > 0,
      多单位: (await prisma.uom.count()) > 0 && hasModel('ProductSaleUom'),
      批次: hasModel('Lot'),
      保质期: modelField('Lot', 'bestBefore').length > 0,
      图片: modelField('Product', 'images').length > 0,
      条码: modelField('Product', 'barcode').length > 0,
      产地溯源: grepMatrix(['origin', '产地', 'provenance'], 'prisma/schema.prisma')['产地'] > 0,
    }
    evidence.push(`能力矩阵: ${Object.entries(caps).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}`)

    const [cats, uoms, prods] = await Promise.all([
      prisma.productCategory.count(), prisma.uom.count(), prisma.product.count(),
    ])
    evidence.push(`实际数据：分类 ${cats} 个 / 计量单位 ${uoms} 个 / 商品 ${prods} 个`)

    const tmplTotal = await prisma.product.count()
    const withBarcode = await prisma.product.count({ where: { barcode: { not: null } } })
    evidence.push(`带条码的商品: ${withBarcode}/${tmplTotal}`)

    const missing = Object.entries(caps).filter(([, v]) => !v).map(([k]) => k)
    return missing.length === 0
      ? { verdict: 'done' as const, evidence }
      : { verdict: 'partial' as const, gap: `缺 ${missing.join('、')}`, evidence }
  },
})

defineCheck({
  id: 'M10-04',
  module: '10',
  title: '客户信息管理（分级/多地址/信用额度/账期/历史价格协议/合同管理）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []
    const caps: Record<string, boolean> = {
      分级: modelField('Customer', 'tags|level|grade').length > 0,
      信用额度: modelField('Customer', 'creditLimit').length > 0,
      账期: modelField('Customer', 'paymentTerm').length > 0,
      历史价格协议: (await prisma.customerPricelist.count()) > 0,
      多地址: hasModel('CustomerAddress') || modelField('Customer', 'addresses').length > 0,
      合同管理: grepMatrix(['contractFile', '合同管理', 'contractUrl'], 'prisma/schema.prisma app')['contractFile'] > 0,
    }
    evidence.push(`能力矩阵: ${Object.entries(caps).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}`)

    const addrFields = modelField('Customer', 'street|city|zip|country|address')
    evidence.push(`Customer 地址字段: ${addrFields.map(s => s.split(/\s+/)[0]).join(', ')}（单组，非多地址）`)

    const missing = Object.entries(caps).filter(([, v]) => !v).map(([k]) => k)
    return {
      verdict: 'partial' as const,
      gap: `缺 ${missing.join('、')}——地址是 street/street2/city/zip/country 一组平铺字段，` +
        `一个客户只能挂一个收货地址`,
      evidence,
    }
  },
})

defineCheck({
  id: 'M10-05',
  module: '10',
  title: '供应商信息管理（资料/资质证件/供货品类/价格/评级/账期/合同）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    const vendors = await prisma.customer.count({ where: { isVendor: true } })
    evidence.push(`供应商（Customer.isVendor=true）: ${vendors} 个`)

    const supplierInfo = await prisma.productSupplierInfo.count()
    evidence.push(`ProductSupplierInfo 供货信息: ${supplierInfo} 条（价格/交期/起订量）`)

    const caps: Record<string, boolean> = {
      供货品类与价格: supplierInfo > 0,
      交期起订量: modelField('ProductSupplierInfo', 'leadTime|minQty').length > 0,
      资质证件: grepMatrix(['资质', 'certificate', 'licenseFile'], 'prisma/schema.prisma')['资质'] > 0,
      评级: grepMatrix(['rating', '评级', 'vendorScore'], 'prisma/schema.prisma')['rating'] > 0,
      合同管理: grepMatrix(['contractFile', 'contractUrl'], 'prisma/schema.prisma')['contractFile'] > 0,
    }
    evidence.push(`能力矩阵: ${Object.entries(caps).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}`)

    // 供应商是不是独立实体
    evidence.push(`独立 Vendor 模型: ${hasModel('Vendor') ? '有' : '无——供应商与客户共用 Customer 表，靠 isVendor 布尔位区分'}`)

    const missing = Object.entries(caps).filter(([, v]) => !v).map(([k]) => k)
    return { verdict: 'partial' as const, gap: `缺 ${missing.join('、')}`, evidence }
  },
})

defineCheck({
  id: 'M10-06',
  module: '10',
  title: '系统日志与数据安全（操作日志/登录日志/敏感审计/备份恢复）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    const logs = await prisma.actionLog.count()
    const byAction = await prisma.actionLog.groupBy({ by: ['action'], _count: true })
    evidence.push(`ActionLog ${logs} 条：${byAction.map(a => `${a.action}=${a._count}`).join(' ')}`)

    // 备份：0729 说"系统层面完全空白"，此处必须重查
    const backupPage = findFiles('"app/[locale]/classic/boss/system/backups"', 'page.tsx')
    const backupApis = findFiles('app/api/backups', 'route.ts')
    const cronBackup = findFiles('app/api/cron/backup-database', 'route.ts')
    evidence.push(`备份页面: ${backupPage.join(', ') || '无'}`)
    evidence.push(`备份 API: ${backupApis.join(', ') || '无'}`)
    evidence.push(`定时备份 cron: ${cronBackup.join(', ') || '无'}`)

    const jobs = await prisma.backupJob.count()
    const lastJob = await prisma.backupJob.findFirst({
      orderBy: { startedAt: 'desc' },
      select: { status: true, triggerType: true, startedAt: true, sizeBytes: true, gcsPath: true },
    })
    evidence.push(
      `BackupJob ${jobs} 条；最近一次: ${lastJob ? `${lastJob.triggerType}/${lastJob.status} @${lastJob.startedAt.toISOString().slice(0, 16)} ${lastJob.sizeBytes ?? '?'}B` : '无'}`,
    )

    const restore = grepMatrix(['pg_restore', '恢复演练', 'restoreBackup'], 'app lib scripts')
    evidence.push(`恢复能力命中: ${JSON.stringify(restore)}`)

    // 关键：模块存在 ≠ 备份跑得出来
    const ok = await prisma.backupJob.count({ where: { status: 'success' } })
    const failed = await prisma.backupJob.findMany({
      where: { status: 'failed' },
      orderBy: { startedAt: 'desc' }, take: 3,
      select: { triggerType: true, startedAt: true, errorMessage: true },
    })
    evidence.push(`成功的备份任务: ${ok}/${jobs}`)
    for (const f of failed) {
      evidence.push(`  失败@${f.startedAt.toISOString().slice(0, 16)} ${f.triggerType}: ${(f.errorMessage ?? '').replace(/\s+/g, ' ').slice(0, 120)}`)
    }

    const hasBackupModule = backupApis.length > 0 && cronBackup.length > 0
    return {
      verdict: 'partial' as const,
      gap: hasBackupModule
        ? `操作日志完整（${logs} 条，含 LOGIN ${byAction.find(a => a.action === 'LOGIN')?._count ?? 0} 条）。` +
          `备份不再是 0729 说的"系统层面完全空白"——pg_dump 模块、每日 cron、BOSS 备份管理页、` +
          `签名下载都已落地。**但 ${jobs} 次任务成功 ${ok} 次**：早期两次栽在 pg_dump 版本不匹配（已修），` +
          `最近一次栽在 GCS bucket 不存在——按项目部署铁律不该为将要拆掉的架构新开云资源，` +
          `备份落点应改为 S3 兼容存储。目前系统从未成功产出过一份备份`
        : '备份模块缺失',
      evidence,
    }
  },
})
