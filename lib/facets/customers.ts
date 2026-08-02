/**
 * 客户列表的分面维度定义 —— 该资源「可搜什么」的唯一真相。
 * 语义：同一维度多值 OR，不同维度之间 AND（lib/facet-sql.ts buildFacetWhere 保证）。
 * 'all' 不在此声明，它走路由已有的 search 参数。
 *
 * 已按 docs/20260802-facet-dimension-data-readiness.md 的填充率体检裁剪：
 * 剔除 state(7/1605, 0.4%)、externalNote(全空)；email(5.2%)、vatNumber(2.9%) 覆盖率低但保留
 * （业务上确有按税号/邮箱找客户的场景，搜不到属数据缺失而非功能缺失）。
 */
import type { FacetDef } from '../facet-sql'

const like = (v: string) => ({ contains: v, mode: 'insensitive' as const })

export const CUSTOMER_FACET_DEFS: FacetDef[] = [
  { key: 'name',      label: '名称',   toClause: v => ({ name: like(v) }) },
  { key: 'city',      label: '城市',   toClause: v => ({ city: like(v) }) },
  { key: 'address',   label: '地址',   toClause: v => ({ OR: [{ address: like(v) }, { street: like(v) }, { street2: like(v) }] }) },
  { key: 'phone',     label: '电话',   toClause: v => ({ phone: like(v) }) },
  { key: 'email',     label: '邮箱',   toClause: v => ({ email: like(v) }) },
  { key: 'vat',       label: '税号',   toClause: v => ({ vatNumber: like(v) }) },
  { key: 'salesman',  label: '业务员', toClause: v => ({ salesUser: { name: like(v) } }) },
]
