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
