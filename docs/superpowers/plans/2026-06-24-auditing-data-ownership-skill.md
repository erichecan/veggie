# auditing-data-ownership Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个全局、跨项目、可自动执行的 SSOT/数据所有权审计 skill,脚本机械产证据、Claude 判定分类,产出字段所有权矩阵 + 修复决策表。

**Architecture:** skill 目录在 `~/.claude/skills/auditing-data-ownership/`。两个 Node 脚本:`detect-stack.mjs` 探测 ORM/DB 栈,`collect-evidence.mjs` 按栈规则用 ripgrep 扫每个字段的写入/读取点输出 `evidence.json`(纯事实)。Claude 读 evidence 按四分类(canonical/derived/cache/dead)判定,套用 references 模板产出两份文档。Prisma 适配器做透,未知栈降级到通用模式。

**Tech Stack:** Node ESM(`.mjs`,Node ≥18 内置模块,无第三方依赖)、ripgrep(`rg`)、Markdown。

## Global Constraints

- skill 文件位于全局目录 `~/.claude/skills/auditing-data-ownership/`,**不在任何项目 git repo 内**;`~/.claude` 非 git 仓库,故每个任务的收尾是"产物落位 + 验证",不执行 `git commit`(skill 本体);本计划/spec 文档在 veggie repo 内,是否提交由用户定。
- 脚本一律 Node ESM(`.mjs`),仅用 `node:fs`/`node:path`/`node:child_process` 等内置模块,**零第三方依赖**(skill 要在任意机器即装即用)。
- 脚本依赖 `rg`(ripgrep);脚本启动时检测 `rg` 是否存在,缺失则报明确错误并提示安装,不静默产出空结果。
- 审计**全程只读**:脚本绝不写用户项目代码/数据;只写 `evidence.json` 到 cwd 或指定输出路径。
- 脚本对大型库要稳:`rg` 调用设 `maxBuffer`,异常降级返回空数组而非崩溃;未知栈输出字段清单 + 覆盖率提示,不崩。
- 验收基准库 = veggie(Prisma 栈,代码根 `app/ components/ lib/ prisma/`,无 `src/`)。争议字段基准:`Order.driverSlotId`(多写入点)、`Order.items`(腐化副本)、`Product.qtyOnHand`(唯一余额)、`PickingWave.orderIds`。
- 脚本只做机械归集,绝不在输出里下"canonical/cache"等判断结论;分类是 Claude 的职责。

---

### Task 1: Skill 骨架 + detect-stack.mjs(栈探测)

**Files:**
- Create: `~/.claude/skills/auditing-data-ownership/scripts/detect-stack.mjs`

**Interfaces:**
- Produces: CLI `node detect-stack.mjs [projectRoot]` → stdout 打印 JSON `{ root, stack, schemaPath?, confidence, scanDirs[], allCandidates[] }`。`stack` ∈ `prisma|typeorm|drizzle|mongoose|django|unknown`。该 JSON 是 Task 2 `collect-evidence.mjs` 的输入。

- [ ] **Step 1: 写 detect-stack.mjs**

```js
#!/usr/bin/env node
// 探测项目使用的 ORM/DB 层,输出扫描配置。只读。
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(process.argv[2] ?? process.cwd());

function rgHasMatch(pattern, globs) {
  try {
    execFileSync('rg', ['-l', '--max-count', '1', pattern,
      ...globs.flatMap(g => ['-g', g]), root],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch { return false; } // rg exit 1 = no match
}

function hasRg() {
  try { execFileSync('rg', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

if (!hasRg()) {
  console.error('ERROR: ripgrep (rg) not found. Install it (brew install ripgrep) and retry.');
  process.exit(2);
}

const candidates = [];
const prismaSchema = ['prisma/schema.prisma', 'schema.prisma']
  .map(p => join(root, p)).find(existsSync);
if (prismaSchema) candidates.push({ stack: 'prisma', schemaPath: prismaSchema, confidence: 'high' });
if (rgHasMatch('@Entity\\(', ['*.ts'])) candidates.push({ stack: 'typeorm', confidence: 'medium' });
if (['drizzle.config.ts', 'drizzle.config.js'].some(f => existsSync(join(root, f))))
  candidates.push({ stack: 'drizzle', confidence: 'medium' });
if (rgHasMatch('mongoose\\.(model|Schema)\\(', ['*.ts', '*.js']))
  candidates.push({ stack: 'mongoose', confidence: 'medium' });
if (rgHasMatch('\\bmodels\\.Model\\b', ['*.py']))
  candidates.push({ stack: 'django', confidence: 'medium' });

const chosen = candidates[0] ?? { stack: 'unknown', confidence: 'none' };
const scanDirs = ['app', 'lib', 'src', 'components', 'server', 'pages', 'api', 'prisma']
  .filter(d => existsSync(join(root, d)));
console.log(JSON.stringify({ root, ...chosen, scanDirs, allCandidates: candidates }, null, 2));
```

