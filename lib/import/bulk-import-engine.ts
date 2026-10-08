import { Prisma } from '@/lib/generated/prisma/client'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'

/**
 * 全站批量导入引擎 —— 从 app/api/products/bulk/route.ts(20260930 重写、20261 加
 * productNo 匹配键)抽出来的通用骨架。那份实现踩过好几轮生产坑才稳定：
 * - 逐行独立事务(Neon 每条查询是网络往返，交互式事务默认 5s 很容易因为批量操作超时/P2028，
 *   见下方 rowTxTimeoutMs 注释) —— 这条迁就现在还需要，不要因为抽象层而优化掉。
 * - 更新只覆盖本行提供了非空值的字段，不拿 CREATE 默认值冲掉已有数据。
 * - 单行失败只记原因，不影响其它行；不像旧版一样一行炸全批回滚。
 *
 * 各模块只提供"字段怎么解析/怎么匹配已有记录/怎么写库"，循环控制、匹配优先级回退、
 * 错误收集、审计日志收尾这些由本文件统一处理。
 */

/** 单行事务超时。Prisma 默认 5 秒，Neon 上每条查询都是网络往返，给足余量。 */
const ROW_TX_TIMEOUT_MS = 15_000

export interface BulkImportWarn {
  (message: string): void
}

/**
 * 匹配优先级键 —— 按数组顺序尝试，第一个"行上有值 且 在候选集合里命中"的生效。
 * field 必须是调用方在 findMatchCandidates 返回的候选对象上能读到的字段名。
 */
export interface MatchKeyDef<Resolved> {
  field: string
  get: (row: Resolved) => string | number | undefined
}

export interface BulkImportRowOutcome<Data = unknown> {
  id: string
  /** 该行写库过程中产生的、不足以让整行失败的提示(如子表格式错误被跳过) */
  warning?: string
  /**
   * 透传给 onRowCommitted 的数据，直接取自 writeRow 里 create/update 调用自己的返回值。
   * ⛔ onRowCommitted 不能为了拿到这份数据再去查一次库——事务提交和收尾之间存在时间窗口，
   * 并发请求可能在这中间改了同一条记录，重新查库拿到的就不是这一行自己写入的值，会把
   * 审计留痕的 before/after 算错(20261003 商品改价留痕的 code review 发现过这个坑)。
   */
  data?: Data
}

