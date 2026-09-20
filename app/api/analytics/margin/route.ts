import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { SALES_COUNTED_STATUSES, resolveDateRange, toNaiveTimestampParam } from '@/lib/analytics/metrics'
import { DATE_BASIS_EXPR, dimensionDefs, buildPivot, PivotTooManyColumnsError, DRIVER_JOIN, DRIVER_NAME_EXPR, type DateBasis, type PivotRawCell } from '@/lib/analytics/pivot'
import { withCachedAuth } from '@/lib/analytics/cache'

/**
 * /api/analytics/margin — 毛利分析
 * ============================================================================
 * GET ?from&to&groupBy=product|category|customer|salesUser|driver|day|week|month
 *     &colBy=<同上，可选，传了就是透视模式>
 *     &categoryId&customerId&salesUserId&productId&driverName（可选精确过滤）
 *     &dateBasis=confirmation|delivery（默认 confirmation，见 lib/analytics/pivot.ts DATE_BASIS_EXPR）
 * 毛利口径（税前）：Σ (unitPrice − unitCostRef) × orderedQty
 * unitCostRef 优先级：≤确认日最近的批次加权成本（v_lot_daily_cost）
 *                    → Product.standardPrice → Template.standardPrice → 0
 * 每行返回 costedAmount（有批次成本的金额），前端展示成本覆盖率。
 * 不传 colBy 时行为与透视模式改造前完全一致；透视设计见 docs/20260731-flexible-pivot-analysis-design.md
 */

const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')

/**
 * 多单位销售(20260714)：ol."orderedQty" 按行选用单位计数，非商品"基准单位"(p."uomId")时
 * 需要换算成基准单位数量再参与 SUM，否则"箱"和"个"直接相加/相乘会失真。
 *
 * ⛔ 20260827 修复：换算系数必须来自 ProductSaleUom.factor（挂在商品上，一箱几包各商品不同），
 * 不能用全局 Uom.factor —— 20260819 换算系数改挂商品之后，生产库 Unit/Weight 类目下
 * Uom.factor 早就不再维护，实测同名 CASE/1KG/500g 全部还是 1，导致这里原来的换算公式
 * 恒等于"不换算"（比例算出来永远是 1/1），和口径注释描述的行为完全对不上。
 * 换算口径与 lib/inventory.ts 的 toStockQty、lib/sale-uom.ts 的 factorOf 保持一致。
 */
const STOCK_QTY_EXPR = `(ol."orderedQty" * COALESCE(psu.factor, 1))`

/**
 * 含税总额(税后)行级换算，口径与 lib/order-items.ts 的 orderIncTaxTotal 一致：
 * subtotal(税前) × (1 + taxRate 归一后的小数)。仅供本路由 sales-analysis 周/日钻取用，
 * 不进 buildPivot/PivotRawCell（那条链路是 margin 分析页的行列交叉透视，保持不动）。
 */
const TAX_FRACTION_EXPR = `(CASE WHEN COALESCE(ol."taxRate", 0) > 1 THEN COALESCE(ol."taxRate", 0) / 100.0 ELSE COALESCE(ol."taxRate", 0) END)`

/**
 * 毛重(kg)。20260920 加，口径由用户拍板：**可售单位的 grossWeight 优先，没有的用商品基础 weight 兜底**。
 *
 * ⛔ 两个字段的乘数不一样，不能写成一个 COALESCE 再统一乘：
 *   - psu."grossWeight" 是「该可售单位自己」的毛重（1 箱 = 3.2kg）→ 乘**下单数量** orderedQty
 *   - p.weight 是商品**基础单位**的重量 → 要先把 orderedQty 换算成基础单位数（× factor）再乘
 *
 * ⚠ 生产实测（20260920，近 90 天 20249 行）：psu."grossWeight" 只有 163 行(0.8%)有值，
 * 15382 行(76%)靠 p.weight 兜底，4704 行(23.2%)两者都没有 → 毛重合计**系统性偏低**，
 * 按金额算覆盖率 74.3%。所以一并返回 weightedAmount，前端要把覆盖率显示出来，
 * 不能让人以为这个合计是完整的。
 */
const GROSS_WEIGHT_EXPR = `(CASE WHEN COALESCE(psu."grossWeight", 0) > 0
         THEN psu."grossWeight" * ol."orderedQty"
         ELSE COALESCE(p.weight, 0) * ${STOCK_QTY_EXPR} END)`

