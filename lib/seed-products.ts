/**
 * seed-products.ts — static category/attribute seed data only.
 * CSV loading is in prisma/csv-loader.ts (server-only, never bundled client-side).
 */
import type { ProductCategory, ProductAttribute } from './types'

// ─── Static: product categories ───────────────────────────────────────────────
export const SEED_CATEGORIES: ProductCategory[] = [
  { id: 'cat_00', externalId: 'product.product_category_all',               name: 'Uncategorized',    nameZh: '未分类' },
  { id: 'cat_07', externalId: '__export__.product_category_7_73c29576',     name: 'Other/Cleaning',   nameZh: '其他/清洁' },
  { id: 'cat_30', externalId: '__export__.product_category_30_d576cd98',    name: 'Drinks',           nameZh: '饮料/饮品' },
  { id: 'cat_31', externalId: '__export__.product_category_31_38e5639a',    name: 'Fruit',            nameZh: '水果' },
  { id: 'cat_32', externalId: '__export__.product_category_32_9a46412f',    name: 'Chinese Veg',      nameZh: '中式蔬菜/菌菇' },
  { id: 'cat_33', externalId: '__export__.product_category_33_b9951bef',    name: 'Canned/Preserved', nameZh: '干货/罐头/面粉' },
  { id: 'cat_34', externalId: '__export__.product_category_34_e026bd64',    name: 'Eggs',             nameZh: '鸡蛋' },
  { id: 'cat_35', externalId: '__export__.product_category_35_305bb5c8',    name: 'Packaging',        nameZh: '包装材料' },
  { id: 'cat_36', externalId: '__export__.product_category_36_afc2e9d2',    name: 'Frozen/Ready Made',nameZh: '冷冻/半成品' },
  { id: 'cat_37', externalId: '__export__.product_category_37_d297ad2f',    name: 'Fruit Extra',      nameZh: '水果-2' },
  { id: 'cat_38', externalId: '__export__.product_category_38_51b3b8c5',    name: 'Sauces/Preserved', nameZh: '酱料/腌制品' },
  { id: 'cat_40', externalId: '__export__.product_category_40_1330f19e',    name: 'Herbs',            nameZh: '香草香料' },
  { id: 'cat_41', externalId: '__export__.product_category_41_befa4763',    name: 'Noodles/Ramen',    nameZh: '面条/方便面' },
  { id: 'cat_42', externalId: '__export__.product_category_42_d92495a0',    name: 'Asian Grocery',    nameZh: '日亚调味杂货' },
  { id: 'cat_44', externalId: '__export__.product_category_44_f52d7be3',    name: 'Noodles/Starch',   nameZh: '粉条/淀粉' },
  { id: 'cat_45', externalId: '__export__.product_category_45_d16e7c82',    name: 'Pre-processed Veg',nameZh: '加工蔬菜' },
  { id: 'cat_46', externalId: '__export__.product_category_46_855f91a0',    name: 'Sauces',           nameZh: '酱料' },
  { id: 'cat_47', externalId: '__export__.product_category_47_43b3d072',    name: 'Snacks',           nameZh: '零食' },
  { id: 'cat_48', externalId: '__export__.product_category_48_337822bb',    name: 'Spices',           nameZh: '调味品/香料' },
  { id: 'cat_49', externalId: '__export__.product_category_49_6134fdba',    name: 'Miscellaneous',    nameZh: '杂货/日用' },
  { id: 'cat_50', externalId: '__export__.product_category_50_2df85616',    name: 'Tofu/Soy',         nameZh: '豆腐/豆制品' },
  { id: 'cat_51', externalId: '__export__.product_category_51_4991501f',    name: 'Vegetables',       nameZh: '蔬菜' },
  { id: 'cat_58', externalId: '__export__.product_category_58_18fa0da0',    name: 'Kitchen Supplies', nameZh: '寿司/厨房耗材' },
  { id: 'cat_62', externalId: '__export__.product_category_62_dffec157',    name: 'Korean Products',  nameZh: '韩国商品' },
  { id: 'cat_63', externalId: '__export__.product_category_63_da680075',    name: 'Meat/Seafood',     nameZh: '肉类/海鲜' },
  { id: 'cat_65', externalId: '__export__.product_category_65_7f7f201d',    name: 'Rice',             nameZh: '大米' },
  { id: 'cat_66', externalId: '__export__.product_category_66_ea10b918',    name: 'Pastry/Dim Sum',   nameZh: '面点/饺子皮' },
]

// ─── Static: product attributes (none in this dataset) ───────────────────────
export const SEED_PRODUCT_ATTRIBUTES: ProductAttribute[] = []

// ─── Legacy compat ────────────────────────────────────────────────────────────
export const SEED_PRODUCT_TEMPLATES: never[] = []
export const SEED_PRODUCTS:          never[] = []
