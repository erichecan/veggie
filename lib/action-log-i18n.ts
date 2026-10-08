/**
 * 操作记录(ActionLog)的英文显示（20261007 客户反馈：英文界面下操作记录还是中文）
 * ============================================================================
 * ActionLog.detail 是写库时拼好的中文句子(几十个写入点，历史数据也是中文)，没法回头
 * 改成存 key。这里在**显示时**按已知句式翻译：先整句匹配常见模板，剩下的按词表替换；
 * 词表没覆盖到的中文原样保留(宁可露一点中文，也不要把信息翻丢)。
 *
 * 新增 writeLog 的 detail 句式时，顺手在 PHRASES / ENTITY 里补上对应英文。
 */

/** 「动作 + 对象」里的对象名 */
const ENTITY: Record<string, string> = {
  客户: 'customer',
  商品: 'product',
  价格表: 'pricelist',
  发票: 'invoice',
  供应商: 'vendor',
  用户: 'user',
  联系人: 'contact',
  订单: 'order',
  采购单: 'purchase order',
  计量单位: 'unit of measure',
  单位: 'unit',
  商品分类: 'product category',
  分类: 'category',
  报价单: 'quotation',
  送货单: 'delivery slip',
  对账单: 'statement',
}

const VERB: Record<string, string> = {
  创建: 'Created',
  新增: 'Added',
  更新: 'Updated',
  修改: 'Updated',
  删除: 'Deleted',
  归档: 'Archived',
}

/** 按长度倒序替换，避免「批量导入」先被「导入」截断 */
const PHRASES: Array<[string, string]> = ([
  ['采购下单时快速建档', 'Quick-created from a purchase order'],
  ['批量导入更新商品价格', 'Price updated by bulk import'],
  ['批量导入更新价格表', 'Bulk import updated pricelist'],
  ['价格规则修改', 'Pricelist rule changed'],
  ['价格规则新增', 'Pricelist rule added'],
  ['价格规则删除', 'Pricelist rule removed'],
  ['删除商品时移除', 'Removed on product deletion'],
  ['条规则', 'rules'],
  ['条价格规则', 'pricelist rules'],
  ['同时移除', 'also removed'],
  ['批量导入创建用户', 'Created by bulk import: user'],
  ['批量导入', 'Bulk import'],
  ['库存调整', 'Stock adjustment'],
  ['设为主联系人', 'set as primary contact'],
  ['重名跳过', 'skipped (name collisions)'],
  ['未命名', 'unnamed'],
  ['金额', 'amount'],
  ['新建', 'created'],
  ['更新', 'updated'],
  ['失败', 'failed'],
  ['跳过', 'skipped'],
  ['原因', 'reason'],
  ['备注', 'note'],
] as Array<[string, string]>).sort((a, b) => b[0].length - a[0].length)

const ENTITY_KEYS = Object.keys(ENTITY).sort((a, b) => b.length - a.length)

function normalizePunctuation(s: string): string {
  return s
    .replace(/：/g, ': ')
    .replace(/，/g, ', ')
    .replace(/、/g, ', ')
    .replace(/（/g, ' (')
    .replace(/）/g, ')')
    .replace(/；/g, '; ')
    .replace(/。/g, '. ')
    .replace(/ {2,}/g, ' ')
    .trim()
}

export function translateLogDetail(detail: string, isEn: boolean): string {
  if (!isEn || !detail || !/[一-鿿]/.test(detail)) return detail
  let s = detail

  // 「动作+对象: 名字」：更新客户: Foo / 删除商品: Bar / 新增联系人 X(…)
  for (const [zhVerb, enVerb] of Object.entries(VERB)) {
    if (!s.startsWith(zhVerb)) continue
    const rest = s.slice(zhVerb.length)
    const entity = ENTITY_KEYS.find(k => rest.startsWith(k))
    if (entity) {
      s = `${enVerb} ${ENTITY[entity]}${rest.slice(entity.length)}`
      break
    }
  }
  // 「批量导入客户：…」里的对象
  s = s.replace(/^批量导入(\S+?)[：:]/, (m, ent: string) => (ENTITY[ent] ? `Bulk import ${ENTITY[ent]}s: ` : m))

  for (const [zh, en] of PHRASES) s = s.split(zh).join(en)
  // 对象名只在第一个冒号之前替换——冒号后面通常是客户/商品名本身，不能把名字里的「客户」等字翻掉
  const colon = s.search(/[：:]/)
  const head = colon >= 0 ? s.slice(0, colon) : s
  const tail = colon >= 0 ? s.slice(colon) : ''
  let h = head
  for (const k of ENTITY_KEYS) h = h.split(k).join(` ${ENTITY[k]} `)
  return normalizePunctuation(h + tail)
}

