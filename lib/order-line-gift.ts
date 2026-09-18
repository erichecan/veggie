/**
 * 赠品勾选框的单价处理（三个订单页共用）
 * ============================================================================
 * 勾「Gift」要把单价按到 0——后端在 isGift=true 时也会强制归零，不采纳定价引擎
 * 算出的权威价（见 app/api/orders/[id]/route.ts、app/api/orders/[id]/lines/route.ts），
 * 界面上必须当场就显示 0，不能等提交回来才发现被后端改了。
 *
 * ⛔ 但 20260918 客户反馈：**勾完再取消，单价停在 0 变不回去**。
 * 原实现只处理了「勾上」一半：`{ isGift: true, unitPrice: 0 }`，取消时什么都不做，
 * 原价早已被 0 覆盖，界面上也看不出本来该是多少（价格输入框虽然解锁了，
 * 但要操作员自己去翻价格表把数字背回来）。
 *
 * 这里把「勾选前的整组价格字段」存成行内快照 `preGiftPrice`，取消勾选时原样恢复，
 * 连价格来源徽章（价格表 / 牌价 / 最近成交 / 手动改价）一起还原——单价恢复了而
 * 来源标签停在别处，一样是错的。
 *
 * 快照只活在前端编辑缓冲区，**提交前用 `stripGiftSnapshot` 抹掉**。
 *
 * 打开页面时本来就是赠品的行（库里存的就是 unitPrice=0）没有快照，
 * 这时由调用方给 `fallback`——按当前客户/单位重新询价；询不到才退回 0 让操作员自己填。
 */

/** 勾选赠品前的价格字段快照。两个编辑页用 priceSource*，新建页用 priceLabel*，这里是并集 */
export interface GiftPriceSnapshot {
  unitPrice: number
  /** 编辑页（销售单 / 报价单详情）的价格来源三件套 */
  priceSourceType?: string | null
  priceSourceDetail?: string | null
  priceSourceDate?: string | null
  /** 新建页（place-order）的价格来源标签 */
  priceLabel?: string
  priceLabelDetail?: string
}

/** 订单行上与赠品相关的字段（各页的行类型都是它的超集） */
export interface GiftLineFields extends Partial<GiftPriceSnapshot> {
  isGift?: boolean
  /** ⛔ 前端专用，非 DB 列：勾选赠品前的价格快照，提交前必须剔除 */
  preGiftPrice?: GiftPriceSnapshot | null
}

/** 勾选 / 取消勾选赠品后要打进行里的补丁（subtotal 由调用方按各自的数量字段重算） */
export type GiftTogglePatch = GiftPriceSnapshot & {
  isGift: boolean
  preGiftPrice: GiftPriceSnapshot | null
}

/** 只取行上真实存在的价格字段，避免给新建页的行凭空塞上 priceSourceType 之类的空键 */
function snapshotOf(line: GiftLineFields): GiftPriceSnapshot {
  const snap: GiftPriceSnapshot = { unitPrice: Number(line.unitPrice ?? 0) }
  if ('priceSourceType' in line) snap.priceSourceType = line.priceSourceType ?? null
  if ('priceSourceDetail' in line) snap.priceSourceDetail = line.priceSourceDetail ?? null
  if ('priceSourceDate' in line) snap.priceSourceDate = line.priceSourceDate ?? null
  if ('priceLabel' in line) snap.priceLabel = line.priceLabel
  if ('priceLabelDetail' in line) snap.priceLabelDetail = line.priceLabelDetail
  return snap
}

/**
 * 计算赠品勾选框变化后的行补丁。
 *
 * @param line     当前行
 * @param checked  勾选框的新状态
 * @param fallback 取消勾选且没有快照时（页面打开时就是赠品行）的重新询价回调
 */
export function applyGiftToggle(
  line: GiftLineFields,
  checked: boolean,
  fallback?: () => GiftPriceSnapshot | null,
): GiftTogglePatch {
  if (checked) {
    return {
      isGift: true,
      unitPrice: 0,
      // 已经是赠品的行再触发一次勾选（理论上不该发生），不能拿现在的 0 覆盖掉真快照
      preGiftPrice: line.isGift ? (line.preGiftPrice ?? null) : snapshotOf(line),
    }
  }
  const restored = line.preGiftPrice ?? fallback?.() ?? null
  return {
    ...(restored ?? {}),
    unitPrice: Number(restored?.unitPrice ?? 0),
    isGift: false,
    preGiftPrice: null,
  }
}

/** 提交前剔除只在前端存活的赠品快照字段 */
export function stripGiftSnapshot<T extends GiftLineFields>(lines: T[]): T[] {
  return lines.map(l => {
    if (!('preGiftPrice' in l)) return l
    const next = { ...l }
    delete next.preGiftPrice
    return next
  })
}
