/**
 * 按商品名精准搜索 Pexels 图片
 *
 * 策略：
 *   1. 清洗商品名 → 提取 1-2 词核心食材关键词
 *   2. 去重后按覆盖商品数排序，取前 200（符合 Pexels 200 req/hour 免费限额）
 *   3. 对每个关键词搜一张图，批量写入该关键词的所有商品
 *   4. 剩余商品用品类兜底图覆盖
 *
 * 运行：node_modules/.bin/tsx scripts/fetch-product-images.ts
 */

import { config } from 'dotenv'
import { createPrismaClient } from '@/lib/prisma-factory'
config({ path: '.env.local' })


const prisma = createPrismaClient()

// --resume: 跳过清空步骤，只处理没有图片的商品（用于第二次及后续运行）
const RESUME_MODE = process.argv.includes('--resume')

const PEXELS_KEY = process.env.PEXELS_API_KEY!
const MAX_API_CALLS = 200

// ── 噪音词典 ──────────────────────────────────────────────────────────────────

// 包装 / 单位
const PACKAGING = new Set([
  'case','pkt','bag','drum','bottle','tray','pack','tube','tin','pouch','jar',
  'bucket','can','carton','pail','bulk','loose','box','roll','punnet','sachet',
  'packet','pcs','pc','doz','tub','ctn','bott','piece','pieces','litre','liter',
  'kg','g','ml','l','lb','oz','doz',
])

// 形容词 / 描述词（不影响图片搜索的词）
const DESCRIPTORS = new Set([
  'fresh','frozen','dried','whole','sliced','diced','chopped','shredded',
  'peeled','boneless','skinless','ground','crushed','cooked','boiled','fried',
  'seasoned','salted','sweet','spicy','hot','mild','cold','raw','smoked','cured',
  'large','small','big','mini','baby','medium','super','premium','original',
  'classic','authentic','natural','pure','wild','organic','black','white','red',
  'green','yellow','golden','brown','purple','pink','blue','mixed','double',
  'plain','fancy','crispy','crunchy','soft','thin','thick','long','short',
  'iqf','pd','p&d','hi','hd','mp','md',
])

// 已知品牌前缀（全部小写匹配）
const BRANDS = new Set([
  'aji','has','dgf','lkk','ljk','yy','ww','pc','lp','gl','jc','ksf','jsb',
  'ml','gs','fsg','wzh','mf','ds','dsd','mg','bs','cj','wp','st','fx','go',
  'tt','hk','ry','jb','bn','cp','sv','ma','el','gp','vl','nt','mc','sa',
  'll','nbh','tym','ksf','ben','hbs','hhb','gom','cjw','wang','hao',
  'nongshim','ottogi','sempio','haepyo','samyang','jongga','wanderfort',
  'pataks','bulldog','hinode','fortune','heera','triton','satco','cock',
  'knorr','ariaka','unicurd','majestic','deepio', 'wheatsun',
])

// ── 关键词提取 ────────────────────────────────────────────────────────────────

function extractKeyword(raw: string): string {
  let s = raw

  // 去掉中文字符
  s = s.replace(/[\u4e00-\u9fff（）【】]/g, ' ')

  // 去掉 N*(Mg) 形式的数量×重量：10*600g、12*(4*150g)
  s = s.replace(/\d+\s*\*\s*[\(\d][^\s,]*/g, ' ')

  // 去掉分数规格：21/25、26/30
  s = s.replace(/\d+\/\d+/g, ' ')

  // 去掉 数字+单位：10kg、500g、2L、480ml
  s = s.replace(/\d+[\.\d]*\s*(kg|g|ml|l|lb|oz|doz|pcs?|packs?|x)\b/gi, ' ')

  // 去掉 "数字's"：30's、6's
  s = s.replace(/\d+'?s\b/gi, ' ')

  // 去掉括号内容
  s = s.replace(/\([^)]*\)/g, ' ')
  s = s.replace(/\[[^\]]*\]/g, ' ')

  // 去掉星号、斜杠等
  s = s.replace(/[\*\/\\&+]/g, ' ')

  // 分词
  const words = s.split(/[\s,.\-_]+/).filter(w => w.length > 0)

  // 过滤噪音词
  const kept: string[] = []
  for (const w of words) {
    const lower = w.toLowerCase().replace(/[^a-z]/g, '')
    if (!lower || lower.length < 2) continue
    if (PACKAGING.has(lower)) continue
    if (DESCRIPTORS.has(lower)) continue
    if (BRANDS.has(lower)) continue
    // 纯数字或只含数字的词跳过
    if (/^\d+$/.test(w)) continue
    // 全大写且长度 ≤ 4 的词通常是代码（IQF, PKT, PD...）跳过
    if (/^[A-Z]{1,4}$/.test(w)) continue
    kept.push(w)
  }

  // 取前 2 个词作为搜索关键词
  return kept.slice(0, 2).join(' ').toLowerCase()
}

