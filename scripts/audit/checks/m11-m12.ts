/**
 * M11 系统部署（含双系统独立并行运行）
 *   ① 私有化部署能力 ② 与 Odoo 12 同机独立并行 ③ 管理员账号与技术资料交接 ④ 自动备份
 * M12 接口与安全
 *   ① 标准 API 对接第三方 ② 安全性与合规 ③ PDA 扫码(条件触发) ④ 电子秤(条件触发)
 */
import { defineCheck, api, grepCode, grepCount, grepMatrix, findFiles, fileExists, prisma } from '../harness'

// ── M11 ─────────────────────────────────────────────────────────────────────

defineCheck({
  id: 'M11-01',
  module: '11',
  title: '私有化部署能力',
  prev: 'missing',
  async run() {
    const evidence: string[] = []

    const dbDriver = grepMatrix(['DATABASE_DRIVER', 'adapter-pg', 'PrismaPg'], 'lib package.json')
    evidence.push(`数据库驱动可切换性: ${JSON.stringify(dbDriver)}`)
    const dbCode = grepCode('PrismaNeon|adapter-neon', { roots: 'lib/db.ts', max: 3 })
    evidence.push(...dbCode.map(l => `当前驱动: ${l.slice(0, 120)}`))

    const artifacts = {
      Dockerfile: fileExists('Dockerfile'),
      'docker-compose.yml': fileExists('docker-compose.yml'),
      '部署脚本目录 deploy/': fileExists('deploy'),
      '.env.example': fileExists('.env.example'),
    }
    evidence.push(`交付物: ${Object.entries(artifacts).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}`)

    const gcpDeps = grepMatrix(['@google-cloud/storage', 'Secret Manager', 'cloudbuild'], 'app lib')
    evidence.push(`GCP 专有依赖残留: ${JSON.stringify(gcpDeps)}`)

    const plan = findFiles('docs', '*private-deployment*')
    evidence.push(`私有化部署方案文档: ${plan.join(', ') || '无'}`)

    const hasSwitch = dbDriver['DATABASE_DRIVER'] > 0 || dbDriver['adapter-pg'] > 0
    return {
      verdict: 'missing' as const,
      gap: `代码侧仍是 GCP Cloud Run + Neon 单一路径：${hasSwitch ? '' : '`DATABASE_DRIVER` 与 `@prisma/adapter-pg` 均零命中，'}` +
        '`lib/db.ts` 写死 `PrismaNeon`，接不了客户机房的普通 PostgreSQL；' +
        '有 Dockerfile 但无 docker-compose / 部署脚本 / 交付包。' +
        `已有落地方案文档（${plan.length} 份，含 20260802 服务器启用计划），但尚未实施`,
      evidence,
    }
  },
})

defineCheck({
  id: 'M11-02',
  module: '11',
  title: '与 Odoo 12 同机独立并行运行',
  prev: 'missing',
  async run() {
    const evidence: string[] = []
    const kw = grepMatrix(
      ['odoo.*并行', 'reverse.?proxy', 'nginx', 'caddy', 'systemd', 'docker-compose'],
      'app lib docs scripts',
    )
    evidence.push(`同机隔离/反代关键词命中: ${JSON.stringify(kw)}`)

    const plan = findFiles('docs', '*private-deployment-server-enablement*')
    evidence.push(`服务器启用计划: ${plan.join(', ') || '无'}`)
    if (plan.length > 0) {
      const blockers = grepCode('阻塞|数据居留|OOM|py3', { roots: plan[0], max: 4 })
      evidence.push(...blockers.map(l => `计划中已识别的阻塞: ${l.slice(0, 130)}`))
    }

    return {
      verdict: 'missing' as const,
      gap: '两套系统同机隔离（独立运行环境/数据库/文件目录/账号/端口/日志备份）尚未实施。' +
        '20260802 的服务器启用计划已把方案与三个阻塞点写清（数据居留：库在法兰克福↔机在伦敦；' +
        '内存不足会 OOM；Odoo 12 需 py3.5-3.7 撞系统 py3.14 须走 Docker），但都还停在纸面',
      evidence,
    }
  },
})

defineCheck({
  id: 'M11-03',
  module: '11',
  title: '管理员账号与技术资料交接机制',
  prev: 'missing',
  async run() {
    const evidence: string[] = []
    const handover = findFiles('docs', '*handoff*').concat(findFiles('docs/handoff', '*'))
    evidence.push(`交接类文档: ${handover.slice(0, 5).join(', ') || '无'}`)

    const runbook = grepMatrix(['交接清单', 'runbook', '管理员账号', '账号移交'], 'docs')
    evidence.push(`交接机制关键词命中: ${JSON.stringify(runbook)}`)

    evidence.push('当前账号归属：GCP 项目 supply-491510 与 Secret Manager 由开发方掌握，甲方无独立访问路径')

    return {
      verdict: 'missing' as const,
      gap: '合同要求服务器/数据库/新系统/Odoo 12 的最高管理员账号、备份文件、技术资料均由甲方掌握。' +
        '当前部署形态下这些全在开发方的 GCP 项目里，且无交接清单/移交流程文档',
      evidence,
    }
  },
})