/**
 * 提成。公式与 lib/commission.ts:sumCommission 同源：件提成 + 客户固定费 + 实送税前额 × 费率。
 *
 * ⛔ 提成只认 **deliveredQty**（实送量），不是 orderedQty —— 与销售额/毛利那几列的基准不同，
 * 这是故意的（没送到就没提成），别为了"看起来一致"改成 orderedQty。
 * ⛔ 固定费是**订单级**的，没法直接归给某个产品/某一行，按该行税前额占整单的比例分摊，
 * 这样无论按哪个维度分组，各行相加都等于整单的固定费（守恒）。
 * ⚠ 生产实测：commissionFixed 目前 0 单有值、commissionPrice 仅 2.6% 的行有值、
 * commissionRate 仅 81/2322 单有值 → 这一列在生产上 97% 显示 0，是主数据没维护，不是算错。
 */
const COMMISSION_EXPR = `(COALESCE(ol."commissionPrice", 0) * COALESCE(ol."deliveredQty", 0)
         + COALESCE(ol."unitPrice", 0) * COALESCE(ol."deliveredQty", 0) * COALESCE(o."commissionRate", 0)
         + CASE WHEN COALESCE(oa.order_delivered, 0) > 0 AND COALESCE(oa.order_subtotal, 0) <> 0
                THEN COALESCE(o."commissionFixed", 0) * ol.subtotal / oa.order_subtotal
                ELSE 0 END)`

/** 整单的税前额与实送量，供 COMMISSION_EXPR 分摊固定费用 */
const ORDER_AGG_JOIN = `LEFT JOIN LATERAL (
           SELECT SUM(ol2.subtotal)::float AS order_subtotal,
                  SUM(COALESCE(ol2."deliveredQty", 0))::float AS order_delivered
           FROM "OrderLine" ol2
           WHERE ol2."orderId" = o.id AND ol2."isGift" = false
         ) oa ON TRUE`

/**
 * 单位（UOM）。只在 groupBy=product 时才选出来 —— 别的维度（客户/司机/品类）底下
 * 混着几十种单位，聚出来是一长串噪音。
 *
 * ⛔ 不能假设「一个产品一个单位」：生产实测（20260920，近 90 天）6227 个「产品×天」
 * 分组里有 345 组（**5.54%**）同时用了多种单位（同一商品既按 CASE 又按 KG 卖）。
 * 所以这里是 string_agg 而不是 MAX —— 多单位的行会显示成「CASE, KG」，是实情。
 * 空 uomName（3.8% 的行，20260823 之前的历史行）按 lib/sale-uom.ts:displayUomName
 * 的口径归成 ⚠ Unit(s)，跟单据上的显示保持一致。
 */
const UOM_NAMES_EXPR = `string_agg(DISTINCT CASE WHEN COALESCE(ol."uomName", '') IN ('', 'Unit(s)')
                                                 THEN '⚠ Unit(s)' ELSE ol."uomName" END, ', ')`

const round2 = (n: number) => Math.round(n * 100) / 100

