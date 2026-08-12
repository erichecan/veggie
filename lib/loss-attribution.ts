/**
 * 损耗归因：环节（台账 E4）
 * ============================================================================
 * 需求要「记录分拣、运输、仓储各环节损耗，自动归因分析原因」。
 * 原因（`lib/scrap-reasons.ts`）回答「为什么坏的」，环节回答「在哪一步坏的」——
 * 两者正交：同样是「损坏」，发生在收货时是供应商/承运方的责任，发生在分拣时是自家操作，
 * 混成一个枚举就再也分不开，而这恰恰是归因的全部意义。
 *
 * ⚠️ 历史行的 lossStage 是 NULL。看板对这些行**按原因反推一个「推断环节」并标注**，
 * 而不是就地回填 —— 回填之后谁也分不清哪些是真填的、哪些是猜的。
 */

export const LOSS_STAGES = [
  'RECEIPT',
  'STORAGE',
  'SORTING',
  'TRANSPORT',
  'CUSTOMER_RETURN',
  'OTHER',
] as const

export type LossStage = (typeof LOSS_STAGES)[number]

export const LOSS_STAGE_LABEL: Record<LossStage, string> = {
  RECEIPT: '收货',
  STORAGE: '仓储',
  SORTING: '分拣',
  TRANSPORT: '运输',
  CUSTOMER_RETURN: '客退',
  OTHER: '其他',
}

export const LOSS_STAGE_LABEL_EN: Record<LossStage, string> = {
  RECEIPT: 'Receiving',
  STORAGE: 'Storage',
  SORTING: 'Sorting',
  TRANSPORT: 'Transport',
  CUSTOMER_RETURN: 'Customer return',
  OTHER: 'Other',
}

/** 责任归属提示：录入时给仓库人员看，避免「反正都是坏了」随便选一个 */
export const LOSS_STAGE_HINT: Record<LossStage, string> = {
  RECEIPT: '到货即发现，责任多在供应商/承运方，可据此索赔',
  STORAGE: '入库后在仓内变质/损坏，属自家仓储管理',
  SORTING: '分拣装车过程中造成的破损',
  TRANSPORT: '配送途中造成的损耗',
  CUSTOMER_RETURN: '客户退回后判定不可再售',
  OTHER: '以上都不是，请在备注里说明',
}

export function isLossStage(v: unknown): v is LossStage {
  return typeof v === 'string' && (LOSS_STAGES as readonly string[]).includes(v)
}

/**
 * 历史行没有 lossStage 时，按原因反推一个环节用于展示。
 * 返回 null 表示反推不出来（原因是 OTHER 或空）—— 那就老老实实显示「未归因」，
 * 不要塞进「其他」里假装已归因。
 */
export function inferStageFromReason(reason: string | null | undefined): LossStage | null {
  if (!reason) return null
  if (reason.startsWith('CUSTOMER_RETURN')) return 'CUSTOMER_RETURN'
  if (reason === 'RECEIPT_DAMAGE') return 'RECEIPT'
  if (reason.startsWith('WAREHOUSE')) return 'STORAGE'
  return null
}

export interface StageBreakdownRow {
  stage: LossStage | 'UNKNOWN'
  stageLabel: string
  qty: number
  /** 该环节里有多少数量是**推断**出来的（历史行），用于在看板上标注可信度 */
  inferredQty: number
}

export interface LossMoveForAttribution {
  qty: number
  lossStage?: string | null
  lossReason?: string | null
  /** 结构化字段为空时的兜底：从 note 反解出来的原因 key（老数据） */
  fallbackReason?: string | null
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * 按环节汇总（纯函数）。数量取绝对值 —— SCRAP 流水的 qty 是负数（出库方向），
 * 看板要展示的是「损失了多少」这个正数。
 */
export function summarizeByStage(
  moves: readonly LossMoveForAttribution[],
  labels: Record<LossStage, string> = LOSS_STAGE_LABEL,
  unknownLabel = '未归因',
): StageBreakdownRow[] {
  const acc = new Map<string, { qty: number; inferred: number }>()
  for (const m of moves) {
    const explicit = isLossStage(m.lossStage) ? m.lossStage : null
    const inferred = explicit ? null : inferStageFromReason(m.lossReason ?? m.fallbackReason)
    const key: string = explicit ?? inferred ?? 'UNKNOWN'
    const cur = acc.get(key) ?? { qty: 0, inferred: 0 }
    const q = Math.abs(m.qty)
    cur.qty += q
    if (!explicit && inferred) cur.inferred += q
    acc.set(key, cur)
  }
  return [...acc.entries()]
    .map(([stage, v]) => ({
      stage: stage as LossStage | 'UNKNOWN',
      stageLabel: stage === 'UNKNOWN' ? unknownLabel : labels[stage as LossStage],
      qty: round2(v.qty),
      inferredQty: round2(v.inferred),
    }))
    .sort((a, b) => b.qty - a.qty)
}