- [ ] **Step 2: 在 veggie 上跑,验证识别为 prisma**

Run: `node ~/.claude/skills/auditing-data-ownership/scripts/detect-stack.mjs /Volumes/datacenter/04-eric/AIcoding/veggie`
Expected: stdout JSON `stack` 为 `"prisma"`,`schemaPath` 以 `prisma/schema.prisma` 结尾,`scanDirs` 含 `app`/`lib`/`components`/`prisma`(无 `src`)。

- [ ] **Step 3: 验证未知栈降级**

Run: `node ~/.claude/skills/auditing-data-ownership/scripts/detect-stack.mjs /tmp`
Expected: stdout JSON `stack` 为 `"unknown"`,`confidence` 为 `"none"`,不崩溃。

- [ ] **Step 4: 产物落位验证**

Run: `test -f ~/.claude/skills/auditing-data-ownership/scripts/detect-stack.mjs && echo OK`
Expected: `OK`

---

### Task 2: collect-evidence.mjs(Prisma 字段读写点扫描)

**Files:**
- Create: `~/.claude/skills/auditing-data-ownership/scripts/collect-evidence.mjs`

**Interfaces:**
- Consumes: Task 1 的 stack JSON(经文件或 stdin 传入),用 `schemaPath`/`scanDirs`/`root`。
- Produces: CLI `node collect-evidence.mjs <projectRoot> <stackJsonPath>` → 写 `evidence.json` 到 cwd,结构:`{ stack, generatedFor, fields: [{ model, field, definedAt, hitCount, noisy, hits: [{ file, line, text, guess }] }] }`,`guess` ∈ `write|read|?`。

- [ ] **Step 1: 写 collect-evidence.mjs**

