import { prisma } from '@/lib/db'

/**
 * lib/sale-uom.ts 里那部分的 server-only 延伸 —— 单独开一个文件是因为 lib/sale-uom.ts
 * 被多个客户端组件（place-order/orders/quotations 编辑页）直接 import 纯函数（priceOf 等），
 * 一旦这个文件顶层 import prisma，Next 会把 pg/prisma 打进浏览器 bundle 直接编译失败
 * （20260901 实测：quotations/[id] 页面 500，报 Module not found 'util/types'）。
 */

/**
 * 校验一批订单行选的单位，是否都是该商品当前允许出售的单位：锚点单位
 * （`Product.uomId`）或某一行 `active=true` 的 `ProductSaleUom`。
 *
 * 前端「Sellable」开关（product 编辑页）就是靠 `ProductSaleUom.active` 控制
 * 某个单位能不能出现在下单/报价的选择框里；这里是同一口径的服务端兜底 ——
 * 之前只有 `PUT /api/orders/[id]` 编辑**已有行**时校验过，新建订单/报价单、
 * 追加行、以及同一次 PUT 里新增的行都没查，被停用的单位（如客户关掉的整箱
 * Case）仍能靠这几条路径绕过前端下拉框直接落库。
 *
 * `uomId` 为空/未传视为合法（历史上允许不显式指定单位）。返回第一个不合法
 * 的错误信息；全部合法返回 null。
 */
export async function findInvalidLineUom(
  lines: Array<{ productId: string; productName?: string | null; uomId?: string | null }>,
): Promise<string | null> {
  const candidates = lines.filter((l) => l.uomId)
  if (candidates.length === 0) return null

  const productIds = Array.from(new Set(candidates.map((l) => l.productId)))
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      name: true,
      uomId: true,
      saleUoms: { select: { uomId: true, active: true } },
    },
  })
  const infoMap = new Map(
    products.map((p) => {
      // 锚点(基础)单位没有独立配置行时，历史上一直允许——只有真的建了那一行
      // 且 active=false 才算被停用；额外单位则维持"只认 active=true 那些行"。
      const baseRow = p.saleUoms.find((s) => s.uomId === p.uomId)
      const baseAllowed = baseRow ? baseRow.active : true
      const extra = p.saleUoms.filter((s) => s.uomId !== p.uomId && s.active).map((s) => s.uomId)
      const allowed = new Set([...(baseAllowed && p.uomId ? [p.uomId] : []), ...extra].filter((v): v is string => !!v))
      return [p.id, { name: p.name, allowed }]
    }),
  )

  for (const l of candidates) {
    const info = infoMap.get(l.productId)
    const productLabel = l.productName || info?.name || ''
    if (!info || !info.allowed.has(String(l.uomId))) {
      return `商品「${productLabel}」不支持切换到该单位`
    }
  }
  return null
}
