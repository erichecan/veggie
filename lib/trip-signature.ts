/**
 * 电子签收（Sign on Glass）的服务端完整性规则。
 *
 * 签名是收货凭证，日后可能用于纠纷举证，所以有两条不能让客户端说了算：
 *
 * 1. **时间戳由服务端打**。客户端时钟可以随便改，签收时间若来自手机就毫无证明力。
 * 2. **签过就不许改**。`PUT /api/trips/[id]` 是整包覆盖 `restaurants` JSON 的，
 *    如果不拦，任何一次后续保存都能把已有签名换掉或抹掉，凭证等于没有。
 *    要更正只能走主管纠错路径（目前尚未提供，见台账遗留项）。
 *
 * 另外限制体积：签名走 Trip.restaurants 这个 JSON 列，塞进一张几 MB 的图会把整行撑爆，
 * 也会拖慢所有读行程的查询。正常手写签名 PNG 在 10–50KB。
 */

/** 签名 PNG 解码后的体积上限。手写签名远小于此，超了说明塞的不是签名 */
export const MAX_SIGNATURE_BYTES = 200 * 1024

const PNG_DATA_URI = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/

export interface SignatureBearing {
  restaurantId?: string
  restaurantName?: string
  signature?: string | null
  signerName?: string | null
  signedAt?: string | null
}

export type SignatureIssue =
  | { kind: 'invalid_format'; restaurantId: string }
  | { kind: 'too_large'; restaurantId: string; bytes: number }
  | { kind: 'missing_signer'; restaurantId: string }
  | { kind: 'immutable'; restaurantId: string; restaurantName?: string }

/** data URI 解码后的字节数；格式不对返回 null */
export function decodedPngBytes(dataUri: string): number | null {
  const m = PNG_DATA_URI.exec(dataUri.trim())
  if (!m) return null
  const b64 = m[1]
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - padding
}

function asList(v: unknown): SignatureBearing[] {
  return Array.isArray(v) ? (v as SignatureBearing[]) : []
}

/**
 * 校验并规整传入的 restaurants：
 * - 新出现的签名 → 校验格式与体积、要求签收人姓名、用服务端时间覆盖 signedAt
 * - 已存在的签名 → 一律以库里的为准，客户端改了也不采纳，并报 immutable
 *
 * 返回规整后的数组与问题清单。调用方决定是 400 还是 409。
 */
export function reconcileSignatures(
  beforeRestaurants: unknown,
  incomingRestaurants: unknown,
  now: Date,
): { restaurants: SignatureBearing[]; issues: SignatureIssue[] } {
  const before = asList(beforeRestaurants)
  const incoming = asList(incomingRestaurants)
  const beforeById = new Map(before.filter(r => r.restaurantId).map(r => [r.restaurantId as string, r]))
  const issues: SignatureIssue[] = []

  const restaurants = incoming.map(rest => {
    const id = rest.restaurantId ?? ''
    const prior = beforeById.get(id)
    const priorSig = prior?.signature ?? null
    const nextSig = rest.signature ?? null

    // 已签过：库里的签名、签收人、时间一律原样保留
    if (priorSig) {
      if (nextSig !== priorSig) {
        issues.push({ kind: 'immutable', restaurantId: id, restaurantName: rest.restaurantName })
      }
      return {
        ...rest,
        signature: priorSig,
        signerName: prior?.signerName ?? null,
        signedAt: prior?.signedAt ?? null,
      }
    }

    // 本次没带签名：原样返回（清掉可能被伪造的时间戳）
    if (!nextSig) {
      const { ...rest2 } = rest
      if (rest2.signedAt) rest2.signedAt = null
      return rest2
    }

    // 新签名：校验
    const bytes = decodedPngBytes(nextSig)
    if (bytes === null) {
      issues.push({ kind: 'invalid_format', restaurantId: id })
      return { ...rest, signature: null, signerName: null, signedAt: null }
    }
    if (bytes > MAX_SIGNATURE_BYTES) {
      issues.push({ kind: 'too_large', restaurantId: id, bytes })
      return { ...rest, signature: null, signerName: null, signedAt: null }
    }
    if (!rest.signerName || !String(rest.signerName).trim()) {
      issues.push({ kind: 'missing_signer', restaurantId: id })
      return { ...rest, signature: null, signerName: null, signedAt: null }
    }

    return {
      ...rest,
      signature: nextSig,
      signerName: String(rest.signerName).trim().slice(0, 40),
      // ⚠️ 客户端传什么时间都不采纳
      signedAt: now.toISOString(),
    }
  })

  return { restaurants, issues }
}

/** 把问题清单转成一句人话，用于 API 错误响应 */
export function describeIssues(issues: SignatureIssue[]): string {
  return issues.map(i => {
    switch (i.kind) {
      case 'invalid_format': return `站点 ${i.restaurantId} 的签名不是合法的 PNG data URI`
      case 'too_large': return `站点 ${i.restaurantId} 的签名过大（${Math.round(i.bytes / 1024)}KB，上限 ${MAX_SIGNATURE_BYTES / 1024}KB）`
      case 'missing_signer': return `站点 ${i.restaurantId} 提交了签名但没有签收人姓名`
      case 'immutable': return `${i.restaurantName ?? i.restaurantId} 已完成签收，签名不可更改；如需更正请联系主管`
    }
  }).join('；')
}
