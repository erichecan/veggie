import { str } from './bulk-import-engine'

/**
 * 客户/供应商批量导入共用字段解析 —— 两者都是 Customer 表(isVendor 区分)，这部分字段
 * 名称/长度限制完全一样。20261003 从 customers/bulk 与 suppliers/bulk 两份"逐字照抄"
 * 的实现里抽出来，避免以后改一处忘了改另一处。
 */
export interface ContactCommonFields {
  externalId?: string
  phone?: string
  email?: string
  address?: string
  city?: string
  zip?: string
  vatNumber?: string
  notes?: string
}

export function resolveContactCommonFields(r: Record<string, unknown>): ContactCommonFields {
  return {
    externalId: str(r.externalId, 100),
    phone: str(r.phone, 50),
    email: str(r.email, 200),
    address: str(r.address, 500),
    city: str(r.city, 100),
    zip: str(r.zip, 20),
    vatNumber: str(r.vatNumber, 50),
    notes: str(r.notes, 1000),
  }
}

export function describeContactRowError(resourceLabel: string, isUnique: boolean, isTimeout: boolean, externalId?: string): string {
  if (isUnique) {
    return externalId
      ? `ID '${externalId}' is already used by another ${resourceLabel}, row not imported`
      : `a unique field is already used by another ${resourceLabel}, row not imported`
  }
  if (isTimeout) return 'database timed out, row not imported — please re-import this row'
  return 'unknown error'
}

/**
 * 状态列(20261007 客户反馈：导入时 Status 填 Inactive 不起作用——以前导入根本没有这一列)。
 * 认导出文件里写的 Active/Inactive、活跃/停用，以及常见的 Archived/归档、Y/N、true/false。
 * 空 = 不改；认不出 = invalid(调用方提示并忽略)。
 */
const ACTIVE_WORDS = new Set(['active', '活跃', '启用', 'y', 'yes', 'true', '1', '是'])
const INACTIVE_WORDS = new Set(['inactive', '停用', 'archived', '已归档', '归档', 'n', 'no', 'false', '0', '否', 'disabled'])

export function parseActiveStatus(raw: unknown): { value: boolean | undefined; invalid: boolean } {
  if (raw === undefined || raw === null) return { value: undefined, invalid: false }
  const s = String(raw).trim().toLowerCase()
  if (!s) return { value: undefined, invalid: false }
  if (ACTIVE_WORDS.has(s)) return { value: true, invalid: false }
  if (INACTIVE_WORDS.has(s)) return { value: false, invalid: false }
  return { value: undefined, invalid: true }
}
