/** 信息广场分类 —— 固定四类，不开放自由 tag。纯常量，client/server 都能安全 import */
export const BULLETIN_CATEGORIES = ['SHORTAGE', 'ARRIVAL', 'PRICE_CHANGE', 'OTHER'] as const
export type BulletinCategoryValue = (typeof BULLETIN_CATEGORIES)[number]

export const BULLETIN_CATEGORY_LABELS: Record<BulletinCategoryValue, string> = {
  SHORTAGE: '缺货',
  ARRIVAL: '到货',
  PRICE_CHANGE: '调价',
  OTHER: '其他',
}
