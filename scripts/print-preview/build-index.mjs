/**
 * 打印模板预览页 · 总览页组装
 * ============================================================================
 * 把单据 HTML + templates-meta.json 的说明，拼成一个给客户评审用的页面。
 * 每张单据：左边说明（在哪里打印、谁用、已知问题），右边 iframe 原样显示那张纸。
 *
 * 用法：node scripts/print-preview/build-index.mjs <单据目录> <站点输出目录>
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = process.argv[2]
const OUT = process.argv[3]
if (!SRC || !OUT) throw new Error('用法：build-index.mjs <单据目录> <站点输出目录>')

mkdirSync(join(OUT, 'docs'), { recursive: true })
mkdirSync(join(OUT, 'vendor'), { recursive: true })

const meta = JSON.parse(readFileSync(join(HERE, 'templates-meta.json'), 'utf8'))

// 只搬 meta 里还引用着的单据。从清单里删掉的那些不能留在站点上——
// 它们同样含真实客户名和成交价，留着等于还挂在公网上。
const referenced = new Set()
for (const g of meta.groups) {
  for (const it of g.items) {
    referenced.add(it.file)
    for (const alt of Object.keys(it.alt || {})) referenced.add(alt)
  }
}
let copied = 0, skipped = 0
for (const f of readdirSync(SRC).filter(f => f.endsWith('.html'))) {
  if (!referenced.has(f)) { skipped += 1; continue }
  copyFileSync(join(SRC, f), join(OUT, 'docs', f))
  copied += 1
}
// 条码库：模板里写死引用 /vendor/JsBarcode.all.min.js，不带上的话单据上没有条码
const barcodeSrc = join(HERE, '../../public/vendor/JsBarcode.all.min.js')
if (existsSync(barcodeSrc)) copyFileSync(barcodeSrc, join(OUT, 'vendor', 'JsBarcode.all.min.js'))

// 整页抓取的那几张（发票实体）内联了 Next 的样式，样式里的 @font-face 仍指向
// /_next/static/media/*.woff2。这些字体跟着 assets/ 一起走，漏掉就只是字体回退，
// 但每次重建都会在控制台留下一串 404，容易被误认为页面坏了。
const assetsDir = join(HERE, 'assets')
if (existsSync(assetsDir)) cpSync(assetsDir, OUT, { recursive: true })

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const FLAG_TEXT = {
  'invoice-no': { cls: 'flag-action', text: '待改：单号标签 → Invoice No.' },
  'payment-dirty': { cls: 'flag-warn', text: '数据问题：PAYMENT 栏印出了 "password"' },
  broken: { cls: 'flag-bad', text: '当前打不开（报 500）' },
  'trip-dead': { cls: 'flag-warn', text: '数据源已停止更新' },
  'en-only': { cls: 'flag-info', text: '只有英文' },
  'zh-only': { cls: 'flag-info', text: '只有中文（刻意）' },
  rough: { cls: 'flag-warn', text: '排版未做打印适配' },
  duplicate: { cls: 'flag-warn', text: '与另一张单重复' },
}

let counter = 0
const navItems = []

function renderItem(item) {
  counter += 1
  const id = `doc-${counter}`
  navItems.push({ id, name: item.name, flags: item.flags || [] })
  const alts = Object.entries(item.alt || {})
  const flags = (item.flags || []).map(f => FLAG_TEXT[f]).filter(Boolean)

  return `
<section class="doc" id="${id}">
  <div class="doc-head">
    <div class="doc-title">
      <span class="doc-num">${counter}</span>
      <h3>${esc(item.name)}<span class="doc-en">${esc(item.en || '')}</span></h3>
    </div>
    ${flags.length ? `<div class="flags">${flags.map(f => `<span class="flag ${f.cls}">${esc(f.text)}</span>`).join('')}</div>` : ''}
  </div>
  <div class="doc-body">
    <aside class="doc-info">
      <dl>
        <dt>在哪里打印</dt><dd>${esc(item.where)}</dd>
        <dt>谁用这张纸</dt><dd>${esc(item.who || '—')}</dd>
        <dt>纸张</dt><dd>${esc(item.paper || '—')}</dd>
      </dl>
      ${item.note ? `<p class="note">${esc(item.note)}</p>` : ''}
      <div class="doc-links">
        <a class="btn" href="docs/${item.file}" target="_blank">在新窗口打开原件 ↗</a>
        ${alts.map(([f, label]) => `<a class="btn btn-ghost" href="docs/${f}" target="_blank">${esc(label)} ↗</a>`).join('')}
      </div>
    </aside>
    <div class="doc-frame">
      <iframe src="docs/${item.file}" loading="lazy" title="${esc(item.name)}"></iframe>
    </div>
  </div>
</section>`
}

const groupsHtml = meta.groups.map(g => `
<div class="group" id="group-${g.id}">
  <h2>${esc(g.title)}</h2>
  ${g.intro ? `<p class="group-intro">${esc(g.intro)}</p>` : ''}
  ${g.items.map(renderItem).join('')}
</div>`).join('')

const navHtml = navItems.map(n => `<a href="#${n.id}" class="${n.flags.includes('broken') ? 'nav-bad' : n.flags.length ? 'nav-warn' : ''}">${esc(n.name)}</a>`).join('')

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>打印单据总览 · Johnstone Bros</title>
<style>
  :root {
    --purple: #875A7B; --ink: #1f2937; --muted: #6b7280; --line: #e5e7eb;
    --bg: #f7f7f8; --card: #ffffff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", Helvetica, Arial, sans-serif;
  }
  header {
    background: var(--purple); color: #fff; padding: 28px 32px 24px;
  }
  header h1 { margin: 0 0 6px; font-size: 22px; font-weight: 600; }
  header p { margin: 0; opacity: .9; font-size: 14px; max-width: 900px; }
  .meta-bar {
    margin-top: 16px; display: flex; gap: 24px; flex-wrap: wrap;
    font-size: 13px; opacity: .92;
  }
  .meta-bar b { font-weight: 600; }

  .layout { display: flex; align-items: flex-start; }
  nav {
    position: sticky; top: 0; width: 240px; flex: 0 0 240px; max-height: 100vh;
    overflow-y: auto; padding: 20px 12px 40px; border-right: 1px solid var(--line);
    background: var(--card);
  }
  nav h5 { margin: 0 0 8px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
  nav a {
    display: block; padding: 6px 10px; color: var(--ink); text-decoration: none;
    font-size: 13px; border-radius: 4px;
  }
  nav a:hover { background: #f3f0f3; }
  nav a.nav-warn::after { content: "●"; color: #f59e0b; margin-left: 6px; font-size: 10px; }
  nav a.nav-bad::after { content: "●"; color: #dc2626; margin-left: 6px; font-size: 10px; }

  main { flex: 1; min-width: 0; padding: 24px 32px 80px; }
  .group { margin-bottom: 40px; }
  .group > h2 {
    font-size: 18px; margin: 32px 0 6px; padding-bottom: 8px;
    border-bottom: 2px solid var(--purple);
  }
  .group-intro { color: var(--muted); font-size: 14px; margin: 0 0 20px; max-width: 900px; }

  .doc {
    background: var(--card); border: 1px solid var(--line); border-radius: 8px;
    margin-bottom: 24px; overflow: hidden;
  }
  .doc-head {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 14px 18px; border-bottom: 1px solid var(--line); background: #fcfbfc;
    flex-wrap: wrap;
  }
  .doc-title { display: flex; align-items: center; gap: 12px; }
  .doc-num {
    width: 26px; height: 26px; border-radius: 50%; background: var(--purple); color: #fff;
    display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600;
    flex: 0 0 26px;
  }
  .doc-head h3 { margin: 0; font-size: 16px; font-weight: 600; }
  .doc-en { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 10px; letter-spacing: .04em; }

  .flags { display: flex; gap: 8px; flex-wrap: wrap; }
  .flag { font-size: 12px; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
  .flag-action { background: #ede9fe; color: #5b21b6; }
  .flag-warn { background: #fef3c7; color: #92400e; }
  .flag-bad { background: #fee2e2; color: #991b1b; }
  .flag-info { background: #e0f2fe; color: #075985; }

  .doc-body { display: flex; gap: 0; align-items: stretch; }
  .doc-info { flex: 0 0 330px; padding: 16px 18px; border-right: 1px solid var(--line); }
  .doc-info dl { margin: 0 0 12px; }
  .doc-info dt {
    font-size: 11px; color: var(--muted); text-transform: uppercase;
    letter-spacing: .05em; margin-top: 10px;
  }
  .doc-info dt:first-child { margin-top: 0; }
  .doc-info dd { margin: 3px 0 0; font-size: 13.5px; }
  .note {
    background: #fafafa; border-left: 3px solid var(--purple); padding: 10px 12px;
    font-size: 13px; color: #374151; margin: 12px 0; border-radius: 0 4px 4px 0;
  }
  .doc-links { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .btn {
    display: inline-block; padding: 6px 12px; background: var(--purple); color: #fff;
    text-decoration: none; border-radius: 4px; font-size: 12.5px;
  }
  .btn-ghost { background: #fff; color: var(--purple); border: 1px solid var(--purple); }

  .doc-frame { flex: 1; min-width: 0; background: #eceaec; padding: 12px; }
  .doc-frame iframe {
    width: 100%; height: 720px; border: 1px solid #d6d3d6; background: #fff;
    border-radius: 3px; display: block;
  }

  @media (max-width: 1100px) {
    .layout { flex-direction: column; }
    nav { position: static; width: 100%; flex: none; max-height: none; border-right: none; border-bottom: 1px solid var(--line); }
    .doc-body { flex-direction: column; }
    .doc-info { flex: none; border-right: none; border-bottom: 1px solid var(--line); }
    main { padding: 20px 16px 60px; }
  }
</style>
</head>
<body>
<header>
  <h1>打印单据总览</h1>
  <p>这是系统目前能打印出来的全部纸质单据，每一张都用真实的生产数据填充，并标注了它从哪个页面、哪个按钮打出来。请逐张看，觉得哪里不对就直接说这张单的编号。</p>
  <div class="meta-bar">
    <span><b>单据数：</b>${counter} 张</span>
    <span><b>数据：</b>生产库快照（2026-09-20 取）</span>
    <span><b>说明：</b>页面里的客户名、地址、价格都是真实的，请勿外传</span>
  </div>
</header>

<div class="layout">
<nav>
  <h5>单据清单</h5>
  ${navHtml}
</nav>

<main>
  ${groupsHtml}

</main>
</div>
</body>
</html>
`

writeFileSync(join(OUT, 'index.html'), html, 'utf8')
console.log(`总览页已生成：${join(OUT, 'index.html')}`)
console.log(`收录单据：${counter} 张`)
