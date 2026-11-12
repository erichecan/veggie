/**
 * 客户列表的分面维度定义 —— 该资源「可搜什么」的唯一真相。
 * 语义：同一维度多值 OR，不同维度之间 AND（lib/facet-sql.ts buildFacetWhere 保证）。
 * 当前仅开放客户名称、业务员和价格表三个维度；地址/联系方式等不放在这个搜索栏里。
 */
import type { FacetDef } from '../facet-sql'
import { prisma } from '@/lib/db'

const like = (v: string) => ({ contains: v, mode: 'insensitive' as const })
/** 纯数字时顺带按客户/供应商编号精确匹配(20261007)：编号是给人记的短号，搜它应该能直达 */
const byNo = (v: string) => (/^\d{1,9}$/.test(v.trim()) ? [{ customerNo: Number(v.trim()) }] : [])

export const CUSTOMER_FACET_DEFS: FacetDef[] = [
  {
    key: 'name',
    label: '名称',
    toClause: v => {
      const numberMatches = byNo(v)
      return numberMatches.length > 0
        ? { OR: [{ name: like(v) }, ...numberMatches] }
        : { name: like(v) }
    },
  },
  { key: 'salesman',  label: '业务员', toClause: v => ({ salesUser: { name: like(v) } }) },
  {
    key: 'pricelist',
    label: '价格表',
    toClause: async v => {
      const lists = await prisma.odooPricelist.findMany({
        where: { name: like(v) },
        select: { id: true },
      })
      return lists.length > 0
        ? { pricelists: { some: { pricelistId: { in: lists.map(p => p.id) } } } }
        : { pricelists: { some: { pricelistId: '__no_matching_pricelist__' } } }
    },
  },
]
