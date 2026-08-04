import { config } from 'dotenv'
import { createPrismaClient } from '@/lib/prisma-factory'
config({ path: '.env.local' })

const prisma = createPrismaClient()

const NOISE = new Set([
  'case','pkt','bag','drum','bottle','tray','pack','tube','tin','pouch','jar',
  'bucket','can','carton','pail','bulk','loose','box','roll','punnet','sachet',
  'packet','pcs','pc','doz','tub','ctn','bott',
  'kg','g','ml','l','lb','oz','liter','litre',
  'large','small','medium','big','mini','super','premium','original','classic',
  'xl','xxl','plus','extra','hi','hd',
])
const BRAND_PREFIX = /^(aji|has|dgf|lkk|ljk|yy|ww|pc|lp|gl|jc|ksf|jsb|ml|gs|jp|kr|tw|cn|uk|au|nz|fsg|wzh|mf|ds|dsd|mg|bs|cj|wp|st|fx|go|tt|hk|ry|jb|bn|cp|sv|ma|el|gp|vl|nt|mc|sa)\s+/i

function extractKeyword(raw: string): string {
  let s = raw
  s = s.replace(/\d+\s*\*\s*[\(\d][^\s,]*/g, ' ')
  s = s.replace(/\d+[\.\d]*\s*(kg|g|ml|l|lb|oz|doz|pcs?)\b/gi, ' ')
  s = s.replace(/\d+'s\b/gi, ' ')
  s = s.replace(/\([^)]*\)/g, ' ')
  s = s.replace(/\[[^\]]*\]/g, ' ')
  s = s.replace(/\*/g, ' ')
  const words = s.split(/\s+/).filter(w => w.length > 0)
  const filtered = words.filter(w => !NOISE.has(w.toLowerCase()))
  s = filtered.join(' ')
  s = s.replace(BRAND_PREFIX, '')
  s = s.replace(/\s+/g, ' ').trim()
  const finalWords = s.split(' ').filter(w => w.length > 1)
  return finalWords.slice(0, 3).join(' ').toLowerCase()
}

async function main() {
  const templates = await prisma.productTemplate.findMany({
    select: { name: true },
    orderBy: { name: 'asc' },
  })
  // Show 30 random samples across categories
  const samples = templates.filter((_, i) => i % 55 === 0).slice(0, 30)
  for (const t of samples) {
    const kw = extractKeyword(t.name)
    console.log(`  "${t.name}"`)
    console.log(`    → "${kw}"`)
  }
  const allKws = new Set(templates.map(t => extractKeyword(t.name)))
  console.log(`\n总商品: ${templates.length}，唯一关键词: ${allKws.size}`)
  await prisma.$disconnect()
}
main()
