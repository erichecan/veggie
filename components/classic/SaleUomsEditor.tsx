'use client'
import { toast } from 'sonner'
import { NumericInput } from '@/components/ui/numeric-input'
import {
  priceOf, commissionPriceOf,
  isBaseSaleUomRow, makeDefaultSaleUomFormRow, findAddableSaleUom, removeSaleUomFormRow,
  type SaleUomFormRow,
} from '@/lib/sale-uom'

/**
 * 商品「可售单位」编辑器 —— 商品详情页与商品列表页的可售单位弹窗共用（20260908 抽取）。
 * ============================================================================
 * 原本这套 UI + 增删改逻辑只写在 products/[id]/page.tsx 里，客户要求列表页也能直接管理
 * 可售单位（不用打开详情页），与其在列表弹窗里重写一遍，不如把这块抽出来两处共用——
 * 详情页和弹窗以后任何一处改了单位编辑的行为，另一处自动跟着变，不会再各改各的分叉。
 *
 * 组件本身不做数据获取/保存，只管"编辑这份 saleUoms 数组"：拿 props 进来的数据，
 * 增删改都通过 onChange 交回给调用方；保存交给 onSave（不传就是"新建商品"场景，
 * 提示随外层表单一起创建，不单独出现保存按钮）。
 */

interface UomOption {
  id: string
  name: string
  nameZh?: string | null
  categoryId?: string
}

export interface SaleUomsEditorProps {
  saleUoms: SaleUomFormRow[]
  onChange: (rows: SaleUomFormRow[]) => void
  uoms: readonly UomOption[]
  /** 基准单位（ProductTemplate.uomId）；这个编辑器不能改它，只能在这里读 */
  baseUomId?: string | null
  baseListPrice: number
  baseCommissionPrice: number | null
  editMode: boolean
  isEn: boolean
  /** 传了就在"＋ 添加单位"旁边渲染一个独立的保存按钮 */
  onSave?: () => void | Promise<void>
  saving?: boolean
  /**
   * 没传 onSave 时，默认显示"随下方保存按钮一起创建"提示（新建商品流程，外层表单统一保存）。
   * 调用方是"外层自己有一套保存按钮/弹窗 Footer"（如商品列表页的可售单位弹窗）而不是这两种
   * 场景时，传 false 把这行提示也关掉，只留"＋ 添加单位"。
   */
  showCreateHint?: boolean
}

const fieldClass = 'w-full h-8 px-2 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 bg-white'
const focusStyle = { '--tw-ring-color': '#875A7B' } as React.CSSProperties
const btnBase = 'h-8 px-3 text-sm rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition-colors'

