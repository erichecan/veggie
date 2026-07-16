# 价格表多挂载 + 优先级 + default 模式改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让客户可以按优先级挂载多张价格表（第一张命中即用），并修正 `priceType='default'` 模式使其也先查价格表再回退牌价；价格表编辑页补显 Public Price 参考列；清理 3 个脏数据客户。

**Architecture:** 新增 `CustomerPricelist` 关联表（customerId, pricelistId, sequence）替代 `Customer.pricelistId` 单一字段。`lib/pricing-engine.ts` 新增链式解析函数，按 sequence 依次尝试价格表，命中即停。所有读写点（API、UI、种子脚本、Odoo 回填脚本）同步切到新表。分两阶段迁移（先建表双写窗口，代码全切完再删旧字段）以避免空档期报错。

**Tech Stack:** Next.js App Router, Prisma (Neon Postgres, driver adapter), TypeScript, node:test（内置测试跑者）, tsx。

## Global Constraints

- 数据库连接用 `.env.local` 的 `DATABASE_URL`（不是 `.env`，两者指向不同 Neon 实例，已在调研阶段确认）。
- 本项目 `prisma migrate dev` 因历史 shadow DB 重放失败，schema 变更一律用 `prisma db push` + 手写迁移，不用 `migrate dev`。
- 服务端定价永远是权威值，前端只做参考展示，改动不能削弱 `PRICE_TOLERANCE_EUR` 校验。
- `Order.pricelistId` / `Order.priceType` 字段不变（历史订单快照），本次只动 `Customer` 侧。
- `scripts/backfill-customer-pricelist.ts` 是另一项进行中但**尚未执行**的 Odoo 回填工作，本计划会直接改造它写入新表，避免其重新写入即将删除的 `Customer.pricelistId`。
- 涉及生产 Neon 库的写操作（迁移脚本 `--apply`、字段删除）必须先 dry-run 确认输出再执行，且需要用户明确同意后才能对生产库执行 `--apply` / 删列。

---

### Task 1: Schema — 新增 CustomerPricelist 表

**Files:**
- Modify: `prisma/schema.prisma:364-423`（Customer model）、`prisma/schema.prisma:505-518`（CustomerSpecialPrice 之后插入新 model）

**Interfaces:**
- Produces: `CustomerPricelist { id, customerId, pricelistId, sequence, createdAt }`，供后续所有任务读写。

- [ ] **Step 1: 在 `CustomerSpecialPrice` model 后面新增 `CustomerPricelist` model**

在 `prisma/schema.prisma` 第 518 行（`CustomerSpecialPrice` 的闭合 `}` 之后，`model OdooPricelist` 之前）插入：

```prisma
model CustomerPricelist {
  id          String   @id @default(cuid())
  customerId  String
  customer    Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)
  /// 价格表 ID（不设 FK 约束，沿用 Customer.pricelistId 原有的宽松引用惯例：
  /// 允许指向暂不存在的价格表，pricing-engine 会回退牌价而不是报错）
  pricelistId String
  /// 数字越小优先级越高，1 = 最高优先级
  sequence    Int
  createdAt   DateTime @default(now())

  @@unique([customerId, pricelistId])
  @@index([customerId, sequence])
}
```

- [ ] **Step 2: 在 Customer model 里加反向关系字段，删除旧 `pricelistId` 字段**

在 `prisma/schema.prisma:394` 把这一行：

```prisma
  pricelistId         String?
```

替换为：

```prisma
  pricelists          CustomerPricelist[]
```

同时删除 `prisma/schema.prisma:420` 的 `@@index([pricelistId])`（旧字段已不存在，索引也一并删除）。

> ⚠️ 这一步会让所有现在还在读 `customer.pricelistId` 的代码编译失败——这是**故意的**，后续任务会逐个改完。Task 1 提交后项目会暂时编译不过，属于本计划预期状态，直到 Task 2-9 全部完成才恢复绿色。如果你用 subagent-driven 执行，请提醒下一个 task 的执行者：在这之前项目不会编译通过。

- [ ] **Step 3: db push 建表（不删列，先双写窗口）**

先只加表不删列，跑：

```bash
git stash push -- prisma/schema.prisma  # 暂存"删 pricelistId"的改动
```

编辑 `prisma/schema.prisma`，暂时把 `pricelistId String?` 加回去（跟新的 `pricelists CustomerPricelist[]` 共存），即：

```prisma
  pricelistId         String?
  pricelists          CustomerPricelist[]
```

保留 `@@index([pricelistId])`。然后：

```bash
export DATABASE_URL=$(grep "^DATABASE_URL" .env.local | cut -d'"' -f2)
npx prisma db push
npx prisma generate
```

Expected: 输出 `Your database is now in sync with your Prisma schema.`，并生成新的 Prisma Client（含 `prisma.customerPricelist`）。

- [ ] **Step 4: 验证新表可读写**

```bash
npx tsx -e "
import { config } from 'dotenv'
config({ path: '.env.local' })
import { prisma } from './lib/db'
async function main() {
  const c = await prisma.customer.findFirst({ where: { pricelistId: { not: null } } })
  const row = await prisma.customerPricelist.create({ data: { customerId: c.id, pricelistId: c.pricelistId, sequence: 1 } })
  console.log('created:', row)
  await prisma.customerPricelist.delete({ where: { id: row.id } })
  console.log('cleaned up OK')
}
main().catch(e=>console.error('ERR',e.message)).finally(()=>prisma.\$disconnect())
"
```

Expected: 打印 `created: {...}` 和 `cleaned up OK`，无报错。

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "$(cat <<'EOF'
feat(db): 新增 CustomerPricelist 表，支持客户挂载多张价格表+优先级

Customer.pricelistId 暂时保留（双写窗口，等应用层代码全部切完新表后
再单独删除），先建表让后续任务能读写。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `lib/types.ts` — Customer 类型改造

**Files:**
- Modify: `lib/types.ts:157-201`

**Interfaces:**
- Consumes: 无
- Produces: `Customer.pricelists?: CustomerPricelistLink[]`，`CustomerPricelistLink { pricelistId: string; sequence: number }`。后续所有任务（引擎、API、UI）都用这个类型。

- [ ] **Step 1: 新增 `CustomerPricelistLink` 类型，替换 `Customer.pricelistId`**

把 `lib/types.ts:157-163` 这段：

```ts
// ─── 客户定价模式（对应 Odoo 的 price_type 概念）──────────────────────────────
/**
 * multi   — 走价格表引擎（75.2% 客户默认值）
 * default — 直接用商品牌价，忽略价格表
 * last    — 用该客户最近一次购买该商品的实际成交价
 */
export type CustomerPriceType = 'multi' | 'default' | 'last'
```

改成：

```ts
// ─── 客户定价模式（对应 Odoo 的 price_type 概念）──────────────────────────────
/**
 * multi   — 价格表链 → last price → 牌价，三级回退（75.2% 客户默认值）
 * default — 价格表链 → 牌价，两级回退（不查 last price）
 * last    — 用该客户最近一次购买该商品的实际成交价，与价格表无关
 */
export type CustomerPriceType = 'multi' | 'default' | 'last'

/** 客户挂载的一张价格表 + 优先级（数字越小优先级越高） */
export interface CustomerPricelistLink {
  pricelistId: string
  sequence: number
}
```

把 `lib/types.ts:188`（`pricelistId?: string` 那一行，在 `Customer` interface 内）：

```ts
  /** 关联价格表 ID（Odoo property_product_pricelist） */
  pricelistId?: string
```

改成：

```ts
  /** 客户挂载的价格表列表，按 sequence 升序 = 优先级从高到低。第一张命中即用，全部未命中才继续下一级（last price / 牌价） */
  pricelists?: CustomerPricelistLink[]
```

- [ ] **Step 2: 类型检查通过（预期仍会有其他文件报错，只确认这个文件本身没引入新错误）**

```bash
npx tsc --noEmit -p . 2>&1 | grep "lib/types.ts"
```

Expected: 无输出（这个文件本身没有类型错误；其他文件的错误留给后续任务处理）。

- [ ] **Step 3: Commit**

```bash
git add lib/types.ts
git commit -m "$(cat <<'EOF'
refactor(types): Customer.pricelistId 单值改为 pricelists 有序数组

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `lib/pricing-engine.ts` — 价格表链式解析

**Files:**
- Modify: `lib/pricing-engine.ts:228-336`（`resolveCustomerPrice`）
- Test: `tests/pricing-engine-multi-pricelist.test.ts`（新建）

**Interfaces:**
- Consumes: `Customer.pricelists: CustomerPricelistLink[]`（Task 2 产出）
- Produces: `resolveViaPricelistChain(product, orderedPricelists, allPricelists, qty): PriceResolution | null`，供 `resolveCustomerPrice` 内部调用；`resolveCustomerPrice` 签名不变（仍是 `(product, customer, allPricelists, qty, lastPrice)`），只是内部读 `customer.pricelists` 代替 `customer.pricelistId`。

- [ ] **Step 1: 写失败测试（新文件，纯函数测试，不需要数据库）**

创建 `tests/pricing-engine-multi-pricelist.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCustomerPrice } from '../lib/pricing-engine'
import type { Product, OdooPricelist, Customer } from '../lib/types'

const product: Product = {
  id: 'prod-1',
  templateId: 'tmpl-1',
  name: 'Test Tomato',
  listPrice: 10,
  standardPrice: 6,
  price: 10,
  variantAttributes: [],
  qtyOnHand: 0,
  active: true,
  images: [],
  createdAt: '',
  updatedAt: '',
} as unknown as Product

function pricelist(id: string, fixedPrice: number): OdooPricelist {
  return {
    id,
    name: id,
    currency: 'EUR',
    sequence: 1,
    selectable: true,
    active: true,
    updatedAt: '',
    items: [
      { applyOn: 'product', productTemplateId: 'tmpl-1', computeType: 'fixed', fixedPrice, minQty: 0, sequence: 1 },
    ],
  } as unknown as OdooPricelist
}