export async function GET(req: Request) {
  return withCachedAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))
      const groupBy = searchParams.get('groupBy') ?? 'product'
      // 20260916：日期口径可选。销售钻取页传 delivery（按送货日归集），其余调用方
      // 不传 → confirmation，行为与改造前完全一致。白名单取值，不拼请求参数进 SQL。
      const basisParam = searchParams.get('dateBasis')
      if (basisParam && !(basisParam in DATE_BASIS_EXPR)) {
        return NextResponse.json({ error: `dateBasis 必须是 ${Object.keys(DATE_BASIS_EXPR).join('/')}` }, { status: 400 })
      }
      const dateBasis = (basisParam ?? 'confirmation') as DateBasis
      const dateExpr = DATE_BASIS_EXPR[dateBasis]
      const DIMENSION_DEFS = dimensionDefs(dateBasis)
      const colByParam = searchParams.get('colBy')
      const categoryId = searchParams.get('categoryId')
      const customerId = searchParams.get('customerId')
      const salesUserId = searchParams.get('salesUserId')
      const productId = searchParams.get('productId')
      // 20260920：销售钻取的右面板要做「某天 × 某司机 → 该司机的客户 → 客户的产品」嵌套下钻，
      // 司机没有稳定 id（见 pivot.ts driver 维度注释），所以按司机名筛
      const driverName = searchParams.get('driverName')

      const rowDef = DIMENSION_DEFS[groupBy]
      if (!rowDef) {
        return NextResponse.json({ error: `groupBy 必须是 ${Object.keys(DIMENSION_DEFS).join('/')}` }, { status: 400 })
      }
      const colBy = colByParam || null
      const colDef = colBy ? DIMENSION_DEFS[colBy] : null
      if (colBy && !colDef) {
        return NextResponse.json({ error: `colBy 必须是 ${Object.keys(DIMENSION_DEFS).join('/')}` }, { status: 400 })
      }
      if (colBy && colBy === groupBy) {
        return NextResponse.json({ error: '行列维度不能相同' }, { status: 400 })
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      const params: unknown[] = [toNaiveTimestampParam(start), toNaiveTimestampParam(end)]
      const filters: string[] = []
      // 20260920：category/salesUser 维度的 keyExpr 对 NULL 用了占位值（'uncategorized' / 'none'），
      // 嵌套下钻会把这个占位值原样传回来当筛选条件 —— 直接 = 比较永远匹配不到，
      // 点进「未分类」「未指定业务员」那一行会得到空表。这里翻译回 IS NULL。
      if (categoryId) {
        if (categoryId === 'uncategorized') { filters.push(`p."categoryId" IS NULL`) }
        else { params.push(categoryId); filters.push(`p."categoryId" = $${params.length}`) }
      }
      // 20260915：customerId/productId 改支持逗号分隔多值（销售钻取新增"多选客户/产品"筛选），
      // 用 = ANY(text[]) 统一处理，单值传入等价于原来的 = 比较，不破坏现有单选调用方
      if (customerId) { params.push(customerId.split(',').filter(Boolean)); filters.push(`o."restaurantId" = ANY($${params.length}::text[])`) }
      if (salesUserId) {
        if (salesUserId === 'none') { filters.push(`o."salesUserId" IS NULL`) }
        else { params.push(salesUserId); filters.push(`o."salesUserId" = $${params.length}`) }
      }
      if (productId) { params.push(productId.split(',').filter(Boolean)); filters.push(`ol."productId" = ANY($${params.length}::text[])`) }
      if (driverName) { params.push(driverName); filters.push(`${DRIVER_NAME_EXPR} = $${params.length}`) }
      const extraWhere = filters.length ? ` AND ${filters.join(' AND ')}` : ''

      // 20260920：销售钻取的产品明细要在产品名后面显示单位（客户截图批注）
      const uomSelect = groupBy === 'product' ? `, ${UOM_NAMES_EXPR} AS uom_names` : ''
      const colSelect = colDef ? `, ${colDef.keyExpr} AS col_key, ${colDef.nameExpr} AS col_name` : ''
      const colGroupBy = colDef ? `, ${colDef.keyExpr}` : ''

      // 同一段 JOIN 可能被行维度、列维度、driverName 筛选同时要到（ds/w 别名只能出现一次），
      // 用 Set 去重后再拼
      const joinSet = new Set<string>()
      if (rowDef.extraJoin) joinSet.add(rowDef.extraJoin)
      if (colDef?.extraJoin) joinSet.add(colDef.extraJoin)
      if (driverName) joinSet.add(DRIVER_JOIN)
      joinSet.add(ORDER_AGG_JOIN)
      const dimJoins = [...joinSet].join('\n         ')

      const rows = (await p.$queryRawUnsafe(
        `SELECT ${rowDef.keyExpr} AS row_key,
                ${rowDef.nameExpr} AS row_name
                ${colSelect}${uomSelect},
                COUNT(*)::int AS line_count,
                SUM(${STOCK_QTY_EXPR})::float AS qty,
                SUM(ol.subtotal)::float AS revenue_ex,
                SUM(ol.subtotal * (1 + ${TAX_FRACTION_EXPR}))::float AS total_inc_tax,
                SUM(COALESCE(lc.unit_cost, p."standardPrice", 0) * ${STOCK_QTY_EXPR})::float AS cost,
                SUM(ol.subtotal - COALESCE(lc.unit_cost, p."standardPrice", 0) * ${STOCK_QTY_EXPR})::float AS gross_profit,
                SUM(CASE WHEN lc.unit_cost IS NOT NULL THEN ol.subtotal ELSE 0 END)::float AS costed_amount,
                SUM(${GROSS_WEIGHT_EXPR})::float AS gross_weight,
                SUM(CASE WHEN COALESCE(psu."grossWeight", 0) > 0 OR COALESCE(p.weight, 0) > 0
                         THEN ol.subtotal ELSE 0 END)::float AS weighted_amount,
                SUM(${COMMISSION_EXPR})::float AS commission
         FROM "OrderLine" ol
         JOIN "Order" o ON o.id = ol."orderId"
         LEFT JOIN "Product" p ON p.id = ol."productId"
         LEFT JOIN "ProductSaleUom" psu ON psu."productId" = ol."productId" AND psu."uomId" = ol."uomId"
         ${dimJoins}
         LEFT JOIN LATERAL (
           SELECT c.unit_cost FROM v_lot_daily_cost c
           WHERE c.product_id = ol."productId"
             AND c.cost_date <= COALESCE(${dateExpr}, o."createdAt")::date
           ORDER BY c.cost_date DESC LIMIT 1
         ) lc ON TRUE
         WHERE o.status::text IN (${SALES_STATUS_SQL})
           AND ${dateExpr} >= $1::timestamp AND ${dateExpr} < $2::timestamp
           AND ol."isGift" = false
           ${extraWhere}
         GROUP BY ${rowDef.keyExpr}${colGroupBy}
         ORDER BY SUM(ol.subtotal - COALESCE(lc.unit_cost, p."standardPrice", 0) * ${STOCK_QTY_EXPR}) DESC`,
        ...params,
      )) as Array<{
        row_key: string; row_name: string; col_key?: string; col_name?: string
        line_count: number; qty: number; revenue_ex: number; total_inc_tax: number; cost: number; gross_profit: number; costed_amount: number
        gross_weight: number; weighted_amount: number; commission: number
        uom_names?: string | null
      }>

      const totalRevenue = rows.reduce((s, r) => s + r.revenue_ex, 0)
      const totalIncTax = rows.reduce((s, r) => s + r.total_inc_tax, 0)
      const totalProfit = rows.reduce((s, r) => s + r.gross_profit, 0)
      const totalCosted = rows.reduce((s, r) => s + r.costed_amount, 0)
      const totalWeight = rows.reduce((s, r) => s + r.gross_weight, 0)
      const totalWeighted = rows.reduce((s, r) => s + r.weighted_amount, 0)
      const totalCommission = rows.reduce((s, r) => s + r.commission, 0)
      const summary = {
        revenueExTax: round2(totalRevenue),
        totalIncTax: round2(totalIncTax),
        grossProfit: round2(totalProfit),
        marginPct: totalRevenue > 0 ? round2((totalProfit / totalRevenue) * 100) : 0,
        costCoverageRate: totalRevenue > 0 ? Math.round((totalCosted / totalRevenue) * 10000) / 10000 : 0,
        grossWeight: round2(totalWeight),
        commission: round2(totalCommission),
        // 毛重覆盖率：有重量数据的金额 / 总金额。前端必须显示它——生产上只有 74.3%，
        // 不显示就等于默认这个合计是全的
        weightCoverageRate: totalRevenue > 0 ? Math.round((totalWeighted / totalRevenue) * 10000) / 10000 : 0,
      }

      if (!colDef) {
        return NextResponse.json(serializeApi({
          summary: { ...summary, vat: round2(totalIncTax - totalRevenue) },
          rows: rows.map((r) => ({
            key: r.row_key,
            name: r.row_name,
            lineCount: r.line_count,
            qty: Math.round(r.qty * 1000) / 1000,
            revenueExTax: round2(r.revenue_ex),
            totalIncTax: round2(r.total_inc_tax),
            // 20260915：销售钻取新增指标——vat(税额)、avgPrice(均价，税前单价)
            vat: round2(r.total_inc_tax - r.revenue_ex),
            avgPrice: r.qty > 0 ? round2(r.revenue_ex / r.qty) : 0,
            cost: round2(r.cost),
            grossProfit: round2(r.gross_profit),
            marginPct: r.revenue_ex > 0 ? round2((r.gross_profit / r.revenue_ex) * 100) : 0,
            costCoverage: r.revenue_ex > 0 ? Math.round((r.costed_amount / r.revenue_ex) * 10000) / 10000 : 0,
            // 20260920 新增两列（销售钻取右面板要横向显示）
            grossWeight: round2(r.gross_weight),
            commission: round2(r.commission),
            weightCoverage: r.revenue_ex > 0 ? Math.round((r.weighted_amount / r.revenue_ex) * 10000) / 10000 : 0,
            // 只有 groupBy=product 时有值；多单位商品会是「CASE, KG」这种
            uomNames: r.uom_names ?? null,
          })),
        }))
      }

      const rawCells: PivotRawCell[] = rows.map((r) => ({
        rowKey: r.row_key,
        rowName: r.row_name,
        colKey: String(r.col_key),
        colName: String(r.col_name),
        qty: r.qty,
        revenueExTax: r.revenue_ex,
        cost: r.cost,
        grossProfit: r.gross_profit,
      }))

      try {
        const pivot = buildPivot(rawCells, { rowIsTimeBucket: rowDef.isTimeBucket, colIsTimeBucket: colDef.isTimeBucket })
        return NextResponse.json(serializeApi({ summary, ...pivot }))
      } catch (err) {
        if (err instanceof PivotTooManyColumnsError) {
          return NextResponse.json({ error: err.message }, { status: 400 })
        }
        throw err
      }
    } catch (error) {
      console.error('[GET /api/analytics/margin]', error)
      return NextResponse.json({ error: '获取毛利分析失败' }, { status: 500 })
    }
  }, { require: 'analytics.margin.read' })
}
