import type { DimensionMeta, MeasureMeta } from './types'

// ─── Sales Report ──────────────────────────────────────────────────────────────

export const SALES_DIMENSIONS: Record<string, DimensionMeta> = {
  customer_name:     { field: 'customer_name',     label: 'Customer',       labelZh: '客户',       type: 'string' },
  customer_city:     { field: 'customer_city',      label: 'City',           labelZh: '城市',       type: 'string' },
  customer_country:  { field: 'customer_country',   label: 'Country',        labelZh: '国家',       type: 'string' },
  product_name:      { field: 'product_name',       label: 'Product',        labelZh: '商品',       type: 'string' },
  category_name:     { field: 'category_name',      label: 'Category',       labelZh: '商品分类',   type: 'string' },
  salesman:          { field: 'salesman',            label: 'Salesperson',    labelZh: '业务员',     type: 'string' },
  driver_name:       { field: 'driver_name',         label: 'Driver',         labelZh: '司机',       type: 'string' },
  time_of_day:       { field: 'time_of_day',         label: 'AM/PM',          labelZh: '上午/下午',  type: 'enum',
    options: [{ value: 'am', label: '上午' }, { value: 'pm', label: '下午' }] },
  order_status:      { field: 'order_status',        label: 'Status',         labelZh: '状态',       type: 'enum',
    options: ['PENDING', 'CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED', 'LOCKED']
      .map(s => ({ value: s, label: s })) },
  payment_method:    { field: 'payment_method',      label: 'Payment',        labelZh: '支付方式',   type: 'enum',
    options: [{ value: 'ONLINE', label: '在线' }, { value: 'CASH', label: '现金' }] },
  payment_term:      { field: 'payment_term',        label: 'Payment Term',   labelZh: '付款条件',   type: 'string' },
  created_by_name:   { field: 'created_by_name',     label: 'Created By',     labelZh: '创建人',     type: 'string' },
  uom_name:          { field: 'uom_name',            label: 'UoM',            labelZh: '单位',       type: 'string' },
  delivery_date:     { field: 'delivery_date',       label: 'Delivery Date',  labelZh: '交货日期',   type: 'date',
    dateIntervals: ['day', 'week', 'month', 'quarter', 'year'] },
  confirmation_date: { field: 'confirmation_date',   label: 'Confirm Date',   labelZh: '确认日期',   type: 'date',
    dateIntervals: ['day', 'week', 'month', 'quarter', 'year'] },
  quotation_date:    { field: 'quotation_date',      label: 'Quotation Date', labelZh: '报价日期',   type: 'date',
    dateIntervals: ['day', 'week', 'month', 'quarter', 'year'] },
  invoice_date:      { field: 'invoice_date',        label: 'Invoice Date',   labelZh: '发票日期',   type: 'date',
    dateIntervals: ['day', 'week', 'month', 'quarter', 'year'] },
  created_at:        { field: 'created_at',           label: 'Created At',     labelZh: '创建时间',   type: 'datetime',
    dateIntervals: ['day', 'week', 'month', 'quarter', 'year'] },
}

export const SALES_MEASURES: Record<string, MeasureMeta> = {
  line_subtotal:      { field: 'line_subtotal',      label: 'Subtotal',         labelZh: '小计（不含税）', aggregation: 'sum', format: 'currency' },
  line_total_inc_tax: { field: 'line_total_inc_tax', label: 'Total (inc. tax)', labelZh: '小计（含税）',   aggregation: 'sum', format: 'currency' },
  tax_amount:         { field: 'tax_amount',         label: 'Tax',              labelZh: '税额',           aggregation: 'sum', format: 'currency' },
  ordered_qty:        { field: 'ordered_qty',        label: 'Ordered Qty',      labelZh: '订购数量',       aggregation: 'sum', format: 'decimal' },
  delivered_qty:      { field: 'delivered_qty',       label: 'Delivered Qty',    labelZh: '交货数量',       aggregation: 'sum', format: 'decimal' },
  invoiced_qty:       { field: 'invoiced_qty',        label: 'Invoiced Qty',     labelZh: '开票数量',       aggregation: 'sum', format: 'decimal' },
  qty_to_deliver:     { field: 'qty_to_deliver',      label: 'To Deliver',       labelZh: '待交货',         aggregation: 'sum', format: 'decimal' },
  qty_to_invoice:     { field: 'qty_to_invoice',      label: 'To Invoice',       labelZh: '待开票',         aggregation: 'sum', format: 'decimal' },
  ordered_qty_ref:    { field: 'ordered_qty_ref',     label: 'Qty (Ref UoM)',    labelZh: '数量（参考单位）', aggregation: 'sum', format: 'decimal' },
  total_weight:       { field: 'total_weight',        label: 'Weight (kg)',      labelZh: '总重量(kg)',     aggregation: 'sum', format: 'weight' },
  total_volume:       { field: 'total_volume',        label: 'Volume',           labelZh: '总体积',         aggregation: 'sum', format: 'decimal' },
  commission_amount:  { field: 'commission_amount',   label: 'Commission',       labelZh: '佣金',           aggregation: 'sum', format: 'currency' },
  unit_price:         { field: 'unit_price',          label: 'Avg Price',        labelZh: '均价',           aggregation: 'avg', format: 'currency' },
  line_count:         { field: 'line_count',          label: '# Lines',          labelZh: '行数',           aggregation: 'sum', format: 'integer' },
}

// ─── Purchasing Report ─────────────────────────────────────────────────────────