const plA = pricelist('pl-A', 7)   // 第一优先级：命中价 7
const plB = pricelist('pl-B', 5)   // 第二优先级：命中价 5（不该被用到，因为 A 已命中）
const plC_noMatch: OdooPricelist = {
  id: 'pl-C', name: 'pl-C', currency: 'EUR', sequence: 1, selectable: true, active: true, updatedAt: '',
  items: [], // 空规则，必定 fallback
} as unknown as OdooPricelist

function customer(overrides: Partial<Customer>): Customer {
  return { id: 'c1', name: 'Test', address: '', phone: '', email: '', vatNumber: '',
    paymentTerm: 'monthly', createdAt: '', specialPrices: [], ...overrides } as Customer
}

test('multi：客户挂 2 张表，第一张命中 → 用第一张的价，不查第二张', () => {
  const c = customer({ priceType: 'multi', pricelists: [{ pricelistId: 'pl-A', sequence: 1 }, { pricelistId: 'pl-B', sequence: 2 }] })
  const r = resolveCustomerPrice(product, c, [plA, plB], 1, 8)
  assert.equal(r.price, 7, '应该用价格表 A 的固定价 7，而不是 B 的 5 或 lastPrice 8')
  assert.equal(r.isFallback, false)
})

test('multi：客户挂 2 张表，第一张未命中(空规则)、第二张命中 → 用第二张', () => {
  const c = customer({ priceType: 'multi', pricelists: [{ pricelistId: 'pl-C', sequence: 1 }, { pricelistId: 'pl-B', sequence: 2 }] })
  const r = resolveCustomerPrice(product, c, [plC_noMatch, plB], 1, 8)
  assert.equal(r.price, 5, '第一张空规则未命中，应该继续查第二张，命中 5')
})

test('multi：两张表都未命中 → 查 last price', () => {
  const c = customer({ priceType: 'multi', pricelists: [{ pricelistId: 'pl-C', sequence: 1 }] })
  const r = resolveCustomerPrice(product, c, [plC_noMatch], 1, 8)
  assert.equal(r.price, 8, '价格表链全部未命中，应该回退 lastPrice 8')
  assert.equal(r.isFallback, false)
})

test('multi：两张表都未命中、无 lastPrice → 回退牌价', () => {
  const c = customer({ priceType: 'multi', pricelists: [{ pricelistId: 'pl-C', sequence: 1 }] })
  const r = resolveCustomerPrice(product, c, [plC_noMatch], 1, undefined)
  assert.equal(r.price, 10, '应该回退牌价 listPrice=10')
  assert.equal(r.isFallback, true)
})

test('default：价格表命中 → 用价格表价（不再是"忽略价格表"）', () => {
  const c = customer({ priceType: 'default', pricelists: [{ pricelistId: 'pl-A', sequence: 1 }] })
  const r = resolveCustomerPrice(product, c, [plA], 1, 8)
  assert.equal(r.price, 7, 'default 模式现在应该先查价格表，命中 7')
  assert.equal(r.isFallback, false)
})

test('default：价格表未命中 → 回退牌价，不查 lastPrice（这是 default 和 multi 的核心区别）', () => {
  const c = customer({ priceType: 'default', pricelists: [{ pricelistId: 'pl-C', sequence: 1 }] })
  const r = resolveCustomerPrice(product, c, [plC_noMatch], 1, 8)
  assert.equal(r.price, 10, 'default 未命中价格表时应直接回退牌价 10，不该用 lastPrice 8')
  assert.equal(r.isFallback, true)
})

test('default：客户没挂任何价格表 → 直接回退牌价', () => {
  const c = customer({ priceType: 'default', pricelists: [] })
  const r = resolveCustomerPrice(product, c, [], 1, 8)
  assert.equal(r.price, 10)
  assert.equal(r.isFallback, true)
})

test('last：即使挂了价格表也完全不查，直接用 lastPrice（行为不变）', () => {
  const c = customer({ priceType: 'last', pricelists: [{ pricelistId: 'pl-A', sequence: 1 }] })
  const r = resolveCustomerPrice(product, c, [plA], 1, 9)
  assert.equal(r.price, 9)
})

test('客户专属特殊价格：优先级高于价格表链（行为不变）', () => {
  const c = customer({
    priceType: 'multi',
    pricelists: [{ pricelistId: 'pl-A', sequence: 1 }],
    specialPrices: [{ id: 'sp1', productId: 'prod-1', minQty: 0, fixedPrice: 3.5 }],
  })
  const r = resolveCustomerPrice(product, c, [plA], 1, 8)
  assert.equal(r.price, 3.5, '专属特殊价应该覆盖价格表链和 lastPrice')
  assert.equal(r.isSpecialPrice, true)
})
```

- [ ] **Step 2: 跑测试确认失败（因为 resolveCustomerPrice 还没读 `pricelists`）**

```bash
node --test --import=tsx tests/pricing-engine-multi-pricelist.test.ts
```

Expected: 多个用例 FAIL（当前实现还在读 `customer.pricelistId` 单值，`customer.pricelists` 数组会被忽略，`default` 分支还是直接回退牌价而不查价格表）。

- [ ] **Step 3: 实现 `resolveViaPricelistChain` + 改造 `resolveCustomerPrice`**

在 `lib/pricing-engine.ts` 第 91 行（`resolvePrice` 函数结束）之后、`// ─── 内部工具 ───` 注释之前插入新函数：

```ts
/**
 * 按客户配置的价格表优先级链依次尝试，命中第一张就停。
 * @param orderedPricelistIds 已按 sequence 升序排好的 pricelistId 列表
 * @returns 命中的 PriceResolution；全部未命中返回 null（调用方决定下一步回退到哪）
 */
function resolveViaPricelistChain(
  product: Product,
  orderedPricelistIds: string[],
  allPricelists: OdooPricelist[],
  qty: number,
): PriceResolution | null {
  for (const plId of orderedPricelistIds) {
    const pl = allPricelists.find(p => p.id === plId)
    if (!pl) continue
    const r = resolvePrice(product, pl, allPricelists, qty)
    if (!r.isFallback) return r
  }
  return null
}
```

然后把 `lib/pricing-engine.ts:265-335` 的 `resolveCustomerPrice` 第二优先级分支（`default` / `last` / `multi` 三段）整体替换为：

```ts
  // ── 第二优先级：按 priceType 分支 ─────────────────────────────────────────

  const orderedPricelistIds = (customer.pricelists ?? [])
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map(link => link.pricelistId)

  // default：先查价格表链，未命中才回退牌价（不查 last price）
  if (priceType === 'default') {
    const viaChain = resolveViaPricelistChain(product, orderedPricelistIds, allPricelists, qty)
    if (viaChain) return viaChain
    return {
      price: round2(basePrice),
      pricelistName: orderedPricelistIds.length > 0 ? '价格表链未命中' : '直接牌价',
      itemDesc: orderedPricelistIds.length > 0
        ? '客户定价模式：先查价格表，未命中任何规则，回退牌价'
        : '客户定价模式：直接牌价（未挂价格表）',
      isFallback: true,
    }
  }

  // last：用该客户最近一笔成交价
  if (priceType === 'last') {
    if (lastPrice !== undefined && lastPrice > 0) {
      return {
        price: round2(lastPrice),
        pricelistName: '最近成交价',
        itemDesc: `最近一次售价 €${fmtMoney(lastPrice)}`,
        isFallback: false,
      }
    }
    // 若查不到历史成交价，回退牌价
    return {
      price: round2(basePrice),
      pricelistName: '最近成交价（无历史，回退牌价）',
      itemDesc: '该客户从未购买此商品，回退到牌价',
      isFallback: true,
    }
  }

  // multi（默认）：价格表链 → lastPrice → listPrice
  const viaChain = resolveViaPricelistChain(product, orderedPricelistIds, allPricelists, qty)
  if (viaChain) return viaChain

  if (lastPrice !== undefined && lastPrice > 0) {
    const fromDesc = orderedPricelistIds.length > 0 ? '价格表链未命中' : '无价格表'
    return {
      price: round2(lastPrice),
      pricelistName: '最近成交价',
      itemDesc: `${fromDesc}，改用最近售价 €${fmtMoney(lastPrice)}`,
      isFallback: false,
    }
  }

  return {
    price: round2(basePrice),
    pricelistName: '牌价',
    itemDesc: orderedPricelistIds.length > 0
      ? '价格表链未命中，且无历史成交价，使用牌价'
      : '客户未关联价格表，使用牌价',
    isFallback: true,
  }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
node --test --import=tsx tests/pricing-engine-multi-pricelist.test.ts
```

Expected: 全部 9 个用例 PASS。

- [ ] **Step 5: 跑现有 pricing 相关测试，确认没有回归（此时 `tests/pricing-override.test.ts` 会失败，因为它还在用旧 DB 字段，属于预期——留给 Task 4 修复）**

```bash
node --test --import=tsx tests/*.test.ts 2>&1 | tail -40
```

Expected: `pricing-engine-multi-pricelist.test.ts` 全绿；`pricing-override.test.ts` 报错（`prisma.customer.findFirst` 里 `pricelistId` 字段已被 Task 1 删除相关索引但列还在双写窗口内，实际会因为 `lib/server-pricing.ts` 还没改造导致类型或运行时错误）——记录下来，Task 4 会修。

- [ ] **Step 6: Commit**

```bash
git add lib/pricing-engine.ts tests/pricing-engine-multi-pricelist.test.ts
git commit -m "$(cat <<'EOF'
feat(pricing): 价格表按客户优先级链式解析，default 模式改为先查价格表

新增 resolveViaPricelistChain：按 sequence 依次尝试客户挂载的价格表，
命中第一张就停。default 模式行为从"完全忽略价格表"改为"价格表链→
牌价"两级回退（不查 last price，与 multi 模式的区别只在最后一步）。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `lib/server-pricing.ts` — 服务端定价适配 + 修复既有回归测试

**Files:**
- Modify: `lib/server-pricing.ts:60-106`（`loadCustomerFromRestaurantId`）、`lib/server-pricing.ts:170-357`（`resolveOrderLines`）
- Modify: `tests/pricing-override.test.ts`

**Interfaces:**
- Consumes: `resolveCustomerPrice`（Task 3 产出，签名不变）、`prisma.customerPricelist`（Task 1 产出）
- Produces: `resolveOrderLines` 的 `overrides.pricelistId`（单值，操作员本单临时选定的价格表，语义不变）仍然生效，内部转换成"链长度为 1 的临时链"喂给 `resolveCustomerPrice`；返回值里的 `pricelistId` 字段（写入 `Order.pricelistId` 快照）改为"生效链条中优先级最高的那一个"，未指定覆盖、客户也没挂价格表时为 `null`。

- [ ] **Step 1: 改 `loadCustomerFromRestaurantId`：查询带出 `pricelists` 关系**

在 `lib/server-pricing.ts:72-75`：

```ts
  const raw = await prisma.customer.findFirst({
    where: { id: customerId },
    include: { specialPrices: true },
  })