/** 字段名 → 显示名(中/英) */
export const FIELD_LABELS: Record<string, { zh: string; en: string }> = {
  // product
  name: { zh: '名称', en: 'Name' },
  internalRef: { zh: '内部参考', en: 'Internal Reference' },
  sequence: { zh: '序号', en: 'Sequence' },
  saleDescription: { zh: '销售描述', en: 'Sales Description' },
  description: { zh: '描述', en: 'Description' },
  listPrice: { zh: '销售价', en: 'Sales Price' },
  customerTaxRate: { zh: '客户税率', en: 'Customer Tax' },
  standardPrice: { zh: '成本价', en: 'Cost' },
  vendorTaxRate: { zh: '供应商税率', en: 'Vendor Tax' },
  weight: { zh: '重量', en: 'Weight' },
  categoryId: { zh: '商品分类', en: 'Product Category' },
  type: { zh: '商品类型', en: 'Product Type' },
  commissionPrice: { zh: '佣金价格', en: 'Commission Price' },
  status: { zh: '状态', en: 'Status' },
  canBeSold: { zh: '可售', en: 'Can be Sold' },
  // customer
  address: { zh: '地址', en: 'Address' },
  street: { zh: '街道 1', en: 'Street' },
  street2: { zh: '街道 2', en: 'Street 2' },
  city: { zh: '城市', en: 'City' },
  state: { zh: '州/省', en: 'State' },
  zip: { zh: '邮编', en: 'ZIP' },
  country: { zh: '国家', en: 'Country' },
  phone: { zh: '电话', en: 'Phone' },
  mobile: { zh: '手机', en: 'Mobile' },
  email: { zh: '邮箱', en: 'Email' },
  vatNumber: { zh: '税号', en: 'VAT Number' },
  paymentTerm: { zh: '付款条款', en: 'Payment Terms' },
  creditLimit: { zh: '信用额度', en: 'Credit Limit' },
  commissionRate: { zh: '佣金比率', en: 'Commission Rate' },
  commissionFixed: { zh: '固定佣金', en: 'Fixed Commission' },
  pricelistId: { zh: '价格表', en: 'Pricelist' },
  pricelistIds: { zh: '价格表', en: 'Pricelists' },
  priceType: { zh: '定价模式', en: 'Price Type' },
  isActive: { zh: '是否启用', en: 'Active' },
  isCustomer: { zh: '是客户', en: 'Is a Customer' },
  isVendor: { zh: '是供应商', en: 'Is a Vendor' },
  notes: { zh: '备注', en: 'Notes' },
  externalNote: { zh: '外部备注', en: 'External Note' },
  salesUserId: { zh: '销售员', en: 'Salesperson' },
  defaultDriverSlotId: { zh: '默认司机', en: 'Default Driver' },
  tags: { zh: '标签', en: 'Tags' },
  supplierPaymentTerm: { zh: '供应商付款条款', en: 'Vendor Payment Terms' },
  settlementCycle: { zh: '对账周期', en: 'Settlement Cycle' },
  sageAccount: { zh: 'Sage 账号', en: 'Sage Account' },
  // pricelist rule(lib/pricelist-diff.ts 写的 key 是「对象 · 字段」，这里翻「·」后面的字段)
  rule: { zh: '规则', en: 'Rule' },
  itemCount: { zh: '规则数', en: 'Rules' },
  computeType: { zh: '计价方式', en: 'Compute Price' },
  fixedPrice: { zh: '固定价', en: 'Fixed Price' },
  percentDiscount: { zh: '折扣%', en: 'Discount %' },
  formulaBase: { zh: '公式基准', en: 'Based On' },
  basedOnPricelistId: { zh: '基准价格表', en: 'Other Pricelist' },
  priceDiscount: { zh: '公式折扣%', en: 'Price Discount %' },
  priceSurcharge: { zh: '加价', en: 'Extra Fee' },
  priceMinMargin: { zh: '最低利润', en: 'Min Margin' },
  priceMaxMargin: { zh: '最高利润', en: 'Max Margin' },
  roundingMethod: { zh: '舍入', en: 'Rounding' },
  minQty: { zh: '最小数量', en: 'Min Qty' },
  dateStart: { zh: '开始日期', en: 'Start Date' },
  dateEnd: { zh: '结束日期', en: 'End Date' },
  uomId: { zh: '单位', en: 'Unit' },
  moreRuleChanges: { zh: '其余规则变更(条)', en: 'More rule changes' },
}

export function fieldLabel(key: string, isEn: boolean): string {
  const l = FIELD_LABELS[key]
  if (l) return isEn ? l.en : l.zh
  // 「对象 · 字段」(价格规则改价留痕)：只翻字段部分，对象名(商品/价格表名)原样
  const sep = key.lastIndexOf(' · ')
  if (sep > 0) {
    const f = FIELD_LABELS[key.slice(sep + 3)]
    if (f) return `${key.slice(0, sep)} · ${isEn ? f.en : f.zh}`
  }
  return key
}