export interface BulkImportConfig<Raw, Resolved extends { rowLabel: string; name: string }, Data = unknown> {
  rawRows: Raw[]
  /** 本批第一行在整份文件里的序号偏移，前端按 100 行分批提交时传，提示文案按整份文件计数 */
  rowOffset: number
  /**
   * 单行：原始 JSON → 校验/归一化后的行对象。
   * 返回 null = 整行被跳过(如缺必填字段)，调用方必须用 warn() 记下原因。
   */
  resolveRow: (raw: Raw, rowNo: number, warn: BulkImportWarn) => Resolved | null
  matchKeys: MatchKeyDef<Resolved>[]
  /**
   * 按 matchKeys 批量查询候选记录(调用方自己写 Prisma 查询，因为每个模型的表/字段不同)。
   * keyValues 的 key 是 MatchKeyDef.field，value 是这一批行里出现过的该字段值去重列表。
   */
  findMatchCandidates: (keyValues: Record<string, Array<string | number>>) => Promise<Array<Record<string, unknown> & { id: string }>>
  /** 没被任何 matchKey 命中的行，落回按名字大小写不敏感判重；取全库已占用的名字集合 */
  findExistingNames: () => Promise<Set<string>>
  /**
   * 单行事务：existingId=null 表示新建，否则更新该 id。
   * 调用方自己决定 create/update 的字段映射、要不要顺带写子表。
   */
  writeRow: (tx: Prisma.TransactionClient, resolved: Resolved, existingId: string | null) => Promise<BulkImportRowOutcome<Data>>
  /** 单行写入失败时，翻译成给用户看的一句话(各模型唯一约束不同) */
  describeRowError: (e: unknown, resolved: Resolved) => string
  /**
   * 事务提交之后才跑的收尾(如商品的改价留痕)。必须在事务外执行——writeLog/审计表用的是
   * 顶层 prisma 不在事务里，提前写的话事务回滚时会留下一条假记录(见 lib/action-log.ts)。
   * 按行顺序同步调用，方便调用方维护"上一行改完之后的最新状态"这类跨行累积状态。
   */
  onRowCommitted?: (resolved: Resolved, existingId: string | null, outcome: BulkImportRowOutcome<Data>) => Promise<void>
  rowTxTimeoutMs?: number
  /**
   * 试运行(20261008)：每一行照常在自己的事务里完整执行 writeRow(唯一约束、外键、业务校验
   * 都真跑一遍)，然后主动回滚——结果计数和真导入一模一样，但数据库什么都不留。
   * 试运行时不调 onRowCommitted、不写审计日志。
   */
  dryRun?: boolean
  /** 导入历史用：同一次导入(弹窗里选一个文件点一次)的各批次共用一个 importId */
  importMeta?: ImportMeta
  auditLog: {
    userId: string
    userEmail: string
    userName: string
    /** 写进 ActionLog.resource 的机器标签(英文/snake_case，如 'product'/'uom') */
    resource: string
    /** 写进 detail 人话摘要里用的中文名词(如"商品"/"计量单位")，不等于 resource——
     *  resource 是给机器筛选用的分类标签，detail 是给人看的句子，两者历来是分开维护的
     *  (见 customers/bulk 原实现: resource:'customer' 但 detail 写"批量导入客户")。 */
    resourceLabel: string
  }
}

export interface BulkImportResult {
  created: number
  updated: number
  skipped: string[]
  failed: string[]
  warnings: string[]
  /** 本次是试运行(什么都没写进数据库) */
  dryRun?: boolean
}

export interface ImportMeta {
  importId?: string
  fileName?: string
  /** 第几批(从 1 开始)，导入弹窗按 batchSize 分批提交 */
  batch?: number
}

/** 从请求体里取试运行开关与导入历史元信息——各 bulk 路由统一用它，字段名只在这一处定义 */
export function importOptionsFromBody(body: Record<string, unknown>): { dryRun: boolean; importMeta: ImportMeta } {
  const s = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)
  return {
    dryRun: body.dryRun === true,
    importMeta: {
      importId: s(body.importId, 64),
      fileName: s(body.fileName, 200),
      batch: Number.isInteger(body.batch) ? (body.batch as number) : undefined,
    },
  }
}

/** 导入历史留痕：写进 ActionLog.changes.import(结构见 /api/import-history) */
export function importHistoryChanges(meta: ImportMeta | undefined, counts: { created: number; updated: number; skipped: number; failed: number }) {
  if (!meta?.importId) return undefined
  return { import: { before: null, after: { ...meta, ...counts } } }
}

/** 试运行时用来让单行事务回滚、同时把这一行的结果带出来 */
class DryRunRollback<D> extends Error {
  constructor(public readonly outcome: BulkImportRowOutcome<D>) { super('dry-run rollback') }
}