```

改成：

```ts
  const raw = await prisma.customer.findFirst({
    where: { id: customerId },
    include: {
      specialPrices: true,
      pricelists: { orderBy: { sequence: 'asc' } },
    },
  })
```

在 `lib/server-pricing.ts:93`：

```ts
    pricelistId: raw.pricelistId ?? undefined,
```

改成：

```ts
    pricelists: raw.pricelists.map((p) => ({ pricelistId: p.pricelistId, sequence: p.sequence })),
```

- [ ] **Step 2: 改 `resolveOrderLines` 的 override 处理**

在 `lib/server-pricing.ts:201-206`：

```ts
  // 本单覆盖：用操作员选定的价格表/定价模式参与权威定价（不写回客户档案）
  const effectiveCustomer: CustomerType = {
    ...customer,
    pricelistId: overrides?.pricelistId !== undefined ? overrides.pricelistId ?? undefined : customer.pricelistId,
    priceType: (overrides?.priceType ?? customer.priceType) as CustomerType['priceType'],
  }
```

改成：

```ts
  // 本单覆盖：操作员可临时选一张价格表代替客户档案的整条优先级链（不写回客户档案）。
  // overrides.pricelistId === undefined → 沿用客户档案的多价格表链
  // overrides.pricelistId 是字符串        → 本单只用这一张（临时链长度为 1）
  // overrides.pricelistId === null        → 本单明确不用价格表
  const effectivePricelists: CustomerType['pricelists'] =
    overrides?.pricelistId !== undefined
      ? (overrides.pricelistId ? [{ pricelistId: overrides.pricelistId, sequence: 1 }] : [])
      : customer.pricelists
  const effectiveCustomer: CustomerType = {
    ...customer,
    pricelists: effectivePricelists,
    priceType: (overrides?.priceType ?? customer.priceType) as CustomerType['priceType'],
  }
```

在 `lib/server-pricing.ts:349-356`（函数返回值）：

```ts
  return {
    lines,
    totalAmount: Math.round(total * 100) / 100,
    customer,
    pricelistId: effectiveCustomer.pricelistId ?? null,
    priceType: effectiveCustomer.priceType ?? null,
    warnings,
  }
```

改成：

```ts
  return {
    lines,
    totalAmount: Math.round(total * 100) / 100,
    customer,
    // Order.pricelistId 快照：生效链条里优先级最高的一张（跟旧行为一致——
    // 无论是否真的命中规则，都记录"当时配置/选定的价格表"，不是"最终用了哪条规则"）
    pricelistId: effectiveCustomer.pricelists?.[0]?.pricelistId ?? null,
    priceType: effectiveCustomer.priceType ?? null,
    warnings,
  }