```js
#!/usr/bin/env node
// 机械归集:每个 prisma 字段的写入点/读取点。只产证据,不下判断。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(process.argv[2] ?? process.cwd());
const stackJsonPath = process.argv[3];
if (!stackJsonPath || !existsSync(stackJsonPath)) {
  console.error('Usage: collect-evidence.mjs <projectRoot> <stackJsonPath>');
  process.exit(2);
}
const stack = JSON.parse(readFileSync(stackJsonPath, 'utf8'));
if (stack.stack !== 'prisma' || !stack.schemaPath) {
  console.error(`This adapter handles prisma only; got "${stack.stack}". ` +
    `Falling back: emitting field list without read/write classification.`);
}

const MAX_HITS = 40; // 通用字段(name/status)噪音截断阈值
const WRITE_HINTS = /\b(create|createMany|update|updateMany|upsert)\b|data\s*:|set\s*:|\.\w+\s*=[^=]/;
const READ_HINTS = /\b(select|include|where|findMany|findUnique|findFirst|groupBy|map|filter|return)\b/;

function parsePrismaModels(schemaText) {
  const models = [];
  const re = /model\s+(\w+)\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(schemaText))) {
    const name = m[1];
    const fields = [];
    for (const raw of m[2].split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
      const fm = line.match(/^(\w+)\s+[\w\[\]\?\.]+/);
      if (fm) fields.push(fm[1]);
    }
    models.push({ name, fields });
  }
  return models;
}

function rgField(field, dirs) {
  try {
    const out = execFileSync('rg',
      ['--no-heading', '--line-number', '--color', 'never', '-w', field, ...dirs],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024 });
    return out.split('\n').filter(Boolean).map(l => {
      const m = l.match(/^(.+?):(\d+):(.*)$/);
      if (!m) return null;
      const text = m[3].trim();
      let guess = '?';
      if (WRITE_HINTS.test(text)) guess = 'write';
      else if (READ_HINTS.test(text)) guess = 'read';
      return { file: m[1], line: Number(m[2]), text: text.slice(0, 200), guess };
    }).filter(Boolean);
  } catch { return []; }
}

const schemaText = readFileSync(stack.schemaPath, 'utf8');
const models = parsePrismaModels(schemaText);
const codeDirs = stack.scanDirs.filter(d => existsSync(resolve(root, d)));

const fields = [];
for (const model of models) {
  for (const field of model.fields) {
    const allHits = rgField(field, codeDirs);
    const noisy = allHits.length > MAX_HITS;
    fields.push({
      model: model.name, field,
      definedAt: stack.schemaPath,
      hitCount: allHits.length, noisy,
      hits: noisy ? allHits.slice(0, MAX_HITS) : allHits,
    });
  }
}

const evidence = { stack: stack.stack, generatedFor: root, fieldCount: fields.length, fields };
writeFileSync('evidence.json', JSON.stringify(evidence, null, 2));
console.log(`Wrote evidence.json: ${fields.length} fields across ${models.length} models. ` +
  `Noisy fields (>${MAX_HITS} hits, need Claude to narrow by model context): ` +
  `${fields.filter(f => f.noisy).length}.`);
```

- [ ] **Step 2: 在 veggie 上生成证据**

Run:
```bash
cd /tmp && node ~/.claude/skills/auditing-data-ownership/scripts/detect-stack.mjs /Volumes/datacenter/04-eric/AIcoding/veggie > /tmp/stack.json && node ~/.claude/skills/auditing-data-ownership/scripts/collect-evidence.mjs /Volumes/datacenter/04-eric/AIcoding/veggie /tmp/stack.json
```
Expected: 打印 `Wrote evidence.json: <N> fields ...`,N 为几百量级;`/tmp/evidence.json` 存在。

- [ ] **Step 3: 断言争议字段有多写入点(核心验收)**

Run:
```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const e = JSON.parse(readFileSync('/tmp/evidence.json','utf8'));
const f = e.fields.find(x => x.model==='Order' && x.field==='driverSlotId');
const writes = (f?.hits ?? []).filter(h => h.guess==='write');
console.log('driverSlotId writes:', writes.length, 'total hits:', f?.hitCount);
if (!f || writes.length < 1) { console.error('FAIL: driverSlotId not captured'); process.exit(1); }
const items = e.fields.find(x => x.model==='Order' && x.field==='items');
console.log('Order.items hits:', items?.hitCount);
if (!items) { console.error('FAIL: Order.items missing'); process.exit(1); }
console.log('PASS');
"
```
Expected: 末行 `PASS`;`driverSlotId writes` ≥ 1、`Order.items hits` > 0。
(注:写入点 guess 是启发式近似;只要字段被捕获且至少一处判为 write 即通过——精判由 Claude 复核,这正是脚本产证据/Claude 判定的分工。)

- [ ] **Step 4: 验证非 Prisma 输入不崩**

Run:
```bash
echo '{"stack":"unknown","scanDirs":["app"],"root":"/tmp"}' > /tmp/badstack.json && node ~/.claude/skills/auditing-data-ownership/scripts/collect-evidence.mjs /tmp /tmp/badstack.json; echo "exit=$?"
```
Expected: 打印 fallback 提示(stderr)且 `exit=0`(无 schemaPath 时 `models` 为空,产出空 fields 而非崩溃)。

---

### Task 3: adapters/prisma.md(扫描规则文档)

**Files:**
- Create: `~/.claude/skills/auditing-data-ownership/adapters/prisma.md`

**Interfaces:**
- Produces: 给 Claude 看的"Prisma 栈下如何把脚本证据解读为读写点"的规则文档;被 SKILL.md 引用。

