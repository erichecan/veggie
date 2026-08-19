/**
 * 编辑态订单行的「草稿 id」
 * ============================================================================
 * ⛔ 后端 `app/api/orders/[id]/route.ts` 用 **`if (l.id)`** 区分 update / create：
 *
 *   - `l.id` 有值 → `orderLine.update({ where: { id } })`
 *   - `l.id` 为空 → `orderLine.create(...)`
 *
 * 所以新加的行**提交时 id 必须是空的**，否则后端会拿一个数据库里不存在的 id
 * 去 update，整个保存事务失败。
 *
 * 但前端又需要 id：`OrderLineEditor` 用 `key={line.id}` 渲染行，多个新行的 id
 * 全是空串会撞 key（这是改造前就存在的隐患，只是「底部搜索框一次只加一行」
 * 掩盖了它；改成「+ Add a product 连续插空行」后一插就现形）。
 *
 * 两个需求的交集就是这个模块：**前端用临时 id，提交前抹掉**。
 */

/** 草稿行 id 的前缀，取一个不可能与 cuid 撞上的形状 */
const DRAFT_PREFIX = 'draft:'

let counter = 0

/** 生成一个新的草稿行 id。只在前端存活，不会进数据库。 */
export function newDraftLineId(): string {
  counter += 1
  return `${DRAFT_PREFIX}${counter}`
}

/** 这行是不是新加的（还没落库）？ */
export function isDraftLineId(id: string | null | undefined): boolean {
  return !id || id.startsWith(DRAFT_PREFIX)
}

/**
 * 提交前把草稿 id 抹成空串，已落库的行保持原 id。
 *
 * 这一步漏了，后端就会把新行当成已有行去 update —— 见文件头。
 */
export function stripDraftId<T extends { id?: string | null }>(line: T): T {
  return isDraftLineId(line.id) ? { ...line, id: '' } : line
}

/** 整批处理，顺手把 sequence 按当前顺序重排 */
export function toSubmittableLines<T extends { id?: string | null }>(lines: T[]): T[] {
  return lines.map((l, idx) => ({ ...stripDraftId(l), sequence: idx }))
}