export const PURCHASING_DIMENSIONS: Record<string, DimensionMeta> = {
  supplier_name:   { field: 'supplier_name',   label: 'Supplier',      labelZh: '供应商',     type: 'string' },
  supplier_city:   { field: 'supplier_city',    label: 'Supplier City', labelZh: '供应商城市', type: 'string' },
  product_name:    { field: 'product_name',     label: 'Product',       labelZh: '商品',       type: 'string' },
  category_name:   { field: 'category_name',    label: 'Category',      labelZh: '商品分类',   type: 'string' },
  po_status:       { field: 'po_status',         label: 'PO Status',     labelZh: '采购单状态', type: 'enum',
    options: ['DRAFT', 'CONFIRMED', 'RECEIVED', 'INVOICED']
      .map(s => ({ value: s, label: s })) },
  order_date:      { field: 'order_date',        label: 'Order Date',    labelZh: '下单日期',   type: 'date',
    dateIntervals: ['day', 'week', 'month', 'quarter', 'year'] },
  expected_date:   { field: 'expected_date',     label: 'Expected Date', labelZh: '预期到货',   type: 'date',
    dateIntervals: ['day', 'week', 'month', 'quarter', 'year'] },
  confirmed_at:    { field: 'confirmed_at',      label: 'Confirmed At',  labelZh: '确认时间',   type: 'datetime',
    dateIntervals: ['day', 'week', 'month', 'quarter', 'year'] },
}

export const PURCHASING_MEASURES: Record<string, MeasureMeta> = {
  subtotal_ex_tax:  { field: 'subtotal_ex_tax',  label: 'Subtotal',       labelZh: '小计（不含税）', aggregation: 'sum', format: 'currency' },
  subtotal_inc_tax: { field: 'subtotal_inc_tax', label: 'Total (inc tax)', labelZh: '小计（含税）',  aggregation: 'sum', format: 'currency' },
  tax_amount:       { field: 'tax_amount',       label: 'Tax',             labelZh: '税额',          aggregation: 'sum', format: 'currency' },
  ordered_qty:      { field: 'ordered_qty',       label: 'Ordered Qty',    labelZh: '订购数量',      aggregation: 'sum', format: 'decimal' },
  received_qty:     { field: 'received_qty',      label: 'Received Qty',   labelZh: '到货数量',      aggregation: 'sum', format: 'decimal' },
  invoiced_qty:     { field: 'invoiced_qty',      label: 'Invoiced Qty',   labelZh: '开票数量',      aggregation: 'sum', format: 'decimal' },
  qty_to_receive:   { field: 'qty_to_receive',    label: 'To Receive',     labelZh: '待到货',        aggregation: 'sum', format: 'decimal' },
  unit_cost:        { field: 'unit_cost',          label: 'Avg Cost',       labelZh: '均价',          aggregation: 'avg', format: 'currency' },
  line_count:       { field: 'line_count',         label: '# Lines',        labelZh: '行数',          aggregation: 'sum', format: 'integer' },
}

// ─── Logistics Report ──────────────────────────────────────────────────────────

export const LOGISTICS_DIMENSIONS: Record<string, DimensionMeta> = {
  driver_name:        { field: 'driver_name',        label: 'Driver',           labelZh: '司机',     type: 'string' },
  time_slot:          { field: 'time_slot',           label: 'Time Slot',        labelZh: '时段',     type: 'string' },
  trip_status:        { field: 'trip_status',          label: 'Trip Status',      labelZh: '行程状态', type: 'enum',
    options: ['IN_TRANSIT', 'COMPLETED', 'SETTLED']
      .map(s => ({ value: s, label: s })) },
  settlement_status:  { field: 'settlement_status',   label: 'Settlement',       labelZh: '交账状态', type: 'string' },
  wave_id:            { field: 'wave_id',              label: 'Wave',             labelZh: '波次',     type: 'string' },
  created_at:         { field: 'created_at',           label: 'Created At',       labelZh: '创建时间', type: 'datetime',
    dateIntervals: ['day', 'week', 'month', 'quarter', 'year'] },
  settled_at:         { field: 'settled_at',           label: 'Settled At',       labelZh: '交账时间', type: 'datetime',
    dateIntervals: ['day', 'week', 'month', 'quarter', 'year'] },
}

export const LOGISTICS_MEASURES: Record<string, MeasureMeta> = {
  total_payment:      { field: 'total_payment',      label: 'Total Payment',    labelZh: '总收款',     aggregation: 'sum', format: 'currency' },
  driver_commission:  { field: 'driver_commission',  label: 'Commission',       labelZh: '司机佣金',   aggregation: 'sum', format: 'currency' },
  cash_collected:     { field: 'cash_collected',      label: 'Cash',             labelZh: '现金收款',   aggregation: 'sum', format: 'currency' },
  online_collected:   { field: 'online_collected',    label: 'Online',           labelZh: '在线收款',   aggregation: 'sum', format: 'currency' },
  total_collected:    { field: 'total_collected',     label: 'Total Collected',  labelZh: '总收款额',   aggregation: 'sum', format: 'currency' },
  restaurant_count:   { field: 'restaurant_count',    label: '# Restaurants',    labelZh: '餐厅数',     aggregation: 'sum', format: 'integer' },
  trip_count:         { field: 'trip_count',           label: '# Trips',          labelZh: '行程数',     aggregation: 'sum', format: 'integer' },
}

// ─── Registry ──────────────────────────────────────────────────────────────────

export const REPORT_REGISTRY = {
  sales: {
    view: 'veggie_sales_report',
    dimensions: SALES_DIMENSIONS,
    measures: SALES_MEASURES,
  },
  purchasing: {
    view: 'veggie_purchasing_report',
    dimensions: PURCHASING_DIMENSIONS,
    measures: PURCHASING_MEASURES,
  },
  logistics: {
    view: 'veggie_logistics_report',
    dimensions: LOGISTICS_DIMENSIONS,
    measures: LOGISTICS_MEASURES,
  },
} as const