- [ ] **Step 1: 写 prisma.md**

内容(完整写入,不留占位):

```markdown
# Adapter: Prisma

`collect-evidence.mjs` 已对每个 `model.field` 用 `rg -w` 全字搜出命中,并对每行做启发式 `guess`(write/read/?)。本文件告诉 Claude 如何把这些机械命中校正为准确的写入点/读取点。

## 写入点的代码特征(出现即"写")
- 出现在 prisma 调用的 `data: { ... field: ... }` 块内(`create`/`createMany`/`update`/`updateMany`/`upsert`)。
- 直接赋值:`obj.field = ...`、`field: someValue`(在构造写入对象时)。
- seed 脚本(`prisma/seed*`)里的 create/update。

## 读取点的代码特征(出现即"读")
- `select: { field: true }` / `include`(关系) / `where: { field }`。
- 查询结果消费:`order.field`、解构 `const { field } = ...`、JSX/模板里渲染 `{order.field}`、`.map(o => o.field)`。
- 聚合:`groupBy`/`_sum`。

## 必须人工缩小的情况
- `noisy: true` 的字段(命中 > 40,通常是 `id`/`name`/`status`/`createdAt` 等通用名):按 `model` 的查询上下文(`prisma.order.` vs `prisma.product.`)区分,丢弃其他 model 的同名命中。
- 关系字段(FK 如 `driverSlotId` 与导航属性 `driverSlot`)要合并看:写 FK、读导航是常见模式。

## 本栈特有的两个交叉信号(脚本看不出,Claude 必须主动查)
- **设计意图 vs 实现矛盾**:注释/迁移声明"单一存储=X",但仍有路由在写副本 Y。grep 注释关键词("单一存储"/"single source"/"canonical")与实际写入点对照。
- **读 FK 写 String 倒挂**:声明的 FK(`uomId`)无写入点,实际在写的是 legacy String(`unitOfMeasure`)。FK 字段 `hitCount` 低且无 write guess 时重点查。

## 其余栈兜底
非 Prisma 栈:`collect-evidence.mjs` 仅输出字段清单(或空),Claude 退到通用模式——自己用 rg 按上述"写/读特征"搜各字段,覆盖率低于 Prisma,需在报告里声明这一限制。
```

- [ ] **Step 2: 产物落位验证**

Run: `test -f ~/.claude/skills/auditing-data-ownership/adapters/prisma.md && echo OK`
Expected: `OK`

---

### Task 4: references 模板(矩阵 + 决策表)

**Files:**
- Create: `~/.claude/skills/auditing-data-ownership/references/ownership-matrix.md`
- Create: `~/.claude/skills/auditing-data-ownership/references/refactor-decision.md`

**Interfaces:**
- Produces: 两份 Claude 直接套用的产出物模板,示例取自 veggie 真实审计。被 SKILL.md 引用。

- [ ] **Step 1: 写 ownership-matrix.md**

```markdown
# 产出物模板:字段所有权矩阵

按业务链路(订单/配送/库存/财务/客户…)分组,每组一张表。每个字段必须落到且只落到一个分类。

## 四分类
- **canonical(权威)** — 该事实唯一真相来源。✅
- **derived / 合理快照** — 应从别处算出或下单冻结(标注:派生自谁、何时快照、是否需刷新)。
- **cache(冗余副本)** — 另一 canonical 的拷贝,有不同步风险。⚠️ 病灶。
- **dead(死字段)** — 无人读或无人写。🗑️

## 表格格式
| 字段 | 分类 | 写入点(file:line,时机) | 读取点 | 问题 |
|---|---|---|---|---|
| `Order.driverSlotId` | canonical(下单意向) | orders/route.ts:268 下单、orders/[id]:133 编辑 | orders/route.ts:87、dispatch-loader:98 | 与 wave.orderIds 各管一摊,无同步 |
| `PickingWave.orderIds[]` | canonical(实际调度) | waves/[id]/assign:51、batch:96 拖拽 | BatchTab:103 | **与 driverSlotId 同一事实两套真相** |
| `Order.items`(Json) | cache(已腐化) | 仅下单写一次 orders:260 | waves:404、报表:178、打印 | 改单/确认/差异全不回写,同单不同页明细不一致 |
| `Product.qtyOnHand` | canonical(唯一余额) | 确认扣减、收货、报废… | 下单 ATP、仓库页 | 全系统唯一真递增减的库存 |
| `PickingWave.status` | dead | 仅泛化透传 | board | 整套枚举无业务流推进 |

## 病灶判定优先级
- **P0**:同一事实多个 canonical 且互不回写(端到端跑不通的根)。
- **P0**:cache 字段无回填机制(永久腐化)。
- **P1**:多套平行状态机不同步。
- **P2**:死字段 / 命名重叠副本。

## 每张表收尾必须有"结论"行
点明该链路的唯一权威是谁、哪些是要消除的副本、有无"设计意图 vs 实现自相矛盾"。
```