export default function SaleUomsEditor({
  saleUoms, onChange, uoms, baseUomId, baseListPrice, baseCommissionPrice, editMode, isEn, onSave, saving,
  showCreateHint = true,
}: SaleUomsEditorProps) {
  function updateRow(index: number, patch: Partial<SaleUomFormRow>) {
    onChange(saleUoms.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  function addRow() {
    const candidate = findAddableSaleUom(saleUoms, uoms, baseUomId)
    if (!candidate) { toast.error(isEn ? 'No more units available in this category' : '该计量类别下已没有可选的单位了'); return }
    const isDefault = baseUomId ? candidate === baseUomId : saleUoms.length === 0
    onChange([...saleUoms, makeDefaultSaleUomFormRow(candidate, isDefault)])
  }

  function removeRow(index: number) {
    onChange(removeSaleUomFormRow(saleUoms, index, baseUomId))
  }

  return (
    <div className="max-w-3xl space-y-2">
      {saleUoms.map((row, i) => {
        const isBase = isBaseSaleUomRow(row, baseUomId)
        // 非基础行的下拉里不能选基准单位本身——选了会因为 isBaseSaleUomRow 判断变成新的
        // 「基础行」，把当前这行的换算/价格配置全部作废。基础行本身的下拉锁死不可改
        // （唯一入口是商品页头「Unit of Measure」），但选项列表必须包含它自己的值，
        // 否则 <select> 找不到匹配项会显示空白。
        const options = isBase ? uoms : (baseUomId ? uoms.filter(u => u.id !== baseUomId) : uoms)
        // 具体数量有两种真实场景，同一个数字含义相反，必须让用户自己选×/÷，不能瞎猜：
        // 整箱/大包装(case of 10 packets)是"放大" → factor=数量本身；
        // 半份/拆零(拆成 1/10)是"缩小" → factor=1/数量，更常见，默认就是这个方向。
        // factor<=1 时按"缩小"展示(含新行默认的 factor=1，边界给÷不给×)，这样刷新页面
        // 读旧数据也能还原出正确的×/÷，不用额外存一个 mode 字段。
        const rowFactor = isBase ? 1 : (row.factor ?? 1)
        const isDivideMode = rowFactor > 0 && rowFactor <= 1
        const displayQty = isDivideMode ? Math.round((1 / rowFactor) * 1e6) / 1e6 : rowFactor
        // "基准 × 系数"这一步的结果，与折扣/加价无关——借道 FORMULA(折扣/加减都是 0) 拿到这个干净的数，
        // 公式行要展示"从这个数出发再调整"，不能直接用 finalPrice(已经算完调整)。
        const stepPrice = priceOf([{ ...row, priceMode: 'FORMULA', priceDiscountPct: 0, priceSurcharge: 0 }], row.uomId, baseListPrice)
        const finalPrice = priceOf([row], row.uomId, baseListPrice)
        // 提成价照抄价格机制(20260901)：同样借道 FORMULA(折扣/加价都是 0) 拿到
        // "基础提成价 × factor"这个干净的数，公式行从这个数出发再调整。
        const stepCommission = commissionPriceOf([{ ...row, commissionPriceMode: 'FORMULA', commissionDiscountPct: 0, commissionSurcharge: 0 }], row.uomId, baseCommissionPrice)
        const finalCommission = commissionPriceOf([row], row.uomId, baseCommissionPrice)
        return (
          <div key={i}>
            <div className="flex items-center gap-2">
              <select
                value={row.uomId}
                onChange={e => {
                  const nextUomId = e.target.value
                  // 换成基准单位的那一行系数要归 1 —— 否则携带着换基准单位前的旧系数去保存会被后端拦下
                  const nextIsBase = baseUomId ? nextUomId === baseUomId : row.isDefault
                  updateRow(i, { uomId: nextUomId, factor: nextIsBase ? 1 : row.factor })
                }}
                disabled={!editMode || isBase}
                title={isBase ? (isEn ? 'Change the base unit from "Unit of Measure" above' : '基准单位只能在上面「Unit of Measure」改') : undefined}
                className={fieldClass}
                style={{ ...focusStyle, maxWidth: 180 }}
              >
                {options.map(u => <option key={u.id} value={u.id}>{isEn ? (u.name || u.nameZh) : (u.nameZh ?? u.name)}</option>)}
              </select>
              {isBase ? (
                <span className="px-2 py-1 text-xs rounded font-medium whitespace-nowrap" style={{ background: '#f3e8f5', color: '#875A7B' }}>
                  {isEn ? 'Base' : '基础'}
                </span>
              ) : (
                <span className="w-0" />
              )}
              {/* 具体数量：纯数字，不带方向——方向(×/÷)由后面「= base」那个开关决定。
                  基础单位恒为 1 且不可改 —— 它是库存的计数尺子。 */}
              <NumericInput
                step="0.000001" min={0}
                value={isBase ? 1 : displayQty}
                onChange={e => {
                  const n = e.target.value === '' ? 1 : Number(e.target.value)
                  const nextFactor = isDivideMode ? (n > 0 ? 1 / n : 1) : n
                  updateRow(i, { factor: nextFactor })
                }}
                disabled={!editMode || isBase}
                title={isEn
                  ? 'How many — pick × or ÷ on the right for the direction'
                  : '具体数量——方向(×放大/÷缩小)用右边的开关选'}
                className="h-8 px-2 border border-gray-300 rounded text-sm text-center outline-none disabled:bg-gray-50 disabled:text-gray-400"
                style={{ width: 90 }}
              />
              {/* 跟基础单位的关系：= base [×/÷开关] 数量。开关点一下就在放大/缩小间切换，
                  默认缩小(÷)更常见(拆零比整箱常见)；符号字号调大，纯展示+开关，不带计算器。 */}
              {isBase ? (
                <span className="w-0" />
              ) : (
                <div className="flex items-center gap-1.5 h-8 px-2 border border-gray-300 rounded text-xs bg-gray-50 whitespace-nowrap">
                  <span className="text-gray-500">{isEn ? '= base' : '= 基础'}</span>
                  <button
                    type="button"
                    disabled={!editMode}
                    onClick={() => {
                      const nextFactor = isDivideMode ? displayQty : (displayQty > 0 ? 1 / displayQty : 1)
                      updateRow(i, { factor: nextFactor })
                    }}
                    title={isEn ? 'Toggle between "× multiply base" and "÷ split base"' : '在"×放大 base"和"÷拆分 base"之间切换'}
                    className="text-base leading-none font-bold px-0.5 disabled:cursor-not-allowed"
                    style={{ color: '#875A7B' }}
                  >
                    {isDivideMode ? '÷' : '×'}
                  </button>
                  <span className="font-medium" style={{ color: '#875A7B' }}>{displayQty}</span>
                </div>
              )}
              {/* 价格：基础行价格恒等于 Sales Price，不再单独可编辑；其余行公式直接摊平在行内，
                  不用再点开才看到——price = base price + 一个百分比(可负=加价) + 一个绝对值(可负) */}
              {isBase ? (
                <div className="flex items-center h-8 px-2 text-sm text-gray-500 whitespace-nowrap">
                  €{baseListPrice.toFixed(2)}
                </div>
              ) : editMode ? (
                <div className="flex items-center gap-1 border border-gray-300 rounded h-8 px-2 bg-white text-xs whitespace-nowrap">
                  <span className="text-gray-400">€{stepPrice.toFixed(2)} +</span>
                  <NumericInput
                    step="0.01"
                    value={row.priceDiscountPct ?? 0}
                    onChange={e => updateRow(i, { priceMode: 'FORMULA', priceDiscountPct: e.target.value === '' ? 0 : Number(e.target.value) })}
                    title={isEn ? 'Percentage adjustment, negative = discount' : '百分比调整，填负数就是打折'}
                    className="w-14 h-6 px-1 border border-gray-200 rounded text-xs no-spinner"
                  />
                  <span className="text-gray-400">% +</span>
                  <NumericInput
                    step="0.01"
                    value={row.priceSurcharge ?? 0}
                    onChange={e => updateRow(i, { priceMode: 'FORMULA', priceSurcharge: e.target.value === '' ? 0 : Number(e.target.value) })}
                    title={isEn ? 'Flat amount, can be negative' : '绝对值，可以是负数'}
                    className="w-16 h-6 px-1 border border-gray-200 rounded text-xs no-spinner"
                  />
                  <span className="text-gray-400">=</span>
                  <span className="font-medium" style={{ color: '#875A7B' }}>€{finalPrice.toFixed(2)}</span>
                </div>
              ) : (
                <div className="flex items-center h-8 px-2 text-sm text-gray-500 whitespace-nowrap">
                  €{finalPrice.toFixed(2)}
                </div>
              )}
              {editMode && (
                <button
                  type="button"
                  onClick={() => updateRow(i, { active: !row.active })}
                  role="switch"
                  aria-checked={row.active}
                  title={isBase
                    ? (isEn
                      ? (row.active ? 'Click to disable selling in the base unit itself — the product can still be ordered in the other units configured below' : 'Click to enable')
                      : (row.active ? '点击停用「按基础单位本身售卖」——其余已配置的单位不受影响，仍可下单' : '点击启用'))
                    : (isEn
                      ? (row.active ? 'Click to disable — hidden when placing orders/quotations; factor & price relationships still apply if re-enabled' : 'Click to enable')
                      : (row.active ? '点击停用 —— 下单/报价时不再出现；换算与价格关系仍保留，重新启用即可用' : '点击启用'))}
                  className="h-8 px-2 flex items-center gap-1.5 text-xs rounded border border-gray-300 bg-white transition-colors whitespace-nowrap"
                >
                  <span className={row.active ? 'text-gray-700' : 'text-gray-400'}>{isEn ? 'Sellable' : '可下单'}</span>
                  <span className="relative inline-block w-7 h-3.5 rounded-full transition-colors" style={{ background: row.active ? '#875A7B' : '#d1d5db' }}>
                    <span className="absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-transform" style={{ left: row.active ? '15px' : '2px' }} />
                  </span>
                </button>
              )}
              {!editMode && !row.active && (
                <span className="px-2 py-1 text-xs rounded bg-gray-100 text-gray-400 whitespace-nowrap">{isEn ? 'Disabled' : '已停用'}</span>
              )}
              {editMode && !isBase && (
                <button onClick={() => removeRow(i)} className="text-gray-400 hover:text-red-500 text-sm px-1">✕</button>
              )}
            </div>
            {/* 提成公式：跟价格那行同一套摊平写法，只在配了基础提成价的商品上出现——
                没配提成的商品没必要在每个可售单位下都摆一行用不上的"提成"输入。 */}
            {!isBase && baseCommissionPrice != null && (
              <div className="flex items-center gap-2 mt-1 pl-1">
                <span className="text-xs text-gray-400 whitespace-nowrap" style={{ width: 180 }}>
                  {isEn ? 'Commission' : '提成'}
                </span>
                {editMode ? (
                  <div className="flex items-center gap-1 border border-gray-200 rounded h-7 px-2 bg-white text-xs whitespace-nowrap">
                    <span className="text-gray-400">€{(stepCommission ?? 0).toFixed(2)} +</span>
                    <NumericInput
                      step="0.01"
                      value={row.commissionDiscountPct ?? 0}
                      onChange={e => updateRow(i, { commissionPriceMode: 'FORMULA', commissionDiscountPct: e.target.value === '' ? 0 : Number(e.target.value) })}
                      title={isEn ? 'Percentage adjustment, negative = discount' : '百分比调整，填负数就是打折'}
                      className="w-14 h-6 px-1 border border-gray-200 rounded text-xs no-spinner"
                    />
                    <span className="text-gray-400">% +</span>
                    <NumericInput
                      step="0.01"
                      value={row.commissionSurcharge ?? 0}
                      onChange={e => updateRow(i, { commissionPriceMode: 'FORMULA', commissionSurcharge: e.target.value === '' ? 0 : Number(e.target.value) })}
                      title={isEn ? 'Flat amount, can be negative' : '绝对值，可以是负数'}
                      className="w-16 h-6 px-1 border border-gray-200 rounded text-xs no-spinner"
                    />
                    <span className="text-gray-400">=</span>
                    <span className="font-medium" style={{ color: '#00A09D' }}>€{(finalCommission ?? 0).toFixed(2)}</span>
                  </div>
                ) : (
                  <div className="flex items-center h-7 px-2 text-xs text-gray-500 whitespace-nowrap">
                    €{(finalCommission ?? 0).toFixed(2)}
                  </div>
                )}
              </div>
            )}
            {/* 产品规格(20260905)：按这个单位卖，客户实际拿到什么规格——每一行(含基础单位)独立填一条，
                写入订单行后会出现在交货单/销售单/拣货单/司机回单/发票打印模版上(见 lib/order-line-description.ts)。 */}
            <div className="flex items-center gap-2 mt-1 pl-1">
              <span className="text-xs text-gray-400 whitespace-nowrap" style={{ width: 180 }}>
                {isEn ? 'Product Spec' : '产品规格'}
              </span>
              {editMode ? (
                <input
                  type="text"
                  value={row.spec ?? ''}
                  onChange={e => updateRow(i, { spec: e.target.value })}
                  placeholder={isEn ? 'e.g. 500g/packet' : '如：500g/包'}
                  className="h-7 px-2 border border-gray-200 rounded text-xs outline-none flex-1 max-w-xs"
                  style={focusStyle}
                />
              ) : (
                <span className="text-xs text-gray-500">{row.spec || '—'}</span>
              )}
            </div>
            {/* 装货顺序(20260907)：仓库配货/司机卸货堆叠顺序——数字越小越先装/放最下（重、
                耐压），越大越后装/放最上（怕压）；每一行(含基础单位)独立设置，不继承别的单位。
                语义跟商品页头的 Product Sequence 一致，但那个排的是单据里第几行，这个排的是
                物理堆叠顺序，两者互不影响。留空＝没设置，排序时按"没有 sequence"处理排最后。 */}
            <div className="flex items-center gap-2 mt-1 pl-1">
              <span className="text-xs text-gray-400 whitespace-nowrap" style={{ width: 180 }}>
                {isEn ? 'Pack Sequence' : '装货顺序'}
              </span>
              {editMode ? (
                <NumericInput
                  step="1"
                  value={row.sequence ?? ''}
                  onChange={e => updateRow(i, { sequence: e.target.value === '' ? null : parseInt(e.target.value) || 0 })}
                  placeholder={isEn ? 'smaller = load first / bottom' : '数字越小越先装/放最下'}
                  title={isEn ? 'Smaller = load first / bottom (heavy); larger = load last / top (fragile)' : '数字越小越先装/放最下（重）；越大越后装/放最上（怕压）'}
                  className="h-7 px-2 border border-gray-200 rounded text-xs outline-none no-spinner"
                  style={{ ...focusStyle, width: 90 }}
                />
              ) : (
                <span className="text-xs text-gray-500">{row.sequence ?? '—'}</span>
              )}
            </div>
            {/* 毛重(20260911)：该可售单位自己的毛重(kg)，如"1箱=3.2kg"——每一行(含基础单位)
                独立填写，跟商品页头 Unit of Measure 那个"毛重 Gross Weight"(Product.weight，
                基础单位层级)是两个独立字段。填了会折进交货单/销售单/拣货单/司机回单的
                规格说明文字里(见 lib/print/uom-conversion.ts)。 */}
            <div className="flex items-center gap-2 mt-1 pl-1">
              <span className="text-xs text-gray-400 whitespace-nowrap" style={{ width: 180 }}>
                {isEn ? 'Gross Weight (kg)' : '毛重 Gross Weight (kg)'}
              </span>
              {editMode ? (
                <NumericInput
                  step="0.01"
                  value={row.grossWeight ?? ''}
                  onChange={e => updateRow(i, { grossWeight: e.target.value === '' ? null : Number(e.target.value) })}
                  placeholder={isEn ? 'e.g. 3.2' : '如：3.2'}
                  className="h-7 px-2 border border-gray-200 rounded text-xs outline-none no-spinner"
                  style={{ ...focusStyle, width: 90 }}
                />
              ) : (
                <span className="text-xs text-gray-500">{row.grossWeight ?? '—'}</span>
              )}
            </div>
          </div>
        )
      })}
      {saleUoms.filter(r => !isBaseSaleUomRow(r, baseUomId)).length === 0 && (
        <p className="text-xs text-gray-300">{isEn ? 'No additional sellable units configured yet.' : '尚未配置额外可售单位。'}</p>
      )}
      {editMode && (
        <div className="flex items-center gap-2 pt-1">
          <button onClick={addRow} className={btnBase}>{isEn ? '+ Add Unit' : '＋ 添加单位'}</button>
          {onSave ? (
            <button
              onClick={onSave}
              disabled={saving}
              className="h-8 px-4 text-sm font-medium text-white rounded transition-colors disabled:opacity-50"
              style={{ background: '#875A7B' }}
            >
              {saving ? (isEn ? 'Saving...' : '保存中...') : (isEn ? 'Save Sellable Units' : '保存可售单位')}
            </button>
          ) : showCreateHint ? (
            <span className="text-xs text-gray-400">
              {isEn ? 'Saved together with the product below' : '随下方"保存"按钮一起创建'}
            </span>
          ) : null}
        </div>
      )}
    </div>
  )
}