// ── Pexels 搜索 ──────────────────────────────────────────────────────────────

interface PexelsPhoto { src: { medium: string } }

async function searchPexels(keyword: string): Promise<string | null> {
  const query = `${keyword} food ingredient`
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=5&orientation=square`
  try {
    const res = await fetch(url, { headers: { Authorization: PEXELS_KEY } })
    if (!res.ok) { console.error(`  Pexels ${res.status}`); return null }
    const data = await res.json() as { photos: PexelsPhoto[] }
    return data.photos?.[0]?.src?.medium ?? null
  } catch (e) {
    console.error(`  fetch error:`, (e as Error).message)
    return null
  }
}

// 品类兜底图关键词
const CAT_FALLBACK_QUERY: Record<string, string> = {
  cat_47: 'snacks food',       cat_48: 'spices seasoning',
  cat_49: 'food ingredients',  cat_50: 'tofu soy',
  cat_51: 'fresh vegetables',  cat_58: 'takeaway containers',
  cat_62: 'korean food',       cat_63: 'meat seafood',
  cat_65: 'rice grains',       cat_66: 'dim sum dumplings',
  cat_00: 'food wholesale',    cat_07: 'cleaning supplies',
  cat_30: 'drinks beverages',  cat_31: 'fresh fruit',
  cat_32: 'asian vegetables',  cat_33: 'canned food',
  cat_34: 'eggs',              cat_35: 'food packaging',
  cat_36: 'frozen food',       cat_37: 'tropical fruit',
  cat_38: 'pickled sauces',    cat_40: 'fresh herbs',
  cat_41: 'noodles ramen',     cat_42: 'asian grocery',
  cat_44: 'rice noodles',      cat_45: 'fresh vegetables',
  cat_46: 'cooking sauce',
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`🥦  精准图片匹配 v2${RESUME_MODE ? ' [续跑模式]' : ''}\n`)
  if (!PEXELS_KEY) { console.error('❌ 缺少 PEXELS_API_KEY'); process.exit(1) }

  // Step 0：清空旧图片（续跑模式跳过）
  if (!RESUME_MODE) {
    process.stdout.write('Step 0: 清空旧图片... ')
    await prisma.product.updateMany({ data: { images: [] } })
    console.log('✅\n')
  } else {
    console.log('Step 0: 续跑模式，跳过清空\n')
  }

  // Step 1：读取商品（续跑模式只取没有图片的商品）
  const templates = await prisma.product.findMany({
    where: RESUME_MODE ? { images: { equals: [] } } : undefined,
    select: { id: true, name: true, categoryId: true },
  })
  console.log(`Step 1: ${RESUME_MODE ? '待补图' : '共'} ${templates.length} 个商品\n`)

  // Step 2：提取关键词并按覆盖商品数排序
  const kwMap = new Map<string, string[]>() // keyword → [templateId]
  const catMap = new Map<string, string[]>() // categoryId → [templateId without keyword]

  for (const t of templates) {
    const kw = extractKeyword(t.name)
    if (kw && kw.length >= 3) {
      if (!kwMap.has(kw)) kwMap.set(kw, [])
      kwMap.get(kw)!.push(t.id)
    } else {
      // 无有效关键词 → 走品类兜底
      const cat = t.categoryId ?? 'cat_00'
      if (!catMap.has(cat)) catMap.set(cat, [])
      catMap.get(cat)!.push(t.id)
    }
  }

  // 按覆盖商品数降序排序，取前 MAX_API_CALLS 个
  const sortedKws = [...kwMap.entries()].sort((a, b) => b[1].length - a[1].length)
  const topKws = sortedKws.slice(0, MAX_API_CALLS)
  const remainingKws = sortedKws.slice(MAX_API_CALLS)

  // 剩余关键词的商品也走品类兜底
  for (const [, ids] of remainingKws) {
    for (const id of ids) {
      const t = templates.find(x => x.id === id)
      if (!t) continue
      const cat = t.categoryId ?? 'cat_00'
      if (!catMap.has(cat)) catMap.set(cat, [])
      catMap.get(cat)!.push(id)
    }
  }

  console.log(`Step 2: ${kwMap.size} 个唯一关键词`)
  console.log(`  → 精准搜索前 ${topKws.length} 个（覆盖 ${topKws.reduce((s, [,ids]) => s + ids.length, 0)} 个商品）`)
  console.log(`  → 品类兜底剩余 ${catMap.size} 个品类（${[...catMap.values()].reduce((s,ids)=>s+ids.length,0)} 个商品）\n`)

  let updatedCount = 0

  // Step 3：精准搜索前 200 个关键词
  console.log(`Step 3: 搜索前 ${topKws.length} 个关键词...\n`)

  for (let i = 0; i < topKws.length; i++) {
    const [kw, ids] = topKws[i]
    process.stdout.write(`[${i + 1}/${topKws.length}] "${kw}" (${ids.length}个) → `)

    const url = await searchPexels(kw)
    if (url) {
      // 批量写入
      const BATCH = 50
      for (let b = 0; b < ids.length; b += BATCH) {
        await prisma.product.updateMany({
          where: { id: { in: ids.slice(b, b + BATCH) } },
          data: { images: [url] },
        })
      }
      console.log(`✅`)
      updatedCount += ids.length
    } else {
      console.log(`❌ 未找到`)
      // 未找到的也走品类兜底
      for (const id of ids) {
        const t = templates.find(x => x.id === id)
        if (!t) continue
        const cat = t.categoryId ?? 'cat_00'
        if (!catMap.has(cat)) catMap.set(cat, [])
        catMap.get(cat)!.push(id)
      }
    }

    // 控制请求速率：200 req/hour → 每次 18s，这里给 1.5s 留余量
    if (i < topKws.length - 1) await sleep(1500)
  }

  // Step 4：品类兜底
  const catIds = [...catMap.keys()]
  console.log(`\nStep 4: 品类兜底（${catIds.length} 个品类）...\n`)

  const catImageCache: Record<string, string> = {}

  for (let i = 0; i < catIds.length; i++) {
    const cat = catIds[i]
    const ids = catMap.get(cat)!
    const query = CAT_FALLBACK_QUERY[cat] ?? 'food ingredient'

    process.stdout.write(`[${i + 1}/${catIds.length}] ${cat} "${query}" (${ids.length}个) → `)

    if (!catImageCache[cat]) {
      const url = await searchPexels(query)
      if (url) catImageCache[cat] = url
      if (i < catIds.length - 1) await sleep(1500)
    }

    const url = catImageCache[cat]
    if (url) {
      const BATCH = 50
      for (let b = 0; b < ids.length; b += BATCH) {
        await prisma.product.updateMany({
          where: { id: { in: ids.slice(b, b + BATCH) } },
          data: { images: [url] },
        })
      }
      console.log(`✅`)
      updatedCount += ids.length
    } else {
      console.log(`❌`)
    }
  }

  console.log('\n══════════════════════════════════════')
  console.log(`✅ 完成！共更新 ${updatedCount} / ${templates.length} 个商品`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