- [ ] **Step 2: 写 refactor-decision.md**

```markdown
# 产出物模板:修复决策表

对每条 SSOT 冲突给"二选一"owner 决策 + Strangler 安全重构步骤。

## Strangler 铁律(决策表头必须声明)
**先统一读 → 回填数据 → 再删重复写 → 最后删死字段。绝不一次性大改。前两步零风险。**

## owner 选择原则
每个事实选一个 canonical owner,其余改为"引用它"或"实时派生";合理的下单快照保留不动。

## 表格格式
| 事实 | 推荐 canonical owner | 处置其余 | 风险 | 影响读取点 | 可选护栏 |
|---|---|---|---|---|---|
| 这单归谁送 | `PickingWave.orderIds[]` 单一存储 | driverSlotId 降为下单默认意向;封装 getOrderDispatch() 统一读;删 deliveryBatch 字符串 | 中 | 3 | db:validate 加"订单调度信息单源" |
| 订单明细 | `OrderLine[]` | 删 `Order.items` 列,所有读 items 页面改读 lines | 高 | 8+ | Σ line == header 不变量 |
| 库存余额 | `Product.qtyOnHand` | 删 Product.stock 及 fallback;销售出库补扣 Lot | 中 | — | qtyOnHand == ΣStockMove |

## 每条冲突的展开块(可选,复杂冲突用)
```
冲突: <两套真相是什么>
决策: <留谁为 canonical,为什么>
步骤: 1.封装统一读取口 2.列表改读它 3.回填校验 4.停写副本 5.删字段
风险: 低/中/高 | 影响读取点: N 处
可选护栏: db:validate 加 <不变量>
```

## 推荐执行顺序(整体)
1. 本审计(只读映射)✅
2. owner 决策逐条拍板
3. 封装统一读取口(读先收口,不动写)
4. 先治收益最大的腐化副本(如 Order.items)
5. 再治多真相调度
6. 状态机显式化(非法转移抛错)
7. 不变量护栏入 CI(接 validating-data-integrity)
8. E2E 真实 API 驱动跑通(接 testing-end-to-end-experience)
```

- [ ] **Step 3: 产物落位验证**

Run: `ls ~/.claude/skills/auditing-data-ownership/references/ | sort`
Expected: `ownership-matrix.md` 与 `refactor-decision.md` 两行。

---

### Task 5: SKILL.md(主文件)

**Files:**
- Create: `~/.claude/skills/auditing-data-ownership/SKILL.md`

**Interfaces:**
- Consumes: Task 1-4 的脚本与文档(在 SKILL.md 里引用其相对路径)。
- Produces: skill 入口,含 frontmatter(name/description)、四步流程、四分类标准、Common Mistakes。

- [ ] **Step 1: 写 SKILL.md**

