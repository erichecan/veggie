/**
 * 单价来源展示：把 OrderLine 上落库的 priceSourceType/Detail/Date 三个快照字段
 * 转成一个带 hover 提示的徽章。历史订单（导入自 Odoo 或早于此功能上线）没有这三个
 * 字段，一律显示为「—」。
 */

export type PriceSourceType = 'PRICELIST' | 'DEFAULT' | 'LAST' | 'SPECIAL'

export interface PriceSourceLine {
  priceSourceType?: string | null
  priceSourceDetail?: string | null
  priceSourceDate?: string | Date | null
}

const LABEL_ZH: Record<PriceSourceType, string> = {
  PRICELIST: '价格表',
  DEFAULT: '牌价',
  LAST: '最近成交',
  SPECIAL: '专属价',
}

const LABEL_EN: Record<PriceSourceType, string> = {
  PRICELIST: 'Pricelist',
  DEFAULT: 'Default',
  LAST: 'Last Price',
  SPECIAL: 'Special',
}

const BADGE_CLASS: Record<PriceSourceType, string> = {
  PRICELIST: 'bg-blue-50 text-blue-700 border-blue-200',
  DEFAULT: 'bg-gray-100 text-gray-500 border-gray-200',
  LAST: 'bg-amber-50 text-amber-700 border-amber-200',
  SPECIAL: 'bg-purple-50 text-purple-700 border-purple-200',
}

export interface PriceSourceBadge {
  label: string
  className: string
  title: string
}

function isKnownType(v: string): v is PriceSourceType {
  return v === 'PRICELIST' || v === 'DEFAULT' || v === 'LAST' || v === 'SPECIAL'
}

export function formatPriceSourceBadge(line: PriceSourceLine, isEn: boolean): PriceSourceBadge {
  const raw = (line.priceSourceType ?? '').toUpperCase()
  if (!isKnownType(raw)) {
    return {
      label: '—',
      className: 'bg-gray-50 text-gray-300 border-gray-200',
      title: isEn ? 'Historical order — price source not recorded' : '历史订单，未记录价格来源',
    }
  }

  const label = isEn ? LABEL_EN[raw] : LABEL_ZH[raw]
  const className = BADGE_CLASS[raw]
  let title = label

  if (raw === 'PRICELIST') {
    title = line.priceSourceDetail
      ? (isEn ? `Pricelist: ${line.priceSourceDetail}` : `价格表：${line.priceSourceDetail}`)
      : (isEn ? 'Pricelist' : '价格表')
  } else if (raw === 'LAST') {
    const d = line.priceSourceDate ? new Date(line.priceSourceDate) : null
    const dateStr = d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(isEn ? 'en-CA' : 'zh-CN') : ''
    title = dateStr
      ? (isEn ? `Last transaction: ${dateStr}` : `最近成交时间：${dateStr}`)
      : (isEn ? 'Last transaction price' : '最近成交价')
  } else if (raw === 'SPECIAL') {
    title = isEn ? 'Customer special price' : '客户专属特殊价格'
  } else if (raw === 'DEFAULT') {
    title = isEn ? 'Default list price' : '直接牌价'
  }

  return { label, className, title }
}