export async function runBulkImport<Raw, Resolved extends { rowLabel: string; name: string }, Data = unknown>(
  config: BulkImportConfig<Raw, Resolved, Data>,
): Promise<BulkImportResult> {
  const { rawRows, rowOffset, resolveRow, matchKeys, findMatchCandidates, findExistingNames, writeRow, describeRowError, auditLog } = config
  const rowTxTimeoutMs = config.rowTxTimeoutMs ?? ROW_TX_TIMEOUT_MS
  const warnings: string[] = []
  const warn: BulkImportWarn = (msg) => warnings.push(msg)

  // ── 逐行解析 + 归一化(纯内存，不碰数据库) ──────────────────────────────
  const resolvedRows: Resolved[] = []
  rawRows.forEach((raw, i) => {
    const rowNo = rowOffset + i + 1
    const resolved = resolveRow(raw, rowNo, warn)
    if (resolved) resolvedRows.push(resolved)
  })

  if (resolvedRows.length === 0) {
    return { created: 0, updated: 0, skipped: [], failed: [], warnings, ...(config.dryRun ? { dryRun: true } : {}) }
  }

  // ── 按匹配优先级键批量查候选 ──────────────────────────────────────────
  const keyValues: Record<string, Array<string | number>> = {}
  for (const key of matchKeys) {
    const values = [...new Set(resolvedRows.map(r => key.get(r)).filter((v): v is string | number => v !== undefined))]
    if (values.length > 0) keyValues[key.field] = values
  }
  const hasAnyKey = Object.keys(keyValues).length > 0
  const matchCandidates = hasAnyKey ? await findMatchCandidates(keyValues) : []

  // 同一个键可能有多条候选(非唯一字段)，按"findMatchCandidates 返回顺序里最先出现的"兜底，
  // 与"更新最早创建的那条"的直觉一致 —— 调用方应在查询里自己 orderBy createdAt asc。
  const indexByKey = new Map<string, Map<string | number, Record<string, unknown> & { id: string }>>()
  for (const key of matchKeys) {
    const idx = new Map<string | number, Record<string, unknown> & { id: string }>()
    for (const candidate of matchCandidates) {
      const v = candidate[key.field]
      if ((typeof v === 'string' || typeof v === 'number') && !idx.has(v)) idx.set(v, candidate)
    }
    indexByKey.set(key.field, idx)
  }

  const existingNames = await findExistingNames()
  const takenNames = new Set(existingNames)

  // 这一步只解析 existingId，**不在这里**顺手把新名字占进 takenNames——见下面执行循环
  // 里的说明，占用和事务提交必须绑在一起，否则一笔失败的事务也会把名字"烧"掉。
  interface Planned { row: Resolved; existingId: string | null }
  const planned: Planned[] = []
  for (const row of resolvedRows) {
    let existingId: string | null = null
    for (const key of matchKeys) {
      const v = key.get(row)
      if (v === undefined) continue
      const hit = indexByKey.get(key.field)?.get(v)
      if (hit) { existingId = hit.id; break }
      warnings.push(`${row.rowLabel}: ${key.field} '${v}' not found, falling back to other match keys`)
    }
    planned.push({ row, existingId })
  }

  let created = 0
  let updated = 0
  const skipped: string[] = []
  const failed: string[] = []

  // 逐行提交，每行一个小事务(20261002 客户反馈：批量导入 199 行报"服务器暂时不可用"，
  // 根因是交互式事务 5s 上限叠加 Neon 网络延迟，批量串行查询轻松顶破；另外任意一行
  // 撞唯一约束(P2002)也会把同批其它行一起回滚。现在一行一个事务，单行失败只记 failed，
  // 其它行照常导入)。
  //
  // ⛔ 判重占用(takenNames.add)必须紧挨着事务尝试、而不是提前在上面那个规划循环里做完——
  // 提前占用的话，如果这一行自己的事务失败(撞了无关字段的唯一约束/P2028 超时)，
  // 名字已经被"烧"在 takenNames 里，后面一行同名的新记录会被误判成"跟这行撞名"而
  // skip 掉，但其实数据库里从来没有一条叫这个名字的记录(code review 发现)。这里改成：
  // 占用紧挨着尝试写入，写入失败就把占用撤销，保证 takenNames 任何时刻都反映"数据库
  // 或本批已经真正成功写入过"的名字，不是"打算写入"的名字。
  for (const { row, existingId } of planned) {
    let reservedName: string | null = null
    if (!existingId) {
      const nameKey = row.name.toLowerCase()
      if (takenNames.has(nameKey)) { skipped.push(row.name); continue }
      takenNames.add(nameKey)
      reservedName = nameKey
    }
    try {
      let outcome: BulkImportRowOutcome<Data>
      try {
        outcome = await prisma.$transaction(
          async (tx) => {
            const o = await writeRow(tx, row, existingId)
            if (config.dryRun) throw new DryRunRollback(o)
            return o
          },
          { timeout: rowTxTimeoutMs },
        )
      } catch (e) {
        if (!(e instanceof DryRunRollback)) throw e
        outcome = e.outcome as BulkImportRowOutcome<Data>
      }
      if (outcome.warning) warnings.push(outcome.warning)
      if (existingId) updated++
      else created++
      if (!config.dryRun && config.onRowCommitted) await config.onRowCommitted(row, existingId, outcome)
    } catch (e) {
      console.error(`[bulk-import] ${row.rowLabel}`, e)
      failed.push(`${row.rowLabel}: ${describeRowError(e, row)}`)
      if (reservedName) takenNames.delete(reservedName)
    }
  }

  if (config.dryRun) return { created, updated, skipped, failed, warnings, dryRun: true }

  await writeLog({
    userId: auditLog.userId,
    userEmail: auditLog.userEmail,
    userName: auditLog.userName,
    action: 'CREATE',
    resource: auditLog.resource,
    resourceId: 'bulk',
    detail: `批量导入${auditLog.resourceLabel}：新建 ${created}，更新 ${updated}，重名跳过 ${skipped.length}，失败 ${failed.length}`,
    changes: importHistoryChanges(config.importMeta, { created, updated, skipped: skipped.length, failed: failed.length }),
  })

  return { created, updated, skipped, failed, warnings }
}

