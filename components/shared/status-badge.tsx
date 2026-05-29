import { Badge } from '@/components/ui/badge'
import type { OrderStatus, WaveStatus, TripStatus, ProductStatus } from '@/lib/types'

const ORDER_STATUS: Record<OrderStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  pending:         { label: '待处理', variant: 'secondary' },
  confirmed:       { label: '已确认', variant: 'default' },
  wave_assigned:   { label: '已生成拣货单', variant: 'default' },
  in_delivery:     { label: '配送中', variant: 'default' },
  completed:       { label: '已完成', variant: 'outline' },
  locked:          { label: '已锁定', variant: 'outline' },
  cancelled:       { label: '已取消', variant: 'destructive' },
}

const WAVE_STATUS: Record<WaveStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  pending:  { label: '待拣货', variant: 'secondary' },
  picking:  { label: '拣货中', variant: 'default' },
  picked:   { label: '已完成拣货', variant: 'default' },
  sorting:  { label: '分货中', variant: 'default' },
  sorted:   { label: '已完成分货', variant: 'outline' },
}

const TRIP_STATUS: Record<TripStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  pending:            { label: '待出发', variant: 'secondary' },
  pending_assignment: { label: '待指派司机', variant: 'secondary' },
  verifying:          { label: '核货中', variant: 'default' },
  in_progress:        { label: '配送中', variant: 'default' },
  completed:          { label: '已完成', variant: 'outline' },
}

const PRODUCT_STATUS: Record<ProductStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  draft:    { label: '草稿', variant: 'secondary' },
  active:   { label: '上架', variant: 'default' },
  archived: { label: '归档', variant: 'outline' },
}

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const key = status.toLowerCase() as OrderStatus
  const { label, variant } = ORDER_STATUS[key] ?? { label: key, variant: 'secondary' as const }
  return <Badge variant={variant}>{label}</Badge>
}

export function WaveStatusBadge({ status }: { status: WaveStatus }) {
  const key = status.toLowerCase() as WaveStatus
  const { label, variant } = WAVE_STATUS[key] ?? { label: key, variant: 'secondary' as const }
  return <Badge variant={variant}>{label}</Badge>
}

export function TripStatusBadge({ status }: { status: TripStatus }) {
  const key = status.toLowerCase() as TripStatus
  const { label, variant } = TRIP_STATUS[key] ?? { label: key, variant: 'secondary' as const }
  return <Badge variant={variant}>{label}</Badge>
}

export function ProductStatusBadge({ status }: { status: ProductStatus }) {
  const key = status.toLowerCase() as ProductStatus
  const { label, variant } = PRODUCT_STATUS[key] ?? { label: key, variant: 'secondary' as const }
  return <Badge variant={variant}>{label}</Badge>
}