```markdown
---
name: auditing-data-ownership
description: Use when the same business fact is stored in multiple places and lists read from different sources — symptoms are lists/totals that disagree without any program error, a state machine you can't debug, or an end-to-end flow that won't pass because ownership is split (not a logic bug, not a DB error). Audits schema/field-level data ownership (SSOT) — distinct from validating-data-integrity which checks data values reconcile. Produces a field-ownership matrix and a refactor decision table.
---

# Auditing Data Ownership (SSOT)

## Overview

"一个功能一个功能堆"出来的系统最常见的债不是 bug,而是**数据所有权混乱**:同一业务事实被存进多个地方,各处自洽却彼此矛盾,列表又从不同源读取。程序不报错、DB 不报错,但业务逻辑不一致,状态机没法调试,端到端跑不通。

本 skill 在**结构层(schema/字段)**审计所有权,区别于 `validating-data-integrity`(数据值层)、`designing-seed-data`(生成层)、`testing-end-to-end-experience`(行为层)。全程**只读**。

## Core Principle

每个业务事实——**谁写它?谁读它?它是存的还是算的?** 凡是答案出现"多个写入点 / 多处都声称权威",就是病灶。

## When to Use
- 列表/报表数据彼此矛盾,但没有任何程序异常。
- 状态机难以调试(同一状态在多处各写一套)。
- 重构/排查前需要一张"同一实体被存到哪些地方"的全库地图。
- 端到端流程跑不通,怀疑是数据所有权混乱而非逻辑 bug。

## Process(脚本产证据 → Claude 判定)

分工铁律:**脚本只机械归集证据,绝不下判断;Claude 只判断,不重复机械活。**

1. **探测栈** — `node scripts/detect-stack.mjs <projectRoot> > stack.json`。识别 prisma/typeorm/drizzle/mongoose/django/unknown。
2. **扫证据** — `node scripts/collect-evidence.mjs <projectRoot> stack.json`(生成 `evidence.json`)。Prisma 走专用扫描;其余栈降级,Claude 退到通用 rg 模式(见 `adapters/prisma.md` 末节)。
3. **判定分类** — 读 `evidence.json`,按四分类标注每个字段,校正脚本的 write/read 启发式(规则见 `adapters/prisma.md`);主动查两个脚本看不出的交叉信号:**设计意图 vs 实现矛盾**、**读 FK 写 String 倒挂**。
4. **产出两份文档** — 套 `references/ownership-matrix.md` 出字段所有权矩阵,套 `references/refactor-decision.md` 出修复决策表(含 Strangler 顺序)。写到项目 `docs/YYYYMMDD-data-ownership-audit.md`。

## 四分类(判定标准)
- **canonical(权威)** — 唯一真相来源。✅
- **derived / 合理快照** — 应算出或下单冻结(标注派生自谁、何时快照)。
- **cache(冗余副本)** — 另一 canonical 的拷贝,有不同步风险。⚠️ 病灶。
- **dead(死字段)** — 无人读或无人写。🗑️

**病灶 = (a) 同一事实多个 canonical 互不回写;(b) cache 无回填机制。**

## Common Mistakes
| Mistake | Fix |
|---|---|
| 信任脚本的 write/read guess 当结论 | 脚本是证据,Claude 必须按 adapter 规则复核分类 |
| 只看单个字段 | 关系字段(FK + 导航属性)、同义副本(role vs roles[])要合并看 |
| 忽略 noisy 字段 | 通用名(name/status)按 model 上下文缩小,别整张丢 |
| 漏掉"设计意图 vs 实现矛盾" | grep 注释里的"单一存储/canonical"声明,与真实写入点对照 |
| 给完报告就开大改 | 必须按 Strangler:先统一读→回填→删重复写→删死字段 |
| 与数据值审计混淆 | 本 skill 查"是否分裂存储";值是否对得上交给 validating-data-integrity |

## Relationship to Sibling Skills
本 skill 产出的修复决策表,执行到"护栏"步接 `validating-data-integrity`(把单源不变量纳入 db:validate),执行到"验证"步接 `testing-end-to-end-experience`(真实 API 驱动跑通,验证各列表同源一致)。

## The Bottom Line
别靠肉眼比对各列表猜哪儿不一致——**对每个字段机械列出谁写谁读,再判定它是存的还是算的;凡多处可写同一事实,就是病灶。**
```

- [ ] **Step 2: 校验 frontmatter 合法**

