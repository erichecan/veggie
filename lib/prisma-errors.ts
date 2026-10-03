/**
 * 判断一个 Prisma 错误是不是"某个字段"的 P2002 唯一约束冲突。
 *
 * ⚠️ 本项目走 driver adapter（@prisma/adapter-pg，见 lib/db-driver.ts），P2002 的
 * `meta` 不是经典 Prisma 的 `{ target: string[] }`，而是
 * `{ driverAdapterError: { cause: { constraint: { fields: [...] } } } }`，
 * 结构因驱动版本而异、不可靠。实测（20261003，见 docs 同日报告）唯一稳定信号是
 * `error.message` 里固定出现的 "Unique constraint failed on the fields: (`"fieldName"`)"。
 * 项目里原有几处（orders/route.ts、customer-portal/orders/route.ts 的订单号撞车重试）
 * 还在按 `meta.target` 判断，在当前驱动下恒为 false、从未真正重试过，一并改用这里。
 */
export function isUniqueConstraintOn(error: unknown, fieldName: string): boolean {
  const err = error as { code?: string; message?: string }
  if (err?.code !== 'P2002') return false
  return typeof err.message === 'string' && err.message.includes(`\`"${fieldName}"\``)
}
