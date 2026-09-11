import { salesDomain } from './sales'
import { quotationDomain } from './quotation'
import { procurementDomain } from './procurement'
import { deliveryDomain } from './delivery'
import type { DomainDef, DomainKey } from './types'

export const DOMAIN_DEFS: Record<DomainKey, DomainDef> = {
  sales: salesDomain,
  quotation: quotationDomain,
  procurement: procurementDomain,
  delivery: deliveryDomain,
}

export function getDomainDef(key: string): DomainDef | undefined {
  return (DOMAIN_DEFS as Record<string, DomainDef>)[key]
}

export * from './types'