```

- [ ] **Step 3: 更新 `tests/pricing-override.test.ts` 以匹配新 DB 结构**

把 `tests/pricing-override.test.ts:31-38`：

```ts
before(async () => {
  const cust = await prisma.customer.findFirst({
    where: { name: { contains: 'ABCT' } },
    select: { id: true, pricelistId: true },
  })
  assert.ok(cust, '测试前置：未找到 ABCT 客户')
  customerId = cust!.id
  customerDefaultPl = cust!.pricelistId
```

改成：

```ts
before(async () => {
  const cust = await prisma.customer.findFirst({
    where: { name: { contains: 'ABCT' } },
    select: { id: true, pricelists: { orderBy: { sequence: 'asc' }, select: { pricelistId: true } } },
  })
  assert.ok(cust, '测试前置：未找到 ABCT 客户')
  customerId = cust!.id
  customerDefaultPl = cust!.pricelists[0]?.pricelistId ?? null
```

其余断言（`assert.equal(pricelistId, customerDefaultPl, ...)` 等）不用改，因为它们比较的是 `resolveOrderLines` 的返回值和这个 `customerDefaultPl` 变量，两边语义保持一致（"客户档案里优先级最高的价格表"）。

> ⚠️ 这个测试需要真实 DB 里 ABCT 客户已经有 `CustomerPricelist` 记录（sequence=1 = 原来的 `pricelistId`）。此时 Task 8 的迁移脚本还没跑，这个测试会因为 `customerDefaultPl` 为 `null`（暂无数据）而在后续断言里失败或产生误导性通过（`null === null`）。**这一步先改代码结构，实际验证放到 Task 8 迁移脚本跑完之后**（Task 8 Step 5 会重跑这个测试文件）。

- [ ] **Step 4: 类型检查这两个改动的文件**

```bash
npx tsc --noEmit -p . 2>&1 | grep -E "lib/server-pricing.ts|tests/pricing-override.test.ts"
```

Expected: 无输出。

- [ ] **Step 5: Commit**

```bash
git add lib/server-pricing.ts tests/pricing-override.test.ts
git commit -m "$(cat <<'EOF'
feat(pricing): 服务端定价改用客户价格表优先级链，本单覆盖机制保持单值语义

resolveOrderLines 的 overrides.pricelistId 依旧是"操作员本单临时选一张
价格表"的单值覆盖；不覆盖时改为读客户档案的完整优先级链而不是单一
pricelistId。Order.pricelistId 快照字段含义调整为"生效链条里优先级
最高的一张"，与旧行为等价（都是"记录配置，不是记录命中结果"）。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `app/api/customers/route.ts` + `app/api/customers/[id]/route.ts` — CRUD 适配

**Files:**
- Modify: `app/api/customers/route.ts:66,107,114,124,144-164`
- Modify: `app/api/customers/[id]/route.ts:7-14,16-29,31-80`

**Interfaces:**
- Consumes: `prisma.customerPricelist`（Task 1）
- Produces: API 请求/响应体里 `Customer.pricelistId`（单值）替换为 `pricelistIds: string[]`（前端发送，按数组顺序 = 优先级顺序）与 `pricelists: {pricelistId, sequence}[]`（API 返回，供前端展示用）。

- [ ] **Step 1: `route.ts` 列表过滤条件改用关系过滤**

`app/api/customers/route.ts:66`：

```ts
    if (pricelistFilter) where.pricelistId = pricelistFilter
```

改成：

```ts
    if (pricelistFilter) where.pricelists = { some: { pricelistId: pricelistFilter } }
```

- [ ] **Step 2: `route.ts` 三处查询都带出 `pricelists` 关系**

`app/api/customers/route.ts:107`（slim select）：

```ts
          select: { id: true, name: true, email: true, phone: true, address: true, street: true, street2: true, city: true, zip: true, paymentTerm: true, pricelistId: true, priceType: true, creditLimit: true, isActive: true, salesUserId: true, salesUser: { select: { id: true, name: true } } },
```

改成：

```ts
          select: { id: true, name: true, email: true, phone: true, address: true, street: true, street2: true, city: true, zip: true, paymentTerm: true, pricelists: { select: { pricelistId: true, sequence: true }, orderBy: { sequence: 'asc' } }, priceType: true, creditLimit: true, isActive: true, salesUserId: true, salesUser: { select: { id: true, name: true } } },
```

`app/api/customers/route.ts:114` 和 `124`（两处 `include: { specialPrices: true, salesUser: ... }`）都改成：

```ts
        include: { specialPrices: true, pricelists: { orderBy: { sequence: 'asc' } }, salesUser: { select: { id: true, name: true } } },
```

- [ ] **Step 3: `route.ts` POST（创建客户）解析 `pricelistIds` 数组**

`app/api/customers/route.ts:144-156`：

```ts
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const { specialPrices, ...data } = await req.json()
      const customer = await prisma.customer.create({
        data: {
          ...data,
          specialPrices: specialPrices?.length
            ? { create: specialPrices.map(({ id: _id, customerId: _cid, ...sp }: any) => sp) }
            : undefined,
        },
        include: { specialPrices: true, salesUser: { select: { id: true, name: true } } },
      })
```

改成：

```ts
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const { specialPrices, pricelistIds, ...data } = await req.json()
      const customer = await prisma.customer.create({
        data: {
          ...data,
          specialPrices: specialPrices?.length
            ? { create: specialPrices.map(({ id: _id, customerId: _cid, ...sp }: any) => sp) }
            : undefined,
          pricelists: pricelistIds?.length
            ? { create: pricelistIds.map((pricelistId: string, idx: number) => ({ pricelistId, sequence: idx + 1 })) }
            : undefined,
        },
        include: { specialPrices: true, pricelists: { orderBy: { sequence: 'asc' } }, salesUser: { select: { id: true, name: true } } },
      })
```

- [ ] **Step 4: `[id]/route.ts` TRACKED_FIELDS + GET + PUT**

`app/api/customers/[id]/route.ts:7-14`：

```ts
const TRACKED_FIELDS = [
  'name', 'address', 'street', 'street2', 'city', 'state', 'zip', 'country',
  'phone', 'email', 'vatNumber', 'paymentTerm', 'creditLimit',
  'commissionRate', 'commissionFixed', 'pricelistId', 'priceType',
  'isActive', 'isCustomer', 'isVendor', 'notes', 'externalNote',
  'defaultDriverSlotId',  // P1-4: 客户默认司机绑定
  'salesUserId',
]
```

改成（把 `'pricelistId'` 换成 `'pricelistIds'`，这是个计算字段，Step 5 会填充）：

```ts
const TRACKED_FIELDS = [
  'name', 'address', 'street', 'street2', 'city', 'state', 'zip', 'country',
  'phone', 'email', 'vatNumber', 'paymentTerm', 'creditLimit',
  'commissionRate', 'commissionFixed', 'pricelistIds', 'priceType',
  'isActive', 'isCustomer', 'isVendor', 'notes', 'externalNote',
  'defaultDriverSlotId',  // P1-4: 客户默认司机绑定
  'salesUserId',
]
```

`app/api/customers/[id]/route.ts:16-29`（GET）：

```ts
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: { specialPrices: true, salesUser: { select: { id: true, name: true } } },
    })
```

改成：

```ts
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: { specialPrices: true, pricelists: { orderBy: { sequence: 'asc' } }, salesUser: { select: { id: true, name: true } } },
    })
```

- [ ] **Step 5: `[id]/route.ts` PUT — 整体替换 pricelists（mirror specialPrices 的 delete+recreate 模式）**

`app/api/customers/[id]/route.ts:31-74` 整段：

```ts
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const { specialPrices, ...data } = await req.json()
      // 旧值
      const before = await prisma.customer.findUnique({ where: { id } })
      if (!before) return NextResponse.json({ error: '客户不存在' }, { status: 404 })

      await prisma.customerSpecialPrice.deleteMany({ where: { customerId: id } })
      // 关于 street/street2/state/zip/country 这五个字段：
      // schema.prisma 已新增，但 prisma generate 需要在用户本地 macOS 执行。
      // 这里用 Record<string, unknown> 兜底，如果客户端尚未 generate，
      // 则这五个字段会被 Prisma 忽略（不会报错）。
      const updateData: Record<string, unknown> = {
        ...data,
        specialPrices: specialPrices?.length
          ? { create: specialPrices.map(({ id: _id, customerId: _cid, ...sp }: Record<string, unknown>) => sp) }
          : undefined,
      }
      // SSOT: address 由地址组件后端派生(前端不再权威拼接),保证与 street/.. 一致(P2)
      const b = before as unknown as Record<string, unknown>
      const pick = (k: string) => (data[k] !== undefined ? data[k] : b[k])
      updateData.address = ['street', 'street2', 'city', 'state', 'zip', 'country']
        .map((k) => String(pick(k) ?? '').trim()).filter(Boolean).join(', ')
      // 地址组件变更 → 清空经纬度,触发重新 geocode(否则坐标陈旧)
      const addrChanged = ['street', 'street2', 'city', 'state', 'zip', 'country']
        .some((k) => data[k] !== undefined && String(data[k] ?? '') !== String(b[k] ?? ''))
      if (addrChanged) { updateData.latitude = null; updateData.longitude = null }
      const customer = await prisma.customer.update({
        where: { id },
        data: updateData as Parameters<typeof prisma.customer.update>[0]['data'],
        include: { specialPrices: true, salesUser: { select: { id: true, name: true } } },
      })
      const changes = diffChanges(
        before as unknown as Record<string, unknown>,
        customer as unknown as Record<string, unknown>,
        TRACKED_FIELDS,
      )
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'customer', resourceId: id,
        detail: `更新客户: ${data.name || id}`,
        changes: Object.keys(changes).length > 0 ? changes : undefined })
      return NextResponse.json(serializeApi({ ...customer, salesman: customer.salesUser?.name ?? null }))
    } catch (error) {
      console.error('[PUT /api/customers/[id]]', error)
      return NextResponse.json({ error: '更新客户失败' }, { status: 500 })
    }
  })
}
```

改成：

```ts
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const { specialPrices, pricelistIds, ...data } = await req.json()
      // 旧值（带出 pricelists 关系，供 diffChanges 比对）
      const before = await prisma.customer.findUnique({
        where: { id },
        include: { pricelists: { orderBy: { sequence: 'asc' } } },
      })
      if (!before) return NextResponse.json({ error: '客户不存在' }, { status: 404 })

      await prisma.customerSpecialPrice.deleteMany({ where: { customerId: id } })
      if (pricelistIds !== undefined) {
        await prisma.customerPricelist.deleteMany({ where: { customerId: id } })
      }
      // 关于 street/street2/state/zip/country 这五个字段：
      // schema.prisma 已新增，但 prisma generate 需要在用户本地 macOS 执行。
      // 这里用 Record<string, unknown> 兜底，如果客户端尚未 generate，
      // 则这五个字段会被 Prisma 忽略（不会报错）。
      const updateData: Record<string, unknown> = {
        ...data,
        specialPrices: specialPrices?.length
          ? { create: specialPrices.map(({ id: _id, customerId: _cid, ...sp }: Record<string, unknown>) => sp) }
          : undefined,
        pricelists: pricelistIds?.length
          ? { create: pricelistIds.map((pricelistId: string, idx: number) => ({ pricelistId, sequence: idx + 1 })) }
          : undefined,
      }
      // SSOT: address 由地址组件后端派生(前端不再权威拼接),保证与 street/.. 一致(P2)
      const b = before as unknown as Record<string, unknown>
      const pick = (k: string) => (data[k] !== undefined ? data[k] : b[k])
      updateData.address = ['street', 'street2', 'city', 'state', 'zip', 'country']
        .map((k) => String(pick(k) ?? '').trim()).filter(Boolean).join(', ')
      // 地址组件变更 → 清空经纬度,触发重新 geocode(否则坐标陈旧)
      const addrChanged = ['street', 'street2', 'city', 'state', 'zip', 'country']
        .some((k) => data[k] !== undefined && String(data[k] ?? '') !== String(b[k] ?? ''))
      if (addrChanged) { updateData.latitude = null; updateData.longitude = null }
      const customer = await prisma.customer.update({
        where: { id },
        data: updateData as Parameters<typeof prisma.customer.update>[0]['data'],
        include: { specialPrices: true, pricelists: { orderBy: { sequence: 'asc' } }, salesUser: { select: { id: true, name: true } } },
      })
      const beforeWithPricelistIds = { ...before, pricelistIds: before.pricelists.map(p => p.pricelistId) } as unknown as Record<string, unknown>
      const afterWithPricelistIds = { ...customer, pricelistIds: customer.pricelists.map(p => p.pricelistId) } as unknown as Record<string, unknown>
      const changes = diffChanges(beforeWithPricelistIds, afterWithPricelistIds, TRACKED_FIELDS)
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'customer', resourceId: id,
        detail: `更新客户: ${data.name || id}`,
        changes: Object.keys(changes).length > 0 ? changes : undefined })
      return NextResponse.json(serializeApi({ ...customer, salesman: customer.salesUser?.name ?? null }))
    } catch (error) {
      console.error('[PUT /api/customers/[id]]', error)
      return NextResponse.json({ error: '更新客户失败' }, { status: 500 })
    }
  })
}
```

- [ ] **Step 6: 类型检查**

```bash
npx tsc --noEmit -p . 2>&1 | grep -E "app/api/customers"
```

Expected: 无输出。

- [ ] **Step 7: Commit**

```bash
git add app/api/customers/route.ts "app/api/customers/[id]/route.ts"
git commit -m "$(cat <<'EOF'
feat(api): customers CRUD 支持有序多价格表（pricelistIds 数组）

列表过滤、slim/full 查询都带出 pricelists 关系；PUT 整体替换客户的
价格表列表（数量通常 1-3 条，不做增量 diff，与 specialPrices 现有
模式一致）。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `app/api/pricelists/[id]/route.ts` — 删除价格表前的引用检查

**Files:**
- Modify: `app/api/pricelists/[id]/route.ts:196`

**Interfaces:**
- Consumes: `prisma.customerPricelist`（Task 1）

- [ ] **Step 1: 改引用检查查询**

`app/api/pricelists/[id]/route.ts:196`：

```ts
      const inUse = await prisma.customer.count({ where: { pricelistId: id } })
```

改成：

```ts
      const inUse = await prisma.customerPricelist.count({ where: { pricelistId: id } })
```

- [ ] **Step 2: 验证**

```bash
npx tsc --noEmit -p . 2>&1 | grep "app/api/pricelists"
```

Expected: 无输出。

- [ ] **Step 3: Commit**

```bash
git add "app/api/pricelists/[id]/route.ts"
git commit -m "$(cat <<'EOF'
fix(api): 删除价格表前的引用检查改查 CustomerPricelist 关联表

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 客户编辑页 — 价格表优先级列表 UI

**Files:**
- Modify: `app/[locale]/classic/operator/customers/[id]/page.tsx:55-138,797-804`

**Interfaces:**
- Consumes: `Customer.pricelists`（Task 2）、`PUT /api/customers/[id]` 的 `pricelistIds` 字段（Task 5）

- [ ] **Step 1: FormState 类型 + 空表单 + `customerToForm` 映射**

`app/[locale]/classic/operator/customers/[id]/page.tsx:61`：

```ts
  pricelistId: string
```

改成：

```ts
  pricelistIds: string[]
```

`app/[locale]/classic/operator/customers/[id]/page.tsx:85`：

```ts
    paymentTerm: '', pricelistId: '', defaultDriverSlotId: '',
```

改成：

```ts
    paymentTerm: '', pricelistIds: [], defaultDriverSlotId: '',
```

`app/[locale]/classic/operator/customers/[id]/page.tsx:127`：

```ts
    pricelistId: c.pricelistId ?? '',
```

改成：

```ts
    pricelistIds: (c.pricelists ?? []).slice().sort((a, b) => a.sequence - b.sequence).map(p => p.pricelistId),
```

- [ ] **Step 2: 保存逻辑**

`app/[locale]/classic/operator/customers/[id]/page.tsx:307`：

```ts
      pricelistId: form.pricelistId || undefined,
```

改成：

```ts
      pricelistIds: form.pricelistIds,
```

- [ ] **Step 3: UI — 单选下拉换成优先级列表 + 上下箭头 + 添加下拉**

`app/[locale]/classic/operator/customers/[id]/page.tsx:797-804`：

```tsx
                <OdooField label="Pricelist">
                  <select value={form.pricelistId} onChange={e => setField('pricelistId', e.target.value)} className={selectCls}>
                    <option value=""></option>
                    {pricelists.map(pl => (
                      <option key={pl.id} value={pl.id}>{pl.name}</option>
                    ))}
                  </select>
                </OdooField>
```

改成：

```tsx
                <OdooField label="Pricelists" wide>
                  <div className="space-y-1">
                    {form.pricelistIds.length === 0 && (
                      <p className="text-xs text-gray-400 py-1">{isEn ? 'No pricelist assigned' : '未挂载价格表'}</p>
                    )}
                    {form.pricelistIds.map((plId, idx) => {
                      const pl = pricelists.find(p => p.id === plId)
                      return (
                        <div key={plId} className="flex items-center gap-2 border border-gray-200 rounded px-2 py-1">
                          <span className="text-xs text-gray-400 w-4 text-right">{idx + 1}</span>
                          <span className="flex-1 text-sm text-gray-800 truncate">{pl?.name ?? plId}</span>
                          <button
                            type="button"
                            disabled={idx === 0}
                            onClick={() => {
                              const next = [...form.pricelistIds]
                              ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
                              setField('pricelistIds', next)
                            }}
                            className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-gray-800 disabled:opacity-30 disabled:cursor-not-allowed"
                            title={isEn ? 'Move up (higher priority)' : '上移（优先级更高）'}
                          >↑</button>
                          <button
                            type="button"
                            disabled={idx === form.pricelistIds.length - 1}
                            onClick={() => {
                              const next = [...form.pricelistIds]
                              ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
                              setField('pricelistIds', next)
                            }}
                            className="w-6 h-6 flex items-center justify-center text-gray-500 hover:text-gray-800 disabled:opacity-30 disabled:cursor-not-allowed"
                            title={isEn ? 'Move down (lower priority)' : '下移（优先级更低）'}
                          >↓</button>
                          <button
                            type="button"
                            onClick={() => setField('pricelistIds', form.pricelistIds.filter(id => id !== plId))}
                            className="w-6 h-6 flex items-center justify-center text-gray-300 hover:text-red-500"
                            title={isEn ? 'Remove' : '移除'}
                          >×</button>
                        </div>
                      )
                    })}
                    <select
                      value=""
                      onChange={e => {
                        const val = e.target.value
                        if (val && !form.pricelistIds.includes(val)) {
                          setField('pricelistIds', [...form.pricelistIds, val])
                        }
                      }}
                      className={selectCls}
                    >
                      <option value="">{isEn ? '+ Add a pricelist…' : '+ 添加价格表…'}</option>
                      {pricelists.filter(pl => !form.pricelistIds.includes(pl.id)).map(pl => (
                        <option key={pl.id} value={pl.id}>{pl.name}</option>
                      ))}
                    </select>
                  </div>
                </OdooField>
```

- [ ] **Step 4: 类型检查**

```bash
npx tsc --noEmit -p . 2>&1 | grep "customers/\[id\]/page.tsx"
```

Expected: 无输出。

- [ ] **Step 5: 手动验证（本地起 dev server 后在浏览器操作，或用 curl 验证保存的数据结构）**

```bash
npm run dev &
sleep 3
curl -s http://localhost:3000/classic/operator/customers/new -o /dev/null -w "status=%{http_code}\n"
```

Expected: `status=200`（页面能正常渲染，不是编译错误页）。之后在浏览器里打开任意客户详情页，Sales & Purchases tab，确认 Pricelist 区域变成了列表+上下箭头+添加下拉，添加两个价格表、调整顺序、保存后刷新页面顺序保留。

- [ ] **Step 6: Commit**

```bash
git add "app/[locale]/classic/operator/customers/[id]/page.tsx"
git commit -m "$(cat <<'EOF'
feat(ui): 客户编辑页价格表改为优先级列表（上/下箭头调序）

单选下拉替换为已选列表，每行可上移/下移/删除，列表下方下拉添加新
价格表。客户通常只挂 1-3 张，箭头交互足够，不引入拖拽库。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 迁移脚本 — 改造 Odoo 回填脚本 + 新建历史数据迁移脚本

**Files:**
- Modify: `scripts/backfill-customer-pricelist.ts`
- Create: `scripts/migrate-customer-pricelist-priority-20260715.ts`

**Interfaces:**
- Consumes: `prisma.customerPricelist`（Task 1）、`Customer.pricelistId`（仍在双写窗口内存在）

- [ ] **Step 1: 改造 `scripts/backfill-customer-pricelist.ts` 写入新表**

把 `scripts/backfill-customer-pricelist.ts:87-90`：

```ts
  const allCusts = await prisma.customer.findMany({
    where: { NOT: { externalId: null } },
    select: { id: true, name: true, externalId: true, pricelistId: true },
  })
```

改成：

```ts
  const allCusts = await prisma.customer.findMany({
    where: { NOT: { externalId: null } },
    select: { id: true, name: true, externalId: true, pricelists: { orderBy: { sequence: 'asc' }, select: { pricelistId: true } } },
  })
```

把 `scripts/backfill-customer-pricelist.ts:92-102`：

```ts
  const fillNull: { id: string; name: string; pricelistId: string }[] = []
  const fixNewPl: { id: string; name: string; from: string | null; pricelistId: string }[] = []
  for (const c of allCusts) {
    const mapped = c.externalId ? csvMap.get(c.externalId) : undefined
    if (!mapped) continue
    if (c.pricelistId === null) {
      fillNull.push({ id: c.id, name: c.name, pricelistId: mapped.plId })
    } else if (c.pricelistId !== mapped.plId && newPlLocalIds.has(mapped.plId)) {
      fixNewPl.push({ id: c.id, name: c.name, from: c.pricelistId, pricelistId: mapped.plId })
    }
  }
```

改成：

```ts
  const fillNull: { id: string; name: string; pricelistId: string }[] = []
  const fixNewPl: { id: string; name: string; from: string | null; pricelistId: string }[] = []
  for (const c of allCusts) {
    const mapped = c.externalId ? csvMap.get(c.externalId) : undefined
    if (!mapped) continue
    const currentTopPl = c.pricelists[0]?.pricelistId ?? null
    if (currentTopPl === null) {
      fillNull.push({ id: c.id, name: c.name, pricelistId: mapped.plId })
    } else if (currentTopPl !== mapped.plId && newPlLocalIds.has(mapped.plId)) {
      fixNewPl.push({ id: c.id, name: c.name, from: currentTopPl, pricelistId: mapped.plId })
    }
  }
```

把 `scripts/backfill-customer-pricelist.ts:116-127`：

```ts
  const toApply = [...fillNull, ...fixNewPl.map(u => ({ id: u.id, name: u.name, pricelistId: u.pricelistId }))]
  console.log(`\n[APPLY] 开始回填/修正 ${toApply.length} 个客户…`)
  const BATCH = 50
  let done = 0
  for (let i = 0; i < toApply.length; i += BATCH) {
    const batch = toApply.slice(i, i + BATCH)
    await Promise.all(batch.map(u =>
      prisma.customer.update({ where: { id: u.id }, data: { pricelistId: u.pricelistId } }),
    ))
    done += batch.length
    if (done % 200 === 0 || done === toApply.length) console.log(`  …${done}/${toApply.length}`)
  }
  console.log(`✅ 完成：处理 ${done} 个客户的默认价格表`)
```

改成：

```ts
  const toApply = [...fillNull, ...fixNewPl.map(u => ({ id: u.id, name: u.name, pricelistId: u.pricelistId }))]
  console.log(`\n[APPLY] 开始回填/修正 ${toApply.length} 个客户的优先级第一价格表…`)
  const BATCH = 50
  let done = 0
  for (let i = 0; i < toApply.length; i += BATCH) {
    const batch = toApply.slice(i, i + BATCH)
    await Promise.all(batch.map(u =>
      // fillNull: 客户此前没有任何 CustomerPricelist 记录 → 直接建 sequence=1
      // fixNewPl: 客户已有 sequence=1 记录但指向错误的表 → 先删再建，保持 sequence=1 不变
      prisma.$transaction([
        prisma.customerPricelist.deleteMany({ where: { customerId: u.id, sequence: 1 } }),
        prisma.customerPricelist.create({ data: { customerId: u.id, pricelistId: u.pricelistId, sequence: 1 } }),
      ]),
    ))
    done += batch.length
    if (done % 200 === 0 || done === toApply.length) console.log(`  …${done}/${toApply.length}`)
  }
  console.log(`✅ 完成：处理 ${done} 个客户的优先级第一价格表`)
```

同时把文件头注释 `scripts/backfill-customer-pricelist.ts:1-21` 里的 `回填客户默认价格表(Customer.pricelistId)` 改成 `回填客户价格表优先级第一位（CustomerPricelist.sequence=1）`，说明这次改版原因（不重复贴全文，只改这一句描述性文字）。

- [ ] **Step 2: 新建通用迁移脚本，把剩余客户的 `Customer.pricelistId` 迁到新表 + 修 3 个脏数据**

创建 `scripts/migrate-customer-pricelist-priority-20260715.ts`：

```ts
/**
 * scripts/migrate-customer-pricelist-priority-20260715.ts
 *
 * 一次性迁移：把 Customer.pricelistId（单值，即将废弃）迁移成
 * CustomerPricelist{sequence:1}（客户挂载多价格表+优先级的第一步）。
 *
 * 幂等：跳过已经有 CustomerPricelist 记录的客户（可能是
 * backfill-customer-pricelist.ts 或本脚本之前已经处理过的）。
 *
 * 同时修正 3 个历史脏数据客户：priceType='pricelist'（非法枚举值，
 * 只有 multi/default/last 合法）→ 有挂价格表的改 multi，没挂的改 default。
 *
 * 运行：
 *   DATABASE_URL=$(grep "^DATABASE_URL" .env.local | cut -d'"' -f2) \
 *     npx tsx scripts/migrate-customer-pricelist-priority-20260715.ts            # dry-run
 *   DATABASE_URL=$(grep "^DATABASE_URL" .env.local | cut -d'"' -f2) \
 *     npx tsx scripts/migrate-customer-pricelist-priority-20260715.ts --apply    # 实际写入
 */
import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'

neonConfig.webSocketConstructor = ws
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })

const APPLY = process.argv.includes('--apply')

async function main() {
  // ── 第一部分：pricelistId → CustomerPricelist{sequence:1} ──
  const customersWithPl = await prisma.customer.findMany({
    where: { pricelistId: { not: null } },
    select: { id: true, name: true, pricelistId: true, pricelists: { select: { id: true } } },
  })
  const toMigrate = customersWithPl.filter(c => c.pricelists.length === 0)
  const alreadyDone = customersWithPl.length - toMigrate.length

  console.log('── 价格表优先级迁移 ──')
  console.log(`  有 pricelistId 的客户: ${customersWithPl.length}`)
  console.log(`  已有 CustomerPricelist 记录（跳过）: ${alreadyDone}`)
  console.log(`  待迁移: ${toMigrate.length}`)

  // ── 第二部分：修 3 个 priceType='pricelist' 脏数据 ──
  const dirtyCustomers = await prisma.customer.findMany({
    where: { priceType: 'pricelist' },
    select: { id: true, name: true, pricelistId: true },
  })
  console.log(`\n── 脏数据 priceType='pricelist' ──`)
  console.log(`  待修正: ${dirtyCustomers.length}`)
  for (const c of dirtyCustomers) {
    const fixTo = c.pricelistId ? 'multi' : 'default'
    console.log(`    ${c.name} (${c.id}): pricelist → ${fixTo}（${c.pricelistId ? '有挂价格表' : '未挂价格表'}）`)
  }

  if (!APPLY) {
    console.log('\n[DRY-RUN] 未写入。加 --apply 实际执行。')
    return
  }

  const BATCH = 50
  let done = 0
  for (let i = 0; i < toMigrate.length; i += BATCH) {
    const batch = toMigrate.slice(i, i + BATCH)
    await Promise.all(batch.map(c =>
      prisma.customerPricelist.create({
        data: { customerId: c.id, pricelistId: c.pricelistId!, sequence: 1 },
      }),
    ))
    done += batch.length
    if (done % 200 === 0 || done === toMigrate.length) console.log(`  …${done}/${toMigrate.length}`)
  }
  console.log(`✅ 迁移完成：${done} 个客户`)

  for (const c of dirtyCustomers) {
    const fixTo = c.pricelistId ? 'multi' : 'default'
    await prisma.customer.update({ where: { id: c.id }, data: { priceType: fixTo } })
  }
  console.log(`✅ 脏数据修正完成：${dirtyCustomers.length} 个客户`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
```

- [ ] **Step 2b: dry-run 两个脚本，确认输出合理**

```bash
export DATABASE_URL=$(grep "^DATABASE_URL" .env.local | cut -d'"' -f2)
npx tsx scripts/backfill-customer-pricelist.ts
npx tsx scripts/migrate-customer-pricelist-priority-20260715.ts
```

Expected: 两个脚本都以 `[DRY-RUN] 未写入` 结尾；`migrate-customer-pricelist-priority` 的输出显示"待迁移"人数接近 1526（调研阶段查到的有 pricelistId 客户数），"脏数据待修正"显示 3 条，并且列出每条要改成 `multi` 还是 `default`。

- [ ] **Step 3: 把 dry-run 结果拿给用户过目，获得明确同意后再执行 --apply**

> ⛔ 这一步涉及生产库写入（1500+ 客户 + 3 条脏数据），必须先把上一步的完整 dry-run 输出贴给用户看，用户明确回复"可以执行"之后才能加 `--apply` 跑。不允许因为"dry-run 看起来正常"就自行决定直接 apply。

- [ ] **Step 4: （获得同意后）实际执行迁移**

```bash
export DATABASE_URL=$(grep "^DATABASE_URL" .env.local | cut -d'"' -f2)
npx tsx scripts/backfill-customer-pricelist.ts --apply
npx tsx scripts/migrate-customer-pricelist-priority-20260715.ts --apply
```

Expected: 两个脚本都打印 `✅ 完成`，无报错退出。

- [ ] **Step 5: 迁移后重跑 Task 4 更新过的回归测试，确认真实数据下行为正确**

```bash
node --test --import=tsx tests/pricing-override.test.ts
```

Expected: 3 个用例全部 PASS（此时 ABCT 客户已经有真实的 `CustomerPricelist` 记录）。

- [ ] **Step 6: 抽查验证 —— 迁移前后同一客户的定价结果应该不变**

```bash
export DATABASE_URL=$(grep "^DATABASE_URL" .env.local | cut -d'"' -f2)
npx tsx -e "
import { prisma } from './lib/db'
import { resolveOrderLines } from './lib/server-pricing'
async function main() {
  const cust = await prisma.customer.findFirst({ where: { pricelists: { some: {} } } })
  const product = await prisma.product.findFirst({ where: { listPrice: { gt: 0 } } })
  const { lines } = await resolveOrderLines({ prisma, restaurantId: cust.id }, [{ productId: product.id, quantity: 1, price: 0 }])
  console.log('customer:', cust.name, 'product:', product.name, '-> price:', lines[0].authoritativeUnitPrice)
}
main().catch(e=>console.error('ERR',e.message)).finally(()=>prisma.\$disconnect())
"
```

Expected: 打印出一个合理的单价（不报错、不是 NaN），人工核对这个客户在 Odoo/后台看到的历史价格是否一致（迁移只是换存储结构，不应该改变任何客户当前已生效的价格）。

- [ ] **Step 7: Commit**

```bash
git add scripts/backfill-customer-pricelist.ts scripts/migrate-customer-pricelist-priority-20260715.ts
git commit -m "$(cat <<'EOF'
feat(scripts): Odoo 回填脚本改写新表 + 新建历史数据迁移脚本

backfill-customer-pricelist.ts 原本直接写 Customer.pricelistId（即将
废弃），改为写 CustomerPricelist(sequence=1)。新增迁移脚本把现有
1526 个客户的 pricelistId 批量迁到新表，并修正 3 个 priceType='pricelist'
的历史脏数据。均支持 dry-run，已在生产库验证定价结果迁移前后一致。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 剩余 UI/种子文件适配（place-order、pricelists 编辑页 Public Price 列、种子脚本）

**Files:**
- Modify: `app/[locale]/classic/operator/place-order/page.tsx:380-384`
- Modify: `app/[locale]/classic/operator/pricelists/[id]/page.tsx:616-660,775-823,845-933`
- Modify: `app/[locale]/classic/operator/customers/page.tsx:84-126,198,215,220`
- Modify: `lib/seed-customers.ts:6-57`、`prisma/csv-loader.ts:150-256`、`prisma/seed.ts:242-300`

**Interfaces:**
- Consumes: `Customer.pricelists`（Task 2）

- [ ] **Step 1: place-order 页 `effectiveCustomer` 改用链**

`app/[locale]/classic/operator/place-order/page.tsx:380-384`：

```ts
  const effectiveCustomer = useMemo(() => {
    const base = selectedCustomerFull?.id === customerId ? selectedCustomerFull : customer
    // 本单选定的价格表优先于客户档案默认值（操作员可临时切换价格体系）
    return base ? { ...base, priceType, pricelistId: pricelistId || base.pricelistId } : null
  }, [customer, selectedCustomerFull, customerId, priceType, pricelistId])
```

改成：

```ts
  const effectiveCustomer = useMemo(() => {
    const base = selectedCustomerFull?.id === customerId ? selectedCustomerFull : customer
    // 本单选定的价格表优先于客户档案的价格表优先级链（操作员可临时切换价格体系）
    return base
      ? { ...base, priceType, pricelists: pricelistId ? [{ pricelistId, sequence: 1 }] : base.pricelists }
      : null
  }, [customer, selectedCustomerFull, customerId, priceType, pricelistId])
```

`app/[locale]/classic/operator/place-order/page.tsx:605`：

```ts
    if (c.pricelistId) setPricelistId(c.pricelistId)
```

改成：

```ts
    if (c.pricelists?.[0]?.pricelistId) setPricelistId(c.pricelists[0].pricelistId)
```

- [ ] **Step 2: 价格表编辑页 — 表格加 Public Price 列**

`app/[locale]/classic/operator/pricelists/[id]/page.tsx:616-625`（表头）：

```tsx
                <thead style={{ background: '#f5f5f5', borderBottom: '1px solid #ddd' }}>
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-gray-600">Applicable On</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Min. Quantity</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Start Date</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">End Date</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600 min-w-[160px]">Price</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Price Discount</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Variant Cost</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Template Cost</th>
                    {editMode && <th className="w-8 px-3 py-2" />}
                  </tr>
                </thead>
```

改成（在 Template Cost 后面加 Public Price 列）：

```tsx
                <thead style={{ background: '#f5f5f5', borderBottom: '1px solid #ddd' }}>
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-gray-600">Applicable On</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Min. Quantity</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">Start Date</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600">End Date</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600 min-w-[160px]">Price</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Price Discount</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Variant Cost</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Template Cost</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-600">Public Price</th>
                    {editMode && <th className="w-8 px-3 py-2" />}
                  </tr>
                </thead>
```

`app/[locale]/classic/operator/pricelists/[id]/page.tsx:635-657`（计算 templateCost/variantCost 那段 + ItemRow 调用）：

```tsx
                  {pagedItems.map(item => {
                    const templateCost = item.applyOn === 'product'
                      ? templates.find(t => t.id === item.productTemplateId)?.standardPrice
                      : undefined
                    const variantCost = item.applyOn === 'variant'
                      ? products.find(p => p.id === item.productVariantId)?.standardPrice
                      : undefined
                    return (
                      <ItemRow
                        key={item.id}
                        item={item}
                        templates={templates}
                        products={products}
                        categories={categories}
                        templateCost={templateCost}
                        variantCost={variantCost}
                        showDelete={editMode}
                        onEdit={() => openEditItem(item)}
                        onDelete={() => handleDeleteItem(item.id)}
                        isEn={isEn}
                      />
                    )
                  })}
```

改成：

```tsx
                  {pagedItems.map(item => {
                    const templateCost = item.applyOn === 'product'
                      ? templates.find(t => t.id === item.productTemplateId)?.standardPrice
                      : undefined
                    const variantCost = item.applyOn === 'variant'
                      ? products.find(p => p.id === item.productVariantId)?.standardPrice
                      : undefined
                    const publicPrice = item.applyOn === 'variant'
                      ? products.find(p => p.id === item.productVariantId)?.listPrice
                      : item.applyOn === 'product'
                        ? templates.find(t => t.id === item.productTemplateId)?.listPrice
                        : undefined
                    return (
                      <ItemRow
                        key={item.id}
                        item={item}
                        templates={templates}
                        products={products}
                        categories={categories}
                        templateCost={templateCost}
                        variantCost={variantCost}
                        publicPrice={publicPrice}
                        showDelete={editMode}
                        onEdit={() => openEditItem(item)}
                        onDelete={() => handleDeleteItem(item.id)}
                        isEn={isEn}
                      />
                    )
                  })}
```

`app/[locale]/classic/operator/pricelists/[id]/page.tsx:630-634`（空态 colSpan，从 8/9 改成 9/10）：

```tsx
                  {pagedItems.length === 0 && (
                    <tr>
                      <td colSpan={editMode ? 9 : 8} className="px-4 py-3 text-gray-400 italic text-xs">{isEn ? 'No items yet' : '暂无条目'}</td>
                    </tr>
                  )}
```

改成：

```tsx
                  {pagedItems.length === 0 && (
                    <tr>
                      <td colSpan={editMode ? 10 : 9} className="px-4 py-3 text-gray-400 italic text-xs">{isEn ? 'No items yet' : '暂无条目'}</td>
                    </tr>
                  )}
```

- [ ] **Step 3: `ItemRow` 组件加 `publicPrice` prop 和单元格**

`app/[locale]/classic/operator/pricelists/[id]/page.tsx:775-823`（整个 `ItemRow`）：

```tsx
function ItemRow({ item, templates, products, categories, templateCost, variantCost, showDelete, onEdit, onDelete, isEn }: {
  item: OdooPricelistItem
  templates: ProductTemplate[]
  products: Product[]
  categories: ProductCategory[]
  templateCost: number | undefined
  variantCost: number | undefined
  showDelete: boolean
  onEdit: () => void
  onDelete: () => void
  isEn: boolean
}) {
  const [hover, setHover] = useState(false)

  const priceText = item.computeType === 'fixed'
    ? `€${(item.fixedPrice ?? 0).toFixed(2)}`
    : item.computeType === 'formula'
      ? `${(item.priceDiscount ?? 0).toFixed(1)} % discount and ${(item.priceSurcharge ?? 0).toFixed(1)} surcharge`
      : ''

  const discountText = item.computeType === 'percentage' ? `${item.percentDiscount ?? 0}%` : ''

  return (
    <tr
      style={{ background: hover ? PURPLE_LIGHT : undefined, cursor: 'pointer', borderBottom: '1px solid #f0f0f0' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onEdit}
    >
      <td className="px-4 py-1.5 text-gray-800">{applyOnLabel(item, templates, products, categories, isEn)}</td>
      <td className="px-3 py-1.5 text-right text-gray-600">{item.minQty}</td>
      <td className="px-3 py-1.5 text-gray-500">{item.dateStart ?? ''}</td>
      <td className="px-3 py-1.5 text-gray-500">{item.dateEnd ?? ''}</td>
      <td className="px-3 py-1.5 text-right text-gray-800">{priceText}</td>
      <td className="px-3 py-1.5 text-right text-gray-500">{discountText}</td>
      <td className="px-3 py-1.5 text-right text-gray-500">
        {variantCost !== undefined ? variantCost.toFixed(2) : ''}
      </td>
      <td className="px-3 py-1.5 text-right text-gray-500">
        {templateCost !== undefined ? templateCost.toFixed(2) : ''}
      </td>
      {showDelete && (
        <td className="px-3 py-1.5 text-center" onClick={e => { e.stopPropagation(); onDelete() }}>
          <span className="text-gray-300 hover:text-red-400 text-base leading-none cursor-pointer select-none">🗑</span>
        </td>
      )}
    </tr>
  )
}
```

改成：

```tsx
function ItemRow({ item, templates, products, categories, templateCost, variantCost, publicPrice, showDelete, onEdit, onDelete, isEn }: {
  item: OdooPricelistItem
  templates: ProductTemplate[]
  products: Product[]
  categories: ProductCategory[]
  templateCost: number | undefined
  variantCost: number | undefined
  publicPrice: number | undefined
  showDelete: boolean
  onEdit: () => void
  onDelete: () => void
  isEn: boolean
}) {
  const [hover, setHover] = useState(false)

  const priceText = item.computeType === 'fixed'
    ? `€${(item.fixedPrice ?? 0).toFixed(2)}`
    : item.computeType === 'formula'
      ? `${(item.priceDiscount ?? 0).toFixed(1)} % discount and ${(item.priceSurcharge ?? 0).toFixed(1)} surcharge`
      : ''

  const discountText = item.computeType === 'percentage' ? `${item.percentDiscount ?? 0}%` : ''

  return (
    <tr
      style={{ background: hover ? PURPLE_LIGHT : undefined, cursor: 'pointer', borderBottom: '1px solid #f0f0f0' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onEdit}
    >
      <td className="px-4 py-1.5 text-gray-800">{applyOnLabel(item, templates, products, categories, isEn)}</td>
      <td className="px-3 py-1.5 text-right text-gray-600">{item.minQty}</td>
      <td className="px-3 py-1.5 text-gray-500">{item.dateStart ?? ''}</td>
      <td className="px-3 py-1.5 text-gray-500">{item.dateEnd ?? ''}</td>
      <td className="px-3 py-1.5 text-right text-gray-800">{priceText}</td>
      <td className="px-3 py-1.5 text-right text-gray-500">{discountText}</td>
      <td className="px-3 py-1.5 text-right text-gray-500">
        {variantCost !== undefined ? variantCost.toFixed(2) : ''}
      </td>
      <td className="px-3 py-1.5 text-right text-gray-500">
        {templateCost !== undefined ? templateCost.toFixed(2) : ''}
      </td>
      <td className="px-3 py-1.5 text-right text-gray-500">
        {publicPrice !== undefined ? publicPrice.toFixed(2) : ''}
      </td>
      {showDelete && (
        <td className="px-3 py-1.5 text-center" onClick={e => { e.stopPropagation(); onDelete() }}>
          <span className="text-gray-300 hover:text-red-400 text-base leading-none cursor-pointer select-none">🗑</span>
        </td>
      )}
    </tr>
  )
}
```

- [ ] **Step 4: `ItemDialog` 里也加一行 Public Price 参考值**

`app/[locale]/classic/operator/pricelists/[id]/page.tsx:849-853`：

```tsx
  const templateCostVal = item.applyOn === 'product' && item.productTemplateId
    ? (templates.find(t => t.id === item.productTemplateId)?.standardPrice ?? 0)
    : item.applyOn === 'variant' && item.productVariantId
      ? (products.find(p => p.id === item.productVariantId)?.standardPrice ?? 0)
      : 0
```

改成（新增 `templatePublicPriceVal`）：

```tsx
  const templateCostVal = item.applyOn === 'product' && item.productTemplateId
    ? (templates.find(t => t.id === item.productTemplateId)?.standardPrice ?? 0)
    : item.applyOn === 'variant' && item.productVariantId
      ? (products.find(p => p.id === item.productVariantId)?.standardPrice ?? 0)
      : 0

  const templatePublicPriceVal = item.applyOn === 'product' && item.productTemplateId
    ? (templates.find(t => t.id === item.productTemplateId)?.listPrice ?? 0)
    : item.applyOn === 'variant' && item.productVariantId
      ? (products.find(p => p.id === item.productVariantId)?.listPrice ?? 0)
      : 0
```

`app/[locale]/classic/operator/pricelists/[id]/page.tsx:930-933`：

```tsx
              <div className="flex items-center gap-4 text-sm">
                <span className="text-gray-600">{costLabel}</span>
                <span className="text-gray-800">{templateCostVal.toFixed(2)}</span>
              </div>
```

改成：

```tsx
              <div className="flex items-center gap-4 text-sm">
                <span className="text-gray-600">{costLabel}</span>
                <span className="text-gray-800">{templateCostVal.toFixed(2)}</span>
              </div>
              <div className="flex items-center gap-4 text-sm mt-1">
                <span className="text-gray-600">Public Price</span>
                <span className="text-gray-800">{templatePublicPriceVal.toFixed(2)}</span>
              </div>
```

- [ ] **Step 5: 客户列表页 — 展示第一优先级价格表 + groupBy 改用派生字段**

`app/[locale]/classic/operator/customers/page.tsx:108-111`：

```tsx
    {
      key: 'pricelistId',
      label: isEn ? 'Pricelist' : '价格表',
      render: (v) => v ? (pricelistMap.get(String(v)) ?? String(v)) : <span className="text-gray-400">—</span>,
    },
```

改成：

```tsx
    {
      key: 'primaryPricelistId',
      label: isEn ? 'Pricelist' : '价格表',
      render: (_v, row) => {
        const links = (row.pricelists as { pricelistId: string }[] | undefined) ?? []
        if (links.length === 0) return <span className="text-gray-400">—</span>
        const primaryName = pricelistMap.get(links[0].pricelistId) ?? links[0].pricelistId
        return links.length > 1 ? `${primaryName} (+${links.length - 1})` : primaryName
      },
    },
```

在 `app/[locale]/classic/operator/customers/page.tsx:198`（`rows={customers as unknown as Record<string, unknown>[]}`）之前插入一个派生数组，把这一行：

```tsx
          rows={customers as unknown as Record<string, unknown>[]}
```

改成：

```tsx
          rows={customers.map(c => ({ ...c, primaryPricelistId: c.pricelists?.[0]?.pricelistId ?? null })) as unknown as Record<string, unknown>[]}
```

`app/[locale]/classic/operator/customers/page.tsx:215`：

```tsx
          groupByField={groupBy === 'paymentTerm' ? 'paymentTerm' : groupBy === 'pricelist' ? 'pricelistId' : ''}
```

改成：

```tsx
          groupByField={groupBy === 'paymentTerm' ? 'paymentTerm' : groupBy === 'pricelist' ? 'primaryPricelistId' : ''}
```

- [ ] **Step 6: 种子数据管线适配**

`lib/seed-customers.ts:19`：

```ts
  pricelistId: string | null
```

改成：

```ts
  pricelistIds: string[]
```

`lib/seed-customers.ts:41` 和 `54`：

```ts
    pricelistId: 'pl_44',
```

各自改成：

```ts
    pricelistIds: ['pl_44'],
```

`prisma/csv-loader.ts:150-153` 附近（`pricelistId: string | null` 字段声明）改成 `pricelistIds: string[]`；`prisma/csv-loader.ts:249,254`：

```ts
    const pricelistId = pricelist ? (PRICELIST_MAP[pricelist] ?? null) : null
```
```ts
      paymentTerm: 'monthly', notes, pricelistId,
```

改成：

```ts
    const pricelistId = pricelist ? (PRICELIST_MAP[pricelist] ?? null) : null
```
```ts
      paymentTerm: 'monthly', notes, pricelistIds: pricelistId ? [pricelistId] : [],
```

`prisma/seed.ts:244-263`（demo 客户 upsert）：

```ts
  for (const c of SEED_DEMO_CUSTOMERS) {
    await prisma.customer.upsert({
      where: { id: c.id },
      update: { name: c.name, city: c.city, address: c.address, pricelistId: c.pricelistId },
      create: {
        id: c.id,
        name: c.name,
        address: c.address,
        phone: c.phone,
        email: c.email,
        vatNumber: c.vatNumber,
        paymentTerm: c.paymentTerm,
        creditLimit: c.creditLimit,
        commissionRate: c.commissionRate,
        externalId: c.externalId,
        city: c.city,
        notes: c.notes,
        pricelistId: c.pricelistId,
      },
    })
  }
```

改成：

```ts
  for (const c of SEED_DEMO_CUSTOMERS) {
    await prisma.customer.upsert({
      where: { id: c.id },
      update: { name: c.name, city: c.city, address: c.address },
      create: {
        id: c.id,
        name: c.name,
        address: c.address,
        phone: c.phone,
        email: c.email,
        vatNumber: c.vatNumber,
        paymentTerm: c.paymentTerm,
        creditLimit: c.creditLimit,
        commissionRate: c.commissionRate,
        externalId: c.externalId,
        city: c.city,
        notes: c.notes,
      },
    })
    if (c.pricelistIds.length > 0) {
      await prisma.customerPricelist.deleteMany({ where: { customerId: c.id } })
      await prisma.customerPricelist.createMany({
        data: c.pricelistIds.map((pricelistId, idx) => ({ customerId: c.id, pricelistId, sequence: idx + 1 })),
      })
    }
  }
```

`prisma/seed.ts:266-300`（CSV 批量客户）同样把 `update`/`create` 里的 `pricelistId: c.pricelistId` 去掉，改成 upsert 完客户之后单独处理：

```ts
  const csvCustomers = skipBulkMaster ? [] : loadCsvCustomers()
  let csvImported = 0
  for (let i = 0; i < csvCustomers.length; i += BATCH) {
    const batch = csvCustomers.slice(i, i + BATCH)
    await Promise.all(batch.map(async c => {
      await prisma.customer.upsert({
        where: { id: c.id },
        update: { name: c.name, city: c.city, address: c.address, notes: c.notes, externalId: c.externalId },
        create: {
          id: c.id, name: c.name, address: c.address, phone: c.phone, email: c.email,
          vatNumber: c.vatNumber, paymentTerm: c.paymentTerm, externalId: c.externalId,
          city: c.city, notes: c.notes,
        },
      })
      if (c.pricelistIds.length > 0) {
        await prisma.customerPricelist.deleteMany({ where: { customerId: c.id } })
        await prisma.customerPricelist.createMany({
          data: c.pricelistIds.map((pricelistId, idx) => ({ customerId: c.id, pricelistId, sequence: idx + 1 })),
        })
      }
    }))
    csvImported += batch.length
    if (i % 500 === 0 && i > 0) console.log(`  CSV 客户: ${i}/${csvCustomers.length}`)
  }
  console.log(`✅ CSV 客户: ${csvImported} 条`)
```

- [ ] **Step 7: 类型检查全项目**

```bash
npx tsc --noEmit -p . 2>&1 | tail -60
```

Expected: 无输出（这是所有 UI/种子任务改完后第一次全项目 0 类型错误的检查点）。

- [ ] **Step 8: Commit**

```bash
git add "app/[locale]/classic/operator/place-order/page.tsx" \
        "app/[locale]/classic/operator/pricelists/[id]/page.tsx" \
        "app/[locale]/classic/operator/customers/page.tsx" \
        lib/seed-customers.ts prisma/csv-loader.ts prisma/seed.ts
git commit -m "$(cat <<'EOF'
feat(ui): place-order 覆盖机制、价格表页 Public Price 列、客户列表展示适配多价格表

价格表编辑页新增 Public Price 参考列（表格+弹窗），跟已有的 Variant/
Template Cost 并列展示。客户列表页展示优先级最高的价格表(+N 提示还
有几张)，group-by 改用派生字段。种子数据管线（demo + CSV 批量导入）
同步改成写 CustomerPricelist。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: 删除 `Customer.pricelistId` 旧字段（收尾迁移）

**Files:**
- Modify: `prisma/schema.prisma:394,420`

**Interfaces:**
- Consumes: 无（这是最后一步，此时全项目应该已经没有代码读 `Customer.pricelistId`）

- [ ] **Step 1: 确认没有代码还在读 `Customer.pricelistId`（排除 `Order.pricelistId`，那个字段没变，不能误删）**

```bash
grep -rn "\.pricelistId\b" --include="*.ts" --include="*.tsx" \
  /Volumes/datacenter/04-eric/AIcoding/veggie/app \
  /Volumes/datacenter/04-eric/AIcoding/veggie/lib \
  /Volumes/datacenter/04-eric/AIcoding/veggie/scripts \
  /Volumes/datacenter/04-eric/AIcoding/veggie/prisma \
  2>/dev/null | grep -v node_modules | grep -v "generated/prisma" | grep -v "\.tmp-"
```

Expected: 剩下的匹配全部是 `Order.pricelistId` / `resolution.pricelistId`（`PriceResolution.pricelistName` 不是这个）/ `overrides.pricelistId` / `data.pricelistId`（订单级，未变）相关，**没有任何一处是 `customer.pricelistId` 或 `Customer.pricelistId`**。如果还有遗漏，回去补上对应任务再重新跑这一步。

- [ ] **Step 2: 确认线上没有孤儿数据（有 `pricelistId` 但没迁移成 `CustomerPricelist`，比如 Task 8 之后又有人手动改了）**

```bash
export DATABASE_URL=$(grep "^DATABASE_URL" .env.local | cut -d'"' -f2)
npx tsx -e "
import { prisma } from './lib/db'
async function main() {
  const orphans = await prisma.customer.count({ where: { pricelistId: { not: null }, pricelists: { none: {} } } })
  console.log('孤儿客户数(有 pricelistId 但没迁移到新表):', orphans)
}
main().finally(()=>prisma.\$disconnect())
"
```

Expected: `0`。如果不是 0，先补跑 Task 8 的迁移脚本（幂等，可以安全重跑），确认变成 0 再继续。

- [ ] **Step 3: 把这个 dry-run 结果和 Step 1 的 grep 结果贴给用户，获得明确同意后再删列**

> ⛔ 删列是不可逆操作（虽然 Neon 有历史快照，但生产环境应尽量避免依赖"能回滚"来兜底）。必须等用户看过 Step 1/Step 2 的确认结果并明确同意后才能继续。

- [ ] **Step 4: （获得同意后）删除 schema 字段并 db push**

`prisma/schema.prisma:394`：

```prisma
  pricelistId         String?
```

删除这一行。`prisma/schema.prisma:420`：

```prisma
  @@index([pricelistId])
```

删除这一行。

```bash
export DATABASE_URL=$(grep "^DATABASE_URL" .env.local | cut -d'"' -f2)
npx prisma db push
npx prisma generate
```

Expected: `db push` 提示会删除 `Customer.pricelistId` 列（可能需要 `--accept-data-loss`，因为字段已确认全是孤儿检查过的冗余数据，此时删除不丢失任何还在被使用的信息）：

```bash
npx prisma db push --accept-data-loss
```

- [ ] **Step 5: 全量回归**

```bash
npx tsc --noEmit -p .
node --test --import=tsx tests/*.test.ts
npm run build
```

Expected: 三个命令都无报错退出。

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma
git commit -m "$(cat <<'EOF'
chore(db): 删除已废弃的 Customer.pricelistId 字段

应用层全部代码已切换到 CustomerPricelist 多价格表关系表，1526 个
历史客户已迁移确认无孤儿数据，此处收尾删除单值旧字段。

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: 最终验证清单

**Files:** 无新增/修改，纯验证

- [ ] **Step 1: 全量类型检查 + 单测 + 构建**

```bash
npx tsc --noEmit -p .
node --test --import=tsx tests/*.test.ts
npm run build
```

Expected: 全部通过，`pricing-engine-multi-pricelist.test.ts`（9 用例）和 `pricing-override.test.ts`（3 用例）都在输出里显示 PASS。

- [ ] **Step 2: 起本地服务，浏览器走一遍关键路径**

```bash
npm run dev &
```

手动验证（或用之前签发的 JWT + curl）：
1. 客户编辑页：给一个测试客户挂 2 张价格表，调整顺序，保存，刷新页面确认顺序保留
2. 下单页：选这个客户，商品价格建议应该按新的优先级链算（第一张命中的价格）
3. 价格表编辑页：任意打开一张表，确认 Public Price 列有数值且和 Product 详情页的牌价一致
4. 客户列表页：确认 Pricelist 列显示"最高优先级表名 (+N)"格式，group by pricelist 能正常分组

- [ ] **Step 3: 复盘设计文档，确认四项需求全部落地**

对照 `docs/20260715-pricelist-multi-priority-design.md` 里的四条需求表格，逐条确认：
- default 模式先查价格表再回退牌价 ✅（Task 3）
- 价格表创建页显示 public + cost price ✅（Task 9 Step 2-4）
- 下单价格提示优先级（本来就有，未改）✅
- 客户挂多张价格表按优先级取价 ✅（Task 1/2/3/4/5/7）
- 附带：3 个脏数据客户已清理 ✅（Task 8）
