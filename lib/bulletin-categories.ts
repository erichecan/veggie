/** 信息广场分类 —— 固定四类，不开放自由 tag。纯常量，client/server 都能安全 import */
export const BULLETIN_CATEGORIES = ['SHORTAGE', 'ARRIVAL', 'PRICE_CHANGE', 'OTHER'] as const
export type BulletinCategoryValue = (typeof BULLETIN_CATEGORIES)[number]

export const BULLETIN_CATEGORY_LABELS: Record<BulletinCategoryValue, string> = {
  SHORTAGE: '缺货',
  ARRIVAL: '到货',
  PRICE_CHANGE: '调价',
  OTHER: '其他',
}

export const BULLETIN_CATEGORY_LABELS_EN: Record<BulletinCategoryValue, string> = {
  SHORTAGE: 'Shortage',
  ARRIVAL: 'Arrival',
  PRICE_CHANGE: 'Price Change',
  OTHER: 'Other',
}

/** 英文界面下取英文分类名，调用方自行判断 isEn（这里不引入 next-intl 依赖，保持纯常量文件）。 */
export function bulletinCategoryLabel(cat: BulletinCategoryValue, isEn: boolean): string {
  return isEn ? BULLETIN_CATEGORY_LABELS_EN[cat] : BULLETIN_CATEGORY_LABELS[cat]
}
