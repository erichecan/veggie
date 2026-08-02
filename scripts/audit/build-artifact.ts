/**
 * 从探针结果直接生成 artifact 页面，避免 57 条数据手工转录出错。
 *
 *   npx tsx scripts/audit/build-artifact.ts <输出路径>
 */
import { readFileSync, writeFileSync } from 'node:fs'
import type { CheckResult, Verdict } from './harness'

const RESULTS = 'docs/audit-evidence/20260802-results.json'
const OUT = process.argv[2] || 'docs/audit-evidence/artifact.html'

const MODULES: { code: string; name: string; note?: string }[] = [
  { code: '01', name: 'B2B 移动端订货系统（客户前端 App / Web）' },
  { code: '02', name: 'Quotation 和销售单' },
  { code: '03', name: '配送与司机电子签收（TMS & POD 配送端）' },
  { code: '04', name: '司机绩效与 CMS 分析' },
  { code: '05', name: '日销售管理中心（运营操作台）' },
  { code: '06', name: '仓储与库存管理中心' },
  { code: '07', name: '采购管理中心' },
  { code: '08', name: '财务管理中心' },
  { code: '09', name: '数据分析与 BI 决策中心' },
  { code: '10', name: '基础信息与系统管理' },
  { code: '11', name: '系统部署（含双系统独立并行运行）' },
  { code: '12', name: '接口与安全' },
  { code: '14', name: 'Odoo 数据平移与导出（数据搬运）' },
]

const LABEL: Record<Verdict, string> = {
  done: '已完成', partial: '部分完成', missing: '未完成', deferred: '待触发',
}
const SCORE: Record<Verdict, number> = { done: 1, partial: 0.5, missing: 0, deferred: 0 }

const raw = JSON.parse(readFileSync(RESULTS, 'utf8')) as Record<string, CheckResult>
const all = Object.values(raw).sort((a, b) => a.id.localeCompare(b.id))
const contract = all.filter(r => r.id !== 'M01-04')
const counted = contract.filter(r => r.verdict !== 'deferred')

const tally: Record<Verdict, number> = { done: 0, partial: 0, missing: 0, deferred: 0 }
for (const r of contract) tally[r.verdict]++
const pct = (counted.reduce((s, r) => s + SCORE[r.verdict], 0) / counted.length) * 100

const PREV = { done: 15, partial: 26, missing: 14, deferred: 2 }
const prevPct = ((PREV.done + PREV.partial * 0.5) / 55) * 100

const moved = contract.filter(r => r.prev && r.prev !== r.verdict)
const up = moved.filter(r => SCORE[r.prev!] < SCORE[r.verdict])
const down = moved.filter(r => SCORE[r.prev!] > SCORE[r.verdict])