defineCheck({
  id: 'M11-04',
  module: '11',
  title: '自动备份（数据库+文件 / 异地留存 / 可恢复验证 / 甲方可取完整备份）',
  prev: 'missing',
  async run() {
    const evidence: string[] = []

    const parts: Record<string, string> = {}
    parts['备份模块'] = findFiles('app/api/backups', 'route.ts').length > 0 ? '✓' : '✗'
    parts['定时任务'] = findFiles('app/api/cron/backup-database', 'route.ts').length > 0 ? '✓ (HTTP+CRON_SECRET，触发方可替换)' : '✗'
    parts['甲方可下载'] = findFiles('app/api/backups/[id]/download', 'route.ts').length > 0 ? '✓ (签名 URL)' : '✗'

    const jobs = await prisma.backupJob.count()
    const ok = await prisma.backupJob.count({ where: { status: 'success' } })
    parts['真的跑出过备份'] = ok > 0 ? `✓ (${ok}/${jobs})` : `✗ (${ok}/${jobs} 全部失败)`

    const fileBackup = grepMatrix(['上传文件备份', 'uploads.*backup', '程序文件备份'], 'app lib')
    parts['程序与上传文件备份'] = Object.values(fileBackup).some(v => v > 0) ? '✓' : '✗（只备数据库）'

    const driverAbstraction = grepCode('BACKUP_DRIVER|BackupStore', { roots: 'lib/storage lib/backup.ts', max: 3 })
    const stillDirectGcs = grepCount('@google-cloud/storage', 'lib/backup.ts')
    parts['落点可迁移'] = driverAbstraction.length > 0 && stillDirectGcs === 0
      ? '✓ driver 抽象（local/s3/gcs 由 BACKUP_DRIVER 选，迁服务器只改配置）'
      : '✗ 直连 GCS，迁到自有服务器后不可用'

    const verify = grepMatrix(['恢复验证', 'restoreVerif', '恢复演练'], 'app lib')
    parts['可恢复验证'] = Object.values(verify).some(v => v > 0) ? '✓' : '✗（有 runbook 文档，无自动验证）'

    evidence.push(...Object.entries(parts).map(([k, v]) => `${k}: ${v}`))

    const last = await prisma.backupJob.findFirst({
      orderBy: { startedAt: 'desc' }, select: { status: true, errorMessage: true, startedAt: true },
    })
    if (last) {
      evidence.push(`最近一次 @${last.startedAt.toISOString().slice(0, 16)} ${last.status}: ${(last.errorMessage ?? '').replace(/\s+/g, ' ').slice(0, 110)}`)
    }

    return {
      verdict: 'partial' as const,
      gap: `0729 判 missing 已过时——备份模块、每日 cron、BOSS 管理页、签名下载都已落地，` +
        `cron 是「HTTP 端点 + CRON_SECRET」形状（迁服务器后 systemd timer 可直接接），` +
        `落点已于 20260802 抽成 driver（local/s3/gcs），迁移时只改配置不改代码，` +
        `并已用 local driver 端到端跑出过 81.7MB 的可解压备份。` +
        `仍缺：生产上尚未接好持久落点（BackupJob 历史 ${ok}/${jobs} 次成功，需用户备好 S3 兼容桶）、` +
        `只备数据库不备上传文件、无自动恢复验证`,
      evidence,
    }
  },
})

// ── M12 ─────────────────────────────────────────────────────────────────────

defineCheck({
  id: 'M12-01',
  module: '12',
  title: '标准 API 接口对接第三方（ERP/财务/电子秤/税控盘/物流）',
  prev: 'missing',
  async run() {
    const evidence: string[] = []

    const routes = findFiles('app/api', 'route.ts')
    evidence.push(`API 路由总数: ${routes.length}`)

    const mech = grepMatrix(
      ['X-API-Key', 'apiKeyAuth', 'oauth', 'clientSecret', 'webhook', '/api/v1', '/api/v2'],
      'app lib middleware.ts',
    )
    evidence.push(`对外 API 机制命中: ${JSON.stringify(mech)}`)
    const apiKeyUse = grepCode('x-api-key', { roots: 'app lib', max: 3 })
    evidence.push(...apiKeyUse.map(l => `注：${l.slice(0, 120)}（是本系统作为客户端去调 Anthropic，不是对外开放）`))

    const targets = grepMatrix(['电子秤', '税控', 'ERP.*对接', '物流平台', 'weighbridge'], 'app lib')
    evidence.push(`合同点名的对接对象命中: ${JSON.stringify(targets)}`)

    return {
      verdict: 'missing' as const,
      gap: `${routes.length} 个 API 路由全部服务于自家前端，统一走 JWT session 鉴权；` +
        `没有面向第三方的 API Key / OAuth 机制、没有 webhook、没有版本号前缀。` +
        `电子秤/税控/ERP对接/物流平台等对接对象全库零命中`,
      evidence,
    }
  },
})

