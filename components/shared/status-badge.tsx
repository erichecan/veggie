import { useLocale } from 'next-intl'
import { routing } from '@/i18n/routing'
import { Badge } from '@/components/ui/badge'
import type { OrderStatus, WaveStatus, TripStatus, ProductStatus } from '@/lib/types'

type Variant = 'default' | 'secondary' | 'destructive' | 'outline'

const ORDER_STATUS_ZH: Record<OrderStatus, { label: string; variant: Variant }> = {
  pending:         { label: '待处理', variant: 'secondary' },
  confirmed:       { label: '已确认', variant: 'default' },
  wave_assigned:   { label: '已生成拣货单', variant: 'default' },
  in_delivery:     { label: '配送中', variant: 'default' },
  completed:       { label: '已完成', variant: 'outline' },
  locked:          { label: '已锁定', variant: 'outline' },
  cancelled:       { label: '已取消', variant: 'destructive' },
}
const ORDER_STATUS_EN: Record<OrderStatus, { label: string; variant: Variant }> = {
  pending:         { label: 'Pending', variant: 'secondary' },
  confirmed:       { label: 'Confirmed', variant: 'default' },
  wave_assigned:   { label: 'Picking List Generated', variant: 'default' },
  in_delivery:     { label: 'In Delivery', variant: 'default' },
  completed:       { label: 'Completed', variant: 'outline' },
  locked:          { label: 'Locked', variant: 'outline' },
  cancelled:       { label: 'Cancelled', variant: 'destructive' },
}

const WAVE_STATUS_ZH: Record<WaveStatus, { label: string; variant: Variant }> = {
  pending:  { label: '待拣货', variant: 'secondary' },
  picking:  { label: '拣货中', variant: 'default' },
  picked:   { label: '已完成拣货', variant: 'default' },
  sorting:  { label: '分货中', variant: 'default' },
  sorted:   { label: '已完成分货', variant: 'outline' },
}
const WAVE_STATUS_EN: Record<WaveStatus, { label: string; variant: Variant }> = {
  pending:  { label: 'To Pick', variant: 'secondary' },
  picking:  { label: 'Picking', variant: 'default' },
  picked:   { label: 'Picked', variant: 'default' },
  sorting:  { label: 'Sorting', variant: 'default' },
  sorted:   { label: 'Sorted', variant: 'outline' },
}

const TRIP_STATUS_ZH: Record<TripStatus, { label: string; variant: Variant }> = {
  pending:            { label: '待出发', variant: 'secondary' },
  pending_assignment: { label: '待指派司机', variant: 'secondary' },
  verifying:          { label: '核货中', variant: 'default' },
  in_progress:        { label: '配送中', variant: 'default' },
  completed:          { label: '已完成', variant: 'outline' },
}
const TRIP_STATUS_EN: Record<TripStatus, { label: string; variant: Variant }> = {
  pending:            { label: 'Not Departed', variant: 'secondary' },
  pending_assignment: { label: 'Awaiting Driver', variant: 'secondary' },
  verifying:          { label: 'Verifying', variant: 'default' },
  in_progress:        { label: 'In Delivery', variant: 'default' },
  completed:          { label: 'Completed', variant: 'outline' },
}

const PRODUCT_STATUS_ZH: Record<ProductStatus, { label: string; variant: Variant }> = {
  draft:    { label: '草稿', variant: 'secondary' },
  active:   { label: '上架', variant: 'default' },
  archived: { label: '归档', variant: 'outline' },
}
const PRODUCT_STATUS_EN: Record<ProductStatus, { label: string; variant: Variant }> = {
  draft:    { label: 'Draft', variant: 'secondary' },
  active:   { label: 'Active', variant: 'default' },
  archived: { label: 'Archived', variant: 'outline' },
}

function useIsEn(): boolean {
  const locale = useLocale()
  return locale !== routing.defaultLocale
}

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const isEn = useIsEn()
  const key = status.toLowerCase() as OrderStatus
  const map = isEn ? ORDER_STATUS_EN : ORDER_STATUS_ZH
  const { label, variant } = map[key] ?? { label: key, variant: 'secondary' as const }
  return <Badge variant={variant}>{label}</Badge>
}

export function WaveStatusBadge({ status }: { status: WaveStatus }) {
  const isEn = useIsEn()
  const key = status.toLowerCase() as WaveStatus
  const map = isEn ? WAVE_STATUS_EN : WAVE_STATUS_ZH
  const { label, variant } = map[key] ?? { label: key, variant: 'secondary' as const }
  return <Badge variant={variant}>{label}</Badge>
}

export function TripStatusBadge({ status }: { status: TripStatus }) {
  const isEn = useIsEn()
  const key = status.toLowerCase() as TripStatus
  const map = isEn ? TRIP_STATUS_EN : TRIP_STATUS_ZH
  const { label, variant } = map[key] ?? { label: key, variant: 'secondary' as const }
  return <Badge variant={variant}>{label}</Badge>
}

export function ProductStatusBadge({ status }: { status: ProductStatus }) {
  const isEn = useIsEn()
  const key = status.toLowerCase() as ProductStatus
  const map = isEn ? PRODUCT_STATUS_EN : PRODUCT_STATUS_ZH
  const { label, variant } = map[key] ?? { label: key, variant: 'secondary' as const }
  return <Badge variant={variant}>{label}</Badge>
}
