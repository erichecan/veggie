import { prisma } from './db'

interface LogParams {
  userId: string
  userEmail: string
  userName: string
  action: 'LOGIN' | 'CREATE' | 'UPDATE' | 'DELETE'
  resource: string
  resourceId?: string
  detail?: string
  /**
   * 结构化附加数据。主用途仍是字段级前后值 diff，例如 {"price":{"before":10,"after":12}}；
   * 也用于挂载查询方需要机器读取的元数据（如打印痕迹 {"print":{"docType":"delivery"}}）——
   * 否则查询方只能去反解 detail 那串中文，改一个字就全断。schema 里本就是 Json?。
   */
  changes?: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
}

/**
 * 写审计日志。永远不抛错，失败静默（日志写入不能阻塞业务流）。
 * schema 里的 changes/ipAddress/userAgent 是 Sprint 1 新增，老 Prisma client 若未
 * `prisma generate` 会缺字段，这里用 try/catch 兜底。
 */
export async function writeLog(params: LogParams) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    await p.actionLog.create({
      data: {
        userId: params.userId,
        userEmail: params.userEmail,
        userName: params.userName,
        action: params.action,
        resource: params.resource,
        resourceId: params.resourceId ?? null,
        detail: params.detail ?? null,
        changes: params.changes ?? undefined,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
      },
    })
  } catch {
    // 日志写入不能影响主流程
  }
}

/**
 * 从 request 提取 IP 和 UA，调用者可透传到 writeLog。
 */
export function extractRequestMeta(req: Request): { ipAddress?: string; userAgent?: string } {
  const xff = req.headers.get('x-forwarded-for')
  const real = req.headers.get('x-real-ip')
  const ip = (xff?.split(',')[0].trim()) || real || undefined
  const ua = req.headers.get('user-agent') ?? undefined
  return { ipAddress: ip, userAgent: ua }
}

/**
 * 计算 before / after 对象的字段级 diff。
 * 只包含实际变化的字段。undefined/null 视为 "没设" 不参与比较。
 */
export function diffChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: string[],
): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {}
  for (const k of keys) {
    const b = before[k]
    const a = after[k]
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      out[k] = { before: b, after: a }
    }
  }
  return out
}