const esc = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/** gap 文本里的 `code` 与 **bold** 转成标签 */
function rich(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

function delta(r: CheckResult): string {
  if (!r.prev || r.prev === r.verdict) return ''
  const upward = SCORE[r.prev] < SCORE[r.verdict]
  return `<span class="delta ${upward ? 'up' : 'down'}" title="0729 判定为${LABEL[r.prev]}">`
    + `${upward ? '↑' : '↓'} 原${LABEL[r.prev]}</span>`
}

function segBar(items: CheckResult[]): string {
  const order: Verdict[] = ['done', 'partial', 'missing', 'deferred']
  const n = items.length
  return order.map(v => {
    const c = items.filter(i => i.verdict === v).length
    return c === 0 ? '' : `<span class="seg-${v}" style="width:${(c / n * 100).toFixed(1)}%"></span>`
  }).join('')
}

const parts: string[] = []

parts.push(`<title>合同功能清单 × 代码核实 — veggie Phase 1（0802 探针复核）</title>`)

parts.push(`<style>
:root{
  --ink:#1B2023; --paper:#F4F3EE; --raised:#FFFFFF; --line:#DEDCD3; --muted:#63675E;
  --accent:#2E5C63; --accent-soft:#DEEAE9;
  --done:#2F7D4F; --done-soft:#E1EFE4;
  --partial:#A9760A; --partial-soft:#F4E9D2;
  --missing:#B23A34; --missing-soft:#F5DEDC;
  --deferred:#62666E; --deferred-soft:#E7E7E9;
  --alarm:#8E2C24; --alarm-soft:#F7E4E1;
  --shadow:0 1px 2px rgba(27,32,35,.06),0 8px 24px -12px rgba(27,32,35,.18);
}
@media (prefers-color-scheme:dark){:root{
  --ink:#ECEAE3; --paper:#14171A; --raised:#1B1F22; --line:#2A2E31; --muted:#9BA39B;
  --accent:#86AEB6; --accent-soft:#1E2E30;
  --done:#4FAE79; --done-soft:#16281F;
  --partial:#D6A23C; --partial-soft:#2E2718;
  --missing:#D9635D; --missing-soft:#2E1D1C;
  --deferred:#9AA1AA; --deferred-soft:#23262A;
  --alarm:#E4837A; --alarm-soft:#2E1A18;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px -12px rgba(0,0,0,.5);
}}
:root[data-theme="dark"]{
  --ink:#ECEAE3; --paper:#14171A; --raised:#1B1F22; --line:#2A2E31; --muted:#9BA39B;
  --accent:#86AEB6; --accent-soft:#1E2E30;
  --done:#4FAE79; --done-soft:#16281F; --partial:#D6A23C; --partial-soft:#2E2718;
  --missing:#D9635D; --missing-soft:#2E1D1C; --deferred:#9AA1AA; --deferred-soft:#23262A;
  --alarm:#E4837A; --alarm-soft:#2E1A18;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px -12px rgba(0,0,0,.5);
}
:root[data-theme="light"]{
  --ink:#1B2023; --paper:#F4F3EE; --raised:#FFFFFF; --line:#DEDCD3; --muted:#63675E;
  --accent:#2E5C63; --accent-soft:#DEEAE9;
  --done:#2F7D4F; --done-soft:#E1EFE4; --partial:#A9760A; --partial-soft:#F4E9D2;
  --missing:#B23A34; --missing-soft:#F5DEDC; --deferred:#62666E; --deferred-soft:#E7E7E9;
  --alarm:#8E2C24; --alarm-soft:#F7E4E1;
  --shadow:0 1px 2px rgba(27,32,35,.06),0 8px 24px -12px rgba(27,32,35,.18);
}
*{box-sizing:border-box}
html{color-scheme:light dark;scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--paper);color:var(--ink);line-height:1.65;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI","Microsoft YaHei","Helvetica Neue",Arial,sans-serif;
  -webkit-font-smoothing:antialiased}
.mono{font-family:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.88em;
  background:var(--accent-soft);padding:.05em .3em;border-radius:3px;word-break:break-word}
a{color:var(--accent)}
::selection{background:var(--accent-soft)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.page{max-width:900px;margin:0 auto;padding:3rem 1.5rem 5rem}

.masthead{padding-bottom:1.75rem;border-bottom:1px solid var(--line)}
.eyebrow{margin:0 0 .6rem;font-size:.72rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
h1{margin:0 0 .7rem;font-size:clamp(1.6rem,1.1rem + 2vw,2.15rem);font-weight:700;letter-spacing:-.01em;text-wrap:balance}
.lede{margin:0 0 .9rem;max-width:64ch;font-size:1.02rem}
.meta{margin:0;color:var(--muted);font-size:.85rem}

.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:var(--line);
  border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:1.75rem 0 1.25rem}
.tile{background:var(--raised);padding:1rem .9rem;display:flex;flex-direction:column;gap:.15rem}
.num{font-size:1.5rem;font-weight:700;letter-spacing:-.02em}
.t-done .num{color:var(--done)} .t-partial .num{color:var(--partial)}
.t-missing .num{color:var(--missing)} .t-deferred .num{color:var(--deferred)} .t-index .num{color:var(--accent)}
.lab{font-size:.82rem;font-weight:600}
.sub{font-size:.72rem;color:var(--muted)}
.was{font-size:.7rem;color:var(--muted);font-variant-numeric:tabular-nums}
@media (max-width:640px){.stats{grid-template-columns:repeat(2,1fr)}}

.callout{border:1px solid var(--line);border-left:3px solid var(--alarm);background:var(--alarm-soft);
  border-radius:0 10px 10px 0;padding:1.1rem 1.25rem;margin:1.5rem 0}
.callout h2{margin:0 0 .5rem;font-size:1rem;font-weight:700;color:var(--alarm)}
.callout p{margin:0 0 .55rem;font-size:.9rem;max-width:70ch}
.callout p:last-child{margin-bottom:0}
.callout pre{margin:.5rem 0;padding:.6rem .75rem;background:var(--raised);border:1px solid var(--line);
  border-radius:6px;overflow-x:auto;font-size:.8rem;line-height:1.5}

.changes{background:var(--raised);border:1px solid var(--line);border-radius:12px;
  box-shadow:var(--shadow);padding:1.2rem 1.3rem;margin:1.5rem 0}
.changes h2{margin:0 0 .3rem;font-size:1rem;font-weight:700}
.changes .hint{margin:0 0 .9rem;font-size:.85rem;color:var(--muted);max-width:70ch}
.movelist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:.5rem}
.movelist li{display:grid;grid-template-columns:auto 1fr;gap:.6rem;align-items:baseline;
  padding-top:.5rem;border-top:1px solid var(--line);font-size:.9rem}
.movelist li:first-child{border-top:none;padding-top:0}
.arrow{font-family:ui-monospace,Menlo,monospace;font-size:.75rem;font-weight:700;white-space:nowrap;
  padding:.1rem .45rem;border-radius:4px}
.arrow.up{background:var(--done-soft);color:var(--done)}
.arrow.down{background:var(--missing-soft);color:var(--missing)}
.movelist .why{color:var(--muted);font-size:.85rem}

.jumpbar{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--paper) 92%,transparent);
  backdrop-filter:blur(6px);border-bottom:1px solid var(--line);padding:.7rem 0;margin-bottom:1.5rem;
  display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.6rem .9rem}
.jump{display:flex;flex-wrap:wrap;gap:.3rem;overflow-x:auto}
.jump a{flex:none;font-family:ui-monospace,Menlo,monospace;font-size:.72rem;text-decoration:none;
  color:var(--muted);border:1px solid var(--line);padding:.2rem .5rem;border-radius:6px}
.jump a:hover,.jump a:focus-visible{color:var(--accent);border-color:var(--accent)}
.chips{display:flex;gap:.35rem;flex:none;flex-wrap:wrap}
.chip{font:inherit;font-size:.78rem;font-weight:600;border:1px solid var(--line);background:var(--raised);
  color:var(--muted);padding:.3rem .7rem;border-radius:999px;cursor:pointer}
.chip[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--raised)}

.module{background:var(--raised);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);
  margin-bottom:1.1rem;padding:1.2rem 1.3rem 1.35rem;scroll-margin-top:4.5rem}
.mhead{display:grid;grid-template-columns:auto 1fr;column-gap:.7rem;row-gap:.55rem;align-items:baseline;margin-bottom:.85rem}
.mcode{font-family:ui-monospace,Menlo,monospace;font-size:.8rem;font-weight:700;color:var(--accent)}
.module h2{margin:0;font-size:1.05rem;font-weight:700;text-wrap:balance}
.mbar{grid-column:1/-1;display:flex;height:6px;border-radius:999px;overflow:hidden;background:var(--line)}
.seg-done{background:var(--done)} .seg-partial{background:var(--partial)}
.seg-missing{background:var(--missing)} .seg-deferred{background:var(--deferred)}

.items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.items>li{display:grid;grid-template-columns:6.4rem 1fr;gap:.8rem;padding:.75rem 0;border-top:1px solid var(--line)}
.items>li:first-child{border-top:none;padding-top:0}
@media (max-width:600px){.items>li{grid-template-columns:1fr;gap:.4rem}}
.statuswrap{display:flex;flex-direction:column;gap:.3rem;align-items:flex-start}
.status{font-size:.7rem;font-weight:700;padding:.18rem .5rem;border-radius:5px;white-space:nowrap}
li[data-status="done"] .status{background:var(--done-soft);color:var(--done)}
li[data-status="partial"] .status{background:var(--partial-soft);color:var(--partial)}
li[data-status="missing"] .status{background:var(--missing-soft);color:var(--missing)}
li[data-status="deferred"] .status{background:var(--deferred-soft);color:var(--deferred)}
.delta{font-size:.63rem;font-weight:700;padding:.1rem .35rem;border-radius:4px;white-space:nowrap;
  font-family:ui-monospace,Menlo,monospace}
.delta.up{background:var(--done-soft);color:var(--done)}
.delta.down{background:var(--missing-soft);color:var(--missing)}
.ititle{margin:0 0 .2rem;font-weight:600}
.igap{margin:0;color:var(--muted);font-size:.88rem;max-width:70ch}
details{margin-top:.45rem}
summary{cursor:pointer;font-size:.78rem;color:var(--accent);font-weight:600;list-style:none;
  display:inline-flex;align-items:center;gap:.3rem}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸";font-size:.7em;transition:transform .15s}
details[open] summary::before{transform:rotate(90deg)}
@media (prefers-reduced-motion:reduce){summary::before{transition:none}}
.ev{margin:.45rem 0 0;padding:.6rem .75rem;background:var(--paper);border:1px solid var(--line);
  border-radius:6px;list-style:none;display:flex;flex-direction:column;gap:.3rem;overflow-x:auto}
.ev li{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.74rem;line-height:1.5;
  color:var(--ink);word-break:break-word}

.na{background:var(--raised);border:1px dashed var(--line);border-radius:12px;padding:1rem 1.3rem;
  margin-bottom:1.1rem;color:var(--muted);font-size:.9rem;display:flex;align-items:baseline;gap:.7rem}
.na .mcode{color:var(--muted)}

footer{margin-top:2.5rem;padding-top:1.25rem;border-top:1px solid var(--line);color:var(--muted);font-size:.82rem}
footer h2{font-size:.9rem;color:var(--ink);margin:0 0 .5rem}
footer p{margin:0 0 .5rem;max-width:74ch}
footer pre{padding:.6rem .75rem;background:var(--raised);border:1px solid var(--line);border-radius:6px;
  overflow-x:auto;font-size:.78rem;line-height:1.55}
</style>`)

parts.push(`<div class="page">`)

// ── masthead ────────────────────────────────────────────────────────────────
parts.push(`<header class="masthead">
  <p class="eyebrow">探针复核 · 2026-08-02</p>
  <h1>合同功能清单 &times; 代码核实</h1>
  <p class="lede">对照《软件定制开发与服务合同》(IE-DEV-202607-01) 与甲方补充需求合并出的 13 个模块、57 项功能点。
  与 7 月 29 日那版人工读代码不同，本次每一条都由<strong>可重复执行的探针</strong>判定：调真实 API、查生产数据库、
  跑关键词全集检索，判定依据全部留痕。</p>
  <p class="meta">57 项功能点 · 58 条探针记录 · 判定变化 ${moved.length} 条 · 上一版核实 2026-07-29</p>
</header>`)

// ── stats ───────────────────────────────────────────────────────────────────
parts.push(`<section class="stats" aria-label="完成度概览">
  <div class="tile t-done"><span class="num mono">${tally.done}</span><span class="lab">已完成</span><span class="was mono">0729：${PREV.done}</span></div>
  <div class="tile t-partial"><span class="num mono">${tally.partial}</span><span class="lab">部分完成</span><span class="was mono">0729：${PREV.partial}</span></div>
  <div class="tile t-missing"><span class="num mono">${tally.missing}</span><span class="lab">未完成</span><span class="was mono">0729：${PREV.missing}</span></div>
  <div class="tile t-deferred"><span class="num mono">${tally.deferred}</span><span class="lab">待触发</span><span class="sub">条件成就后免费升级</span></div>
  <div class="tile t-index"><span class="num mono">${pct.toFixed(0)}%</span><span class="lab">加权完成度</span><span class="was mono">0729：${prevPct.toFixed(0)}%</span></div>
</section>
<p class="meta" style="margin-bottom:1.5rem">计分口径：已完成 1 分、部分完成 0.5 分、未完成 0 分；分母 ${counted.length} 项，不含 ${tally.deferred} 项条件触发。</p>`)

// ── security callout ────────────────────────────────────────────────────────
parts.push(`<section class="callout">
  <h2>⛔ 本次核实过程中发现并已修复的生产安全问题</h2>
  <p><code>GET /api/customers</code> 被误列入 <code>middleware.ts</code> 的公开路由白名单，
  <strong>无需任何凭据即可拉走全量客户名册</strong>。生产环境实测：</p>
  <pre>200 · 1,311,883 bytes · 1,605 个客户
字段含 name / address / phone / email / vatNumber / creditLimit / commissionRate</pre>
  <p>成因是早期一次「修 <code>/enter</code> 路由 404」时顺手加进白名单，并非有意公开；该前缀还连带放行了整个
  <code>/api/customers/*</code> 子树。全部调用方都在登录态之后并携带 Bearer token，移除白名单不影响功能。</p>
  <p>同一路由还有第二处授权绕过：SALES 行级隔离条件在 <code>where</code> 构造<strong>之后</strong>才加入，
  <code>where</code> 已退化成 <code>{}</code> 时该条件不再生效——<code>?includeArchived=1</code> 且无其他筛选时销售员可看到全部客户。</p>
  <p>两处均已修复并部署（commit <code>588357a</code>）：匿名请求返回 401，带 token 返回 200。</p>
</section>

<section class="changes">
  <h2>核实之后动手修掉的三项</h2>
  <p class="hint">这份报告不只是判定。核实过程中暴露的问题里，有三项当场做掉了。</p>
  <ul class="movelist">
    <li><span class="arrow up">已修</span>
      <div><strong>白名单缺回归测试</strong><br><span class="why">
      客户名册泄露的根因不是有人写错，而是<em>白名单加错了没有任何测试会红</em>。
      新增的测试扫描全部 157 个 API 路由，算出 middleware 会放行哪些，与显式快照比对。
      反向验证过：把 <code>/api/customers</code> 加回白名单，测试立刻变红并列出前缀匹配连带放行的 6 条子路由。
      </span></div></li>
    <li><span class="arrow up">已补</span>
      <div><strong>应付账龄报表</strong><br><span class="why">
      导航里原本挂着入口但页面和 API 都不存在，点进去 404。现已补齐，与应收共用同一套账龄阈值，
      两张表可直接对读。补的过程中发现 25 张供应商账单<em>全是草稿未过账</em>（合计 €27,925.60），
      账龄表因而暂为空——页面把这一点写在了提示条里，而不是让人以为功能坏了。
      </span></div></li>
    <li><span class="arrow down">已摘</span>
      <div><strong>利润表入口</strong><br><span class="why">
      同样是 404 死链，但这条选择摘掉而不是补。利润表 = 收入 − 成本 − 费用，
      而<em>费用没有数据来源</em>：没有支出录入模块，会计科目有 10 个但分录 0 条。
      硬做只能产出一张缺全部运营费用的表，给甲方看比没有更糟。恢复它的三个前置条件写进了代码注释。
      </span></div></li>
    <li><span class="arrow up">已改</span>
      <div><strong>备份落点</strong><br><span class="why">
      原本直连 GCS，与「整体迁到客户自有服务器」的目标冲突，且三次任务成功零次。
      现抽成 driver（本地磁盘 / S3 兼容 / GCS 遗留），迁移时只改配置不改代码。
      已用本地 driver 端到端跑出 <strong>81.7 MB</strong> 可解压备份——<em>这是该系统第一次成功产出备份</em>。
      </span></div></li>
  </ul>
</section>`)

// ── changes ─────────────────────────────────────────────────────────────────
const moveItems = [...up, ...down].map(r => {
  const upward = SCORE[r.prev!] < SCORE[r.verdict]
  return `<li><span class="arrow ${upward ? 'up' : 'down'}">${LABEL[r.prev!]} → ${LABEL[r.verdict]}</span>
    <div><strong>${esc(r.title)}</strong><br><span class="why">${rich((r.gap ?? '').slice(0, 220))}</span></div></li>`
}).join('\n')

parts.push(`<section class="changes">
  <h2>与 7 月 29 日版本的差异</h2>
  <p class="hint">升级 ${up.length} 条、降级 ${down.length} 条、维持 ${contract.length - moved.length} 条。
  六条升级里有五条对应的功能是在 7 月 29 日核实<em>之后</em>才合入的——上一版的主要问题是时效性；
  唯一一条降级则来自判断口径的收紧：把「代码存在」与「生产上真的跑过」分开看。</p>
  <ul class="movelist">
${moveItems}
  </ul>
</section>`)

// ── nav ─────────────────────────────────────────────────────────────────────
const jumps = MODULES.map(m => `<a href="#m${m.code}">${m.code} ${m.name.slice(0, 6)}</a>`).join('')
parts.push(`<nav class="jumpbar" aria-label="模块跳转与状态筛选">
  <div class="jump">${jumps}</div>
  <div class="chips" role="group" aria-label="按状态筛选">
    <button class="chip" data-filter="all" aria-pressed="true">全部</button>
    <button class="chip" data-filter="changed" aria-pressed="false">有变化</button>
    <button class="chip" data-filter="done" aria-pressed="false">已完成</button>
    <button class="chip" data-filter="partial" aria-pressed="false">部分完成</button>
    <button class="chip" data-filter="missing" aria-pressed="false">未完成</button>
  </div>
</nav>`)

// ── modules ─────────────────────────────────────────────────────────────────
parts.push(`<main>`)
for (const m of MODULES) {
  const items = all.filter(r => r.module === m.code)
  if (items.length === 0) continue
  const lis = items.map(r => {
    const ev = r.evidence.map(e => `<li>${esc(e)}</li>`).join('')
    const changed = r.prev && r.prev !== r.verdict ? ' data-changed="1"' : ''
    return `<li data-status="${r.verdict}"${changed}>
      <div class="statuswrap"><span class="status">${LABEL[r.verdict]}</span>${delta(r)}</div>
      <div>
        <p class="ititle">${esc(r.title)}</p>
        ${r.gap ? `<p class="igap">${rich(r.gap)}</p>` : ''}
        <details><summary>探针证据 ${r.id}</summary><ul class="ev">${ev}</ul></details>
      </div>
    </li>`
  }).join('\n')

  parts.push(`<section class="module" id="m${m.code}">
  <div class="mhead">
    <span class="mcode">${m.code}</span>
    <h2>${esc(m.name)}</h2>
    <div class="mbar" aria-hidden="true">${segBar(items)}</div>
  </div>
  <ul class="items">
${lis}
  </ul>
</section>`)
}

parts.push(`<div class="na" id="m13">
  <span class="mcode mono">13</span>
  <span>维护服务与保修期——商务/服务承诺条款（24 小时响应 / €300 每次，或 6–9 个月免费保修与年费挂钩），
  不是代码功能，无「完成度」可言，不计入统计。</span>
</div>`)
parts.push(`</main>`)

// ── footer ──────────────────────────────────────────────────────────────────
parts.push(`<footer>
  <h2>这份报告是怎么得出来的</h2>
  <p>每一条判定都对应一个探针函数，跑起来会调真实 API（本地实例连生产库）、查生产数据库计数、
  或对关键词全集做代码检索。判定为「未完成」的条目，证据里一定给得出<strong>检索命中为零的关键词清单</strong>；
  判定为「已完成」的条目，必须有接口实际返回值或生产数据支撑——只有代码文件不算完成。</p>
  <p>涉及写操作的链路（客户下单、报价单确认与撤回）用了真实写探针：创建的记录统一带
  <code>AUDIT-PROBE-20260802</code> 标记，跑完在 <code>finally</code> 里删除，不触碰任何既有数据。
  订单状态往返那条实测到库存 23 → 22 → 23 净变化为零、审计链 created → confirmed → withdrawn 完整。</p>
  <p>复现方式：</p>
  <pre>npx tsx --env-file=.env.local scripts/audit/run.ts --list
npx tsx --env-file=.env.local scripts/audit/run.ts --module 08
npx tsx scripts/audit/summarize.ts</pre>
  <p>探针源码 <code>scripts/audit/</code>；原始判定与证据 <code>docs/audit-evidence/20260802-results.json</code>；
  逐条差异表 <code>docs/20260802-contract-audit-diff.md</code>；功能边界清单 <code>docs/20260729-phase1-feature-scope-boundary.md</code>。</p>
</footer>`)

parts.push(`</div>`)

parts.push(`<script>
(function(){
  var chips = document.querySelectorAll('.chip[data-filter]');
  var items = document.querySelectorAll('.items > li');
  chips.forEach(function(chip){
    chip.addEventListener('click', function(){
      chips.forEach(function(c){ c.setAttribute('aria-pressed','false'); });
      chip.setAttribute('aria-pressed','true');
      var f = chip.getAttribute('data-filter');
      items.forEach(function(li){
        var show = f === 'all'
          || (f === 'changed' ? li.hasAttribute('data-changed') : li.getAttribute('data-status') === f);
        li.style.display = show ? 'grid' : 'none';
      });
    });
  });
})();
</script>`)

writeFileSync(OUT, parts.join('\n') + '\n')
console.log(`已生成 ${OUT}`)
console.log(`统计: done=${tally.done} partial=${tally.partial} missing=${tally.missing} deferred=${tally.deferred} → ${pct.toFixed(1)}%`)
console.log(`变化: 升级 ${up.length} 降级 ${down.length} 维持 ${contract.length - moved.length}`)
