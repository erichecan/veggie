import type { ReportRequest, DimensionMeta, MeasureMeta, FilterSpec } from './types'

/**
 * 请求本身不合法（维度/度量/筛选字段不在白名单里、粒度不支持…）。
 * 与「查库炸了」区分开 —— 前者是 400，后者才是 500。
 * 混成一种的后果：用户选错维度看到「服务器错误」，而运维在日志里看到一片
 * 500 却全是正常的输入校验，真故障反而被淹掉（台账 H2 实测发现）。
 */
export class ReportRequestError extends Error {
  constructor(message: string) { super(message); this.name = 'ReportRequestError' }
}

interface BuildResult {
  sql: string
  params: unknown[]
  countSql: string
  totalsSql: string
}

export function buildReportSQL(
  viewName: string,
  req: ReportRequest,
  dimensionDefs: Record<string, DimensionMeta>,
  measureDefs: Record<string, MeasureMeta>,
): BuildResult {
  const params: unknown[] = []
  let paramIdx = 1

  const allDimensions = [...req.rowDimensions, ...(req.colDimensions ?? [])]
  if (allDimensions.length === 0) {
    throw new ReportRequestError('至少需要一个分组维度')
  }
  if (req.measures.length === 0) {
    throw new ReportRequestError('至少需要一个度量')
  }

  // ── Validate & build SELECT columns ─────────────────────────────────────────

  const selectCols: string[] = []
  const groupByCols: string[] = []   // aliases — used in ORDER BY
  const groupByExprs: string[] = []  // raw expressions — used in GROUP BY

  for (const dim of allDimensions) {
    const meta = dimensionDefs[dim.field]
    if (!meta) throw new ReportRequestError(`无效维度: ${dim.field}`)

    if (dim.interval && (meta.type === 'date' || meta.type === 'datetime')) {
      if (!meta.dateIntervals?.includes(dim.interval)) {
        throw new ReportRequestError(`维度 ${dim.field} 不支持区间 ${dim.interval}`)
      }
      const alias = `${dim.field}_${dim.interval}`
      const expr = `DATE_TRUNC('${dim.interval}', ${meta.field})`
      selectCols.push(`${expr} AS ${alias}`)
      groupByCols.push(alias)
      groupByExprs.push(expr)
    } else {
      selectCols.push(meta.field)
      groupByCols.push(meta.field)
      groupByExprs.push(meta.field)
    }
  }

  const measureCols: string[] = []
  for (const m of req.measures) {
    const meta = measureDefs[m]
    if (!meta) throw new ReportRequestError(`无效度量: ${m}`)
    measureCols.push(`${meta.aggregation.toUpperCase()}(${meta.field}) AS ${meta.field}`)
  }

  // ── WHERE clause ────────────────────────────────────────────────────────────

  const whereParts: string[] = []

  if (req.filters) {
    for (const f of req.filters) {
      const dimMeta = dimensionDefs[f.field]
      const mesMeta = measureDefs[f.field]
      const fieldName = dimMeta?.field ?? mesMeta?.field
      if (!fieldName) throw new ReportRequestError(`无效筛选字段: ${f.field}`)

      const clause = buildFilterClause(fieldName, f, params, paramIdx)
      whereParts.push(clause.sql)
      paramIdx = clause.nextIdx
    }
  }

  const whereStr = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''

  // ── ORDER BY ────────────────────────────────────────────────────────────────

  let orderByStr = ''
  if (req.orderBy && req.orderBy.length > 0) {
    const orderParts: string[] = []
    for (const o of req.orderBy) {
      const dimMeta = dimensionDefs[o.field]
      const mesMeta = measureDefs[o.field]
      if (!dimMeta && !mesMeta) throw new ReportRequestError(`无效排序字段: ${o.field}`)
      const dir = o.direction === 'desc' ? 'DESC' : 'ASC'
      orderParts.push(`${dimMeta?.field ?? mesMeta!.field} ${dir}`)
    }
    orderByStr = `ORDER BY ${orderParts.join(', ')}`
  } else {
    orderByStr = `ORDER BY ${groupByCols[0]} ASC`
  }

  // ── LIMIT / OFFSET ─────────────────────────────────────────────────────────

  const limit = Math.min(req.limit ?? 200, 10000)
  const offset = req.offset ?? 0

  // ── Assemble ────────────────────────────────────────────────────────────────

  const sql = [
    `SELECT ${[...selectCols, ...measureCols].join(', ')}`,
    `FROM ${viewName}`,
    whereStr,
    `GROUP BY ${groupByExprs.join(', ')}`,
    orderByStr,
    `LIMIT ${limit} OFFSET ${offset}`,
  ].filter(Boolean).join('\n')

  const countSql = [
    `SELECT COUNT(*) AS total FROM (`,
    `  SELECT 1 FROM ${viewName}`,
    `  ${whereStr}`,
    `  GROUP BY ${groupByExprs.join(', ')}`,
    `) sub`,
  ].join('\n')

  const totalsMeasureCols = req.measures.map(m => {
    const meta = measureDefs[m]!
    return `${meta.aggregation.toUpperCase()}(${meta.field}) AS ${meta.field}`
  })

  const totalsSql = [
    `SELECT ${totalsMeasureCols.join(', ')}`,
    `FROM ${viewName}`,
    whereStr,
  ].filter(Boolean).join('\n')

  return { sql, params, countSql, totalsSql }
}

function buildFilterClause(
  field: string,
  filter: FilterSpec,
  params: unknown[],
  startIdx: number,
): { sql: string; nextIdx: number } {
  let idx = startIdx
  const { operator, value } = filter

  switch (operator) {
    case '=':
    case '!=':
    case '>':
    case '<':
    case '>=':
    case '<=': {
      params.push(value)
      return { sql: `${field} ${operator} $${idx}`, nextIdx: idx + 1 }
    }
    case 'like': {
      params.push(`%${value}%`)
      return { sql: `${field} ILIKE $${idx}`, nextIdx: idx + 1 }
    }
    case 'in': {
      if (!Array.isArray(value)) throw new ReportRequestError(`'in' 操作符的值必须是数组`)
      const placeholders = value.map(v => { params.push(v); return `$${idx++}` })
      return { sql: `${field} IN (${placeholders.join(', ')})`, nextIdx: idx }
    }
    case 'not_in': {
      if (!Array.isArray(value)) throw new ReportRequestError(`'not_in' 操作符的值必须是数组`)
      const placeholders = value.map(v => { params.push(v); return `$${idx++}` })
      return { sql: `${field} NOT IN (${placeholders.join(', ')})`, nextIdx: idx }
    }
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) throw new ReportRequestError(`'between' 操作符需要两个值的数组`)
      params.push(value[0], value[1])
      return { sql: `${field} BETWEEN $${idx} AND $${idx + 1}`, nextIdx: idx + 2 }
    }
    default:
      throw new ReportRequestError(`不支持的操作符: ${operator}`)
  }
}
