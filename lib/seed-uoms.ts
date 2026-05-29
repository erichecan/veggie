/**
 * 标准 UoM 种子数据
 * ============================================================================
 * 覆盖 B2B 生鲜批发常用的 4 个 Category：
 *   Unit  → 计数单位（PCS / DOZEN / CASE / BOX / BAG / TRAY / HALF CASE）
 *   Weight→ 重量（kg 参考 / g / 100g / lb / 5kg BAG / 10kg BAG）
 *   Volume→ 体积（L 参考 / ml / 100ml）
 *   Time  → 时间（Day 参考 / Hour / Week）
 *
 * factor 语义：qty_in_reference_uom = qty_in_this_uom * factor
 */

export interface SeedUom {
  id: string
  name: string
  nameZh?: string
  type: 'REFERENCE' | 'SMALLER' | 'BIGGER'
  factor: number
  rounding: number
}

export interface SeedUomCategory {
  id: string
  name: string
  nameZh?: string
  uoms: SeedUom[]
}

export const SEED_UOM_CATEGORIES: SeedUomCategory[] = [
  {
    id: 'uom_cat_unit',
    name: 'Unit',
    nameZh: '计件',
    uoms: [
      { id: 'uom_pcs',      name: 'PCS',       nameZh: '件',    type: 'REFERENCE', factor: 1,    rounding: 1 },
      { id: 'uom_dozen',    name: 'DOZEN',     nameZh: '打 (12)', type: 'BIGGER',  factor: 12,   rounding: 1 },
      { id: 'uom_half',     name: 'HALF CASE', nameZh: '半箱',  type: 'BIGGER',    factor: 6,    rounding: 1 },
      { id: 'uom_case',     name: 'CASE',      nameZh: '箱 (12)', type: 'BIGGER',  factor: 12,   rounding: 1 },
      { id: 'uom_box',      name: 'BOX',       nameZh: '盒',    type: 'REFERENCE', factor: 1,    rounding: 1 }, // 与 PCS 等价，单独算独立单位
      { id: 'uom_bag',      name: 'BAG',       nameZh: '袋',    type: 'REFERENCE', factor: 1,    rounding: 1 },
      { id: 'uom_tray',     name: 'TRAY',      nameZh: '盘',    type: 'REFERENCE', factor: 1,    rounding: 1 },
    ],
  },
  {
    id: 'uom_cat_weight',
    name: 'Weight',
    nameZh: '重量',
    uoms: [
      { id: 'uom_kg',       name: 'kg',        nameZh: '千克',  type: 'REFERENCE', factor: 1,       rounding: 0.001 },
      { id: 'uom_g',        name: 'g',         nameZh: '克',    type: 'SMALLER',   factor: 0.001,   rounding: 1 },
      { id: 'uom_100g',     name: '100g',      nameZh: '100克', type: 'SMALLER',   factor: 0.1,     rounding: 1 },
      { id: 'uom_lb',       name: 'lb',        nameZh: '磅',    type: 'SMALLER',   factor: 0.4536,  rounding: 0.01 },
      { id: 'uom_5kg_bag',  name: '5kg BAG',   nameZh: '5公斤袋', type: 'BIGGER',  factor: 5,       rounding: 1 },
      { id: 'uom_10kg_bag', name: '10kg BAG',  nameZh: '10公斤袋', type: 'BIGGER', factor: 10,      rounding: 1 },
      { id: 'uom_25kg',     name: '25kg',      nameZh: '25公斤', type: 'BIGGER',   factor: 25,      rounding: 1 },
    ],
  },
  {
    id: 'uom_cat_volume',
    name: 'Volume',
    nameZh: '体积',
    uoms: [
      { id: 'uom_l',        name: 'L',         nameZh: '升',    type: 'REFERENCE', factor: 1,       rounding: 0.01 },
      { id: 'uom_ml',       name: 'ml',        nameZh: '毫升',  type: 'SMALLER',   factor: 0.001,   rounding: 1 },
      { id: 'uom_100ml',    name: '100ml',     nameZh: '100毫升', type: 'SMALLER', factor: 0.1,     rounding: 1 },
      { id: 'uom_10l_drum', name: '10L DRUM',  nameZh: '10升桶', type: 'BIGGER',   factor: 10,      rounding: 1 },
      { id: 'uom_20l',      name: '20L',       nameZh: '20升',  type: 'BIGGER',   factor: 20,      rounding: 1 },
    ],
  },
  {
    id: 'uom_cat_time',
    name: 'Time',
    nameZh: '时间',
    uoms: [
      { id: 'uom_day',      name: 'Day',       nameZh: '天',    type: 'REFERENCE', factor: 1,       rounding: 0.5 },
      { id: 'uom_hour',     name: 'Hour',      nameZh: '小时',  type: 'SMALLER',   factor: 0.0417,  rounding: 0.5 },
      { id: 'uom_week',     name: 'Week',      nameZh: '周',    type: 'BIGGER',    factor: 7,       rounding: 1 },
    ],
  },
]