// ── 常用的原始值解析工具(各模块的 resolveRow 可直接复用，避免重复手写) ──────────

export function str(v: unknown, maxLen = 200): string | undefined {
  if (v === null || v === undefined) return undefined
  const s = String(v).trim()
  return s.length > 0 ? s.slice(0, maxLen) : undefined
}

export function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function boundedNum(v: unknown, min: number, max: number): { value: number | undefined; invalid: boolean } {
  const n = num(v)
  if (n === undefined) return { value: undefined, invalid: false }
  if (n < min || n > max) return { value: undefined, invalid: true }
  return { value: n, invalid: false }
}

export function bool(v: unknown): { value: boolean | undefined; invalid: boolean } {
  if (v === null || v === undefined || v === '') return { value: undefined, invalid: false }
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'y', 'yes', '是'].includes(s)) return { value: true, invalid: false }
  if (['0', 'false', 'n', 'no', '否'].includes(s)) return { value: false, invalid: false }
  return { value: undefined, invalid: true }
}

/**
 * 按名称做字典匹配(分类/单位/温区分组等)时统一用这个 key——trim+小写。
 * 20261003 code review 发现 products/uoms/product-categories/pricelists 四个 bulk
 * 路由各自私下定义了一份一模一样的 normKey，抽到这里只留一份。
 */
export function normalizeNameKey(s: string): string {
  return s.trim().toLowerCase()
}

/** 识别 Prisma 原生错误码与 driver adapter 包装后的形态(同 lib/invoice-number.ts) */
export function isUniqueConstraintError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  const msg = e instanceof Error ? e.message : String(e)
  return code === 'P2002' || code === '23505' || /Unique constraint|UniqueConstraintViolation|duplicate key value/i.test(msg)
}

export function isTransactionTimeoutError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  const msg = e instanceof Error ? e.message : String(e)
  return code === 'P2028' || /Transaction API error|expired transaction|Transaction already closed|timed out/i.test(msg)
}

/** Prisma 报错是多行的("Invalid `prisma.x.y()` invocation: ... <真正原因>")，最后一行才是原因 */
export function lastErrorLine(e: unknown, fallback = 'unknown error'): string {
  const msg = e instanceof Error ? e.message : String(e)
  const lastLine = msg.split('\n').map(l => l.trim()).filter(Boolean).pop()
  return (lastLine ?? fallback).slice(0, 200)
}
