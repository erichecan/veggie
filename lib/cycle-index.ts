/** Move a highlighted option through a list, wrapping at either end. */
export function cycleIndex(current: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return -1
  if (current < 0) return delta === 1 ? 0 : length - 1
  return (current + delta + length) % length
}
