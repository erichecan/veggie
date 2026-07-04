export type WaveStage = 'assigning' | 'assignment_done' | 'in_transit' | 'completed'

export interface WaveStageInput {
  assignmentDoneAt: string | Date | null
  dispatchedAt: string | Date | null
  completedAt: string | Date | null
}

/**
 * 批次在配送调度台的展示阶段。优先级恒为：
 * completed > in_transit(已出发) > assignment_done(分配完成) > assigning(分配中)。
 */
export function waveStage(w: WaveStageInput): WaveStage {
  if (w.completedAt) return 'completed'
  if (w.dispatchedAt) return 'in_transit'
  if (w.assignmentDoneAt) return 'assignment_done'
  return 'assigning'
}