Run:
```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const t = readFileSync(process.env.HOME+'/.claude/skills/auditing-data-ownership/SKILL.md','utf8');
const m = t.match(/^---\n([\s\S]*?)\n---/);
if (!m) { console.error('FAIL: no frontmatter'); process.exit(1); }
if (!/name:\s*auditing-data-ownership/.test(m[1])) { console.error('FAIL: name'); process.exit(1); }
if (!/description:\s*Use when/.test(m[1])) { console.error('FAIL: description'); process.exit(1); }
console.log('PASS frontmatter');
"
```
Expected: `PASS frontmatter`

---

### Task 6: 端到端验收(在 veggie 复现 P0 判定)

**Files:**
- 无新建;在 veggie 跑全流程,验证 skill 可用。

**Interfaces:**
- Consumes: Task 1-5 全部产物。

- [ ] **Step 1: 全流程跑一遍**

Run:
```bash
cd /tmp && rm -f evidence.json stack.json && \
node ~/.claude/skills/auditing-data-ownership/scripts/detect-stack.mjs /Volumes/datacenter/04-eric/AIcoding/veggie > stack.json && \
node ~/.claude/skills/auditing-data-ownership/scripts/collect-evidence.mjs /Volumes/datacenter/04-eric/AIcoding/veggie stack.json && \
echo "--- sanity ---" && \
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const e = JSON.parse(readFileSync('/tmp/evidence.json','utf8'));
for (const [model,field] of [['Order','driverSlotId'],['PickingWave','orderIds'],['Order','items'],['Product','qtyOnHand']]) {
  const f = e.fields.find(x=>x.model===model && x.field===field);
  console.log(model+'.'+field, f? ('hits='+f.hitCount+' writes='+f.hits.filter(h=>h.guess==='write').length):'MISSING');
  if(!f){process.exit(1);}
}
console.log('ALL FOUR CAPTURED');
"
```
Expected: 末行 `ALL FOUR CAPTURED`,四个争议字段都有命中。

- [ ] **Step 2: Claude 据 evidence 复现 P0 判定(人工/Claude 复核)**

读 `/tmp/evidence.json` 与 `docs/20260624-data-ownership-audit.md`,确认 skill 流程能支撑得出至少:
- P0-1:`Order.driverSlotId` 与 `PickingWave.orderIds` 都有写入点 → 多 canonical 病灶。
- P0-3:`Order.items` 写入点稀少(≈仅下单)而读取点众多 → 腐化 cache。

Expected: evidence 中 `Order.items` 的 write 命中数明显少于 read/总命中数;`driverSlotId` 与 `orderIds` 均有 write。判定与既有审计文档一致。

- [ ] **Step 3: 清理临时文件**

Run: `rm -f /tmp/evidence.json /tmp/stack.json /tmp/badstack.json && echo cleaned`
Expected: `cleaned`

- [ ] **Step 4: 最终产物清单核对**

Run: `find ~/.claude/skills/auditing-data-ownership -type f | sort`
Expected:
```
.../SKILL.md
.../adapters/prisma.md
.../references/ownership-matrix.md
.../references/refactor-decision.md
.../scripts/collect-evidence.mjs
.../scripts/detect-stack.mjs
```

---

## Self-Review

**1. Spec coverage**
- §1 定位/边界 → SKILL.md Overview + description(Task 5)✅
- §2 四步流程 → SKILL.md Process + 两脚本(Task 1/2/5)✅
- §3 四分类 + 两交叉信号 → SKILL.md 四分类 + adapters/prisma.md(Task 3/5)✅
- §4 两产出物 → references 两模板(Task 4)✅
- §5 文件结构 → 各 Task 创建路径一致 ✅
- §6 验收标准 → Task 6 端到端 + Task 1/2 的 veggie 断言 + 未知栈降级(Task 1 Step3 / Task 2 Step4)✅

**2. Placeholder scan**:无 TBD/TODO;脚本与文档均完整内容。✅

**3. Type consistency**:`detect-stack.mjs` 输出字段(`stack`/`schemaPath`/`scanDirs`)与 `collect-evidence.mjs` 消费一致;`evidence.json` 结构(`fields[].{model,field,hitCount,noisy,hits[].guess}`)在 Task 2 定义、Task 6 断言一致。✅

---

*计划落档。skill 文件写入全局目录,不进 veggie git。*