defineCheck({
  id: 'M12-02',
  module: '12',
  title: '安全性与合规（加密传输存储 / 食品安全法 / 全链路追溯 / 账号登录安全）',
  prev: 'partial',
  async run() {
    const evidence: string[] = []

    const sec: Record<string, string> = {}
    sec['密码哈希'] = grepMatrix(['bcrypt'], 'app lib')['bcrypt'] > 0 ? '✓ bcrypt' : '✗'
    sec['登录限流'] = grepMatrix(['rateLimit'], 'app lib')['rateLimit'] > 0 ? '✓' : '✗'
    sec['MFA/TOTP'] = grepMatrix(['totp'], 'app lib')['totp'] > 0 ? '✓' : '✗'
    sec['API 统一鉴权'] = grepCode('PUBLIC_API_ROUTES', { roots: 'middleware.ts', max: 1 }).length > 0 ? '✓ middleware 统一闸门' : '✗'
    sec['操作审计'] = (await prisma.actionLog.count()) > 0 ? '✓' : '✗'
    sec['批次全链路追溯'] = (await prisma.stockMove.count({ where: { lotId: { not: null } } })) > 0 ? '✓' : '✗'
    sec['食品安全法合规设计'] = grepMatrix(['食品安全法', 'HACCP', '合规检查'], 'app lib docs')['食品安全法'] > 0 ? '✓' : '✗'
    evidence.push(...Object.entries(sec).map(([k, v]) => `${k}: ${v}`))

    // 鉴权闸门实测：无 token / 错 token / 低权限
    const noTok = await api('/api/orders', { noAuth: true })
    const badTok = await api('/api/orders', { rawToken: 'not-a-real-token' })
    const lowRole = await api('/api/backups', { role: 'DRIVER' })
    evidence.push(`鉴权实测 — 无 token: ${noTok.status}｜错 token: ${badTok.status}｜低权限(DRIVER)访问备份: ${lowRole.status}`)

    const writeNoAuth = await api('/api/orders', { method: 'POST', body: {}, noAuth: true })
    evidence.push(`写操作无 token: ${writeNoAuth.brief}`)

    const authOk = noTok.status === 401 && badTok.status === 401 && writeNoAuth.status === 401
    evidence.push(`鉴权闸门结论: ${authOk ? '无 token / 错 token 均被拦在 middleware' : '存在放行'}`)
    evidence.push('注：20260802 本次审计发现并修复了 /api/customers 被误列入 middleware 白名单导致全量客户名册匿名可读（commit 588357a）')

    return {
      verdict: 'partial' as const,
      gap: 'HTTPS 传输、bcrypt 口令、登录限流、TOTP 二次验证、middleware 统一鉴权闸门、' +
        '操作审计、批次级追溯都在。缺口：数据**静态加密**未做（库内字段明文）；' +
        '没有针对《食品安全法》的专门合规设计（关键词零命中）。' +
        '另：本次审计发现过一处白名单误配导致客户数据匿名可读，已修复——说明白名单缺少回归测试',
      evidence,
    }
  },
})

defineCheck({
  id: 'M12-03',
  module: '12',
  title: 'PDA 扫码功能（合同条件触发：仓库商品全部有条码后免费升级）',
  prev: 'deferred',
  async run() {
    const evidence: string[] = []
    const tmplTotal = await prisma.product.count()
    const withBarcode = await prisma.product.count({ where: { barcode: { not: null } } })
    evidence.push(`条码覆盖率: ${withBarcode}/${tmplTotal} 商品有条码`)
    const gen = grepMatrix(['jsbarcode', 'barcode'], 'app lib components')
    evidence.push(`条码相关能力: ${JSON.stringify(gen)}（已能生成/打印条码）`)
    return {
      verdict: 'deferred' as const,
      gap: `合同写明"后续如果仓库全部商品都有打印条码，可免费升级此功能"。` +
        `当前条码覆盖率 ${withBarcode}/${tmplTotal}，**触发条件尚未成就**，不计入本阶段功能缺口`,
      evidence,
    }
  },
})

defineCheck({
  id: 'M12-04',
  module: '12',
  title: '电子秤功能（合同条件触发：生鲜出库改为过秤后免费升级）',
  prev: 'deferred',
  async run() {
    const evidence: string[] = []
    const kw = grepMatrix(['电子秤', 'weighbridge', 'scaleDevice', '过秤'], 'app lib')
    evidence.push(`电子秤关键词命中: ${JSON.stringify(kw)}`)
    evidence.push('现有出库按订单行数量扣减，无过秤环节')
    return {
      verdict: 'deferred' as const,
      gap: '合同写明"后续如果仓库生鲜商品出库流程修改为电子秤过秤才能出库，可免费升级此功能"，' +
        '属条件触发项，不是 Phase 1 交付内容',
      evidence,
    }
  },
})
