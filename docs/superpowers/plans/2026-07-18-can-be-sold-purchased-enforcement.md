# canBeSold / canBePurchased 实际生效 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `ProductTemplate.canBeSold` / `canBePurchased` 两个开关真正生效——关闭后，运营在下单页/报价单/销售单/采购单里搜不到、也存不进这个商品；已存在的历史行不受影响。

**Architecture:** 三层防线。① `GET /api/products` 新增 `sellable=1` 查询参数（对称于已有的 `purchasable=1`），服务端按 `template.canBeSold` 过滤。② 3 个销售页面的商品选择器接上 `sellable=1`。③ 各写操作 API/SSOT 函数对"新增行"做服务端硬校验，拒绝返回 400；已有行永远不查这个字段。

**Tech Stack:** Next.js App Router API routes、Prisma、Node 内置 test runner（`node --test` + `tsx`，见 `tests/*.test.ts`）。

## Global Constraints

- 历史行（订单/报价单/采购单里已存在的行）任何时候都不因商品被关闭 canBeSold/canBePurchased 而受影响——校验只作用于"新增一行"这个动作。
- 报错格式统一 `NextResponse.json({ error: '商品「X」...' }, { status: 400 })`，且必须是函数体内的 **early return**，不是 `throw` 丢给 catch 块——`orders/[id]/route.ts` 和 `purchase-orders/[id]/route.ts` 的 PUT catch 块目前会把非特定类型异常统一吞成 500 通用文案，throw 过去会丢失报错信息。
- `app/api/orders/route.ts` POST 和 `lib/create-purchase-order.ts`（被 `app/api/purchase-orders/route.ts` POST 调用）的 catch 块已经对 `err.status` 做了 400-499 透传，这两处延续文件里已有的 `throw Object.assign(new Error(...), { status: 400 })` 风格即可。
- 不改 `daily-sales/_components/ShortageHandler.tsx`——那里的 `ProductSearchInput` 是缺货列表的筛选分面，不是加行动作，接 `sellable=1` 会让用户搜不到历史缺货记录里的已下架商品。
- 不改 `lib/server-pricing.ts`——它是定价解析器不是准入闸门。
- 不做历史脏数据清理、不做采购导入的新审核 UI。

**测试方式的说明**：这个代码库的写操作 API 路由直接 `import { prisma } from '@/lib/db'`，不是为依赖注入设计的（`tests/*.test.ts` 里能真正做无 DB 单元测试的都是纯函数/接受 `tx` 参数的 SSOT 函数，例如 `tests/invoice-invoiced-qty.test.ts` mock 一个假 `tx` 对象）。本计划里：
- `lib/create-purchase-order.ts` 的 `createPurchaseOrder()` 本来就接受 `tx` 参数 → 写真正的 Node 单元测试，mock `tx`，不碰真实 DB（Task 6）。
- 其余 6 个 API 路由的改动 → 按项目 CLAUDE.md 的完成标准，起本地 `npm run dev`（读 `.env.local` 指向的开发库），用 curl 针对真实数据做验证。为了不污染数据，验证脚本里"关闭某商品的 canBeSold/canBePurchased" 之后，最后一步必须把它改回 `true`。

---

### Task 1: `GET /api/products` 新增 `sellable=1` 参数

**Files:**
- Modify: `app/api/products/route.ts:1-51`（GET handler）

**Interfaces:**
- Produces: `GET /api/products?sellable=1` → 只返回 `template.canBeSold === true` 的商品；可与已有的 `purchasable=1` 同时传，互不冲突。

- [ ] **Step 1: 修改 GET handler，把 `purchasableOnly` 和新的 `sellableOnly` 合并进同一个 `template` where**

把 `app/api/products/route.ts` 里这一段：

```ts
    const purchasableOnly = searchParams.get('purchasable') === '1'
    const where: Record<string, unknown> = {}
    if (statusFilter) where.status = statusFilter as never
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { internalRef: { contains: search, mode: 'insensitive' } },
      ]
    }
    if (purchasableOnly) where.template = { canBePurchased: true }
```

改成：

```ts
    const purchasableOnly = searchParams.get('purchasable') === '1'
    // sellable=1：只给下单/报价单/销售单选品用，只返回 canBeSold 的商品（该标记在 ProductTemplate 上）
    const sellableOnly = searchParams.get('sellable') === '1'
    const where: Record<string, unknown> = {}
    if (statusFilter) where.status = statusFilter as never
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { internalRef: { contains: search, mode: 'insensitive' } },
      ]
    }
    const templateWhere: Record<string, unknown> = {}
    if (purchasableOnly) templateWhere.canBePurchased = true
    if (sellableOnly) templateWhere.canBeSold = true
    if (Object.keys(templateWhere).length > 0) where.template = templateWhere
```

- [ ] **Step 2: 本地起服务并用 curl 验证**

```bash
npm run dev &
sleep 3
```

登录拿 `$TOKEN`（用你本地开发库里已有的账号）：

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"<你的本地测试账号邮箱>","password":"<密码>"}' | jq -r .token)
```

挑一个真实商品，先记录它当前的 `canBeSold`，关掉它，确认 `sellable=1` 把它过滤掉，再改回来：

```bash
PROD=$(curl -s http://localhost:3000/api/products?limit=1 -H "Authorization: Bearer $TOKEN" | jq '.[0]')
PID=$(echo "$PROD" | jq -r .id)
TPL=$(echo "$PROD" | jq -r .templateId)
NAME=$(echo "$PROD" | jq -r .name)

# 关闭 canBeSold
curl -s -X PUT "http://localhost:3000/api/product-templates/$TPL" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"canBeSold": false}' > /dev/null

# 验证：sellable=1 时搜不到它
curl -s "http://localhost:3000/api/products?sellable=1" -H "Authorization: Bearer $TOKEN" \
  | jq --arg pid "$PID" '[.[] | select(.id == $pid)] | length'
# 期望输出：0

# 验证：不传 sellable 时仍能搜到（确认过滤是可选的，不是全局生效）
curl -s "http://localhost:3000/api/products" -H "Authorization: Bearer $TOKEN" \
  | jq --arg pid "$PID" '[.[] | select(.id == $pid)] | length'
# 期望输出：1

# 复原
curl -s -X PUT "http://localhost:3000/api/product-templates/$TPL" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"canBeSold": true}' > /dev/null
echo "复原 $NAME 的 canBeSold=true"
```

- [ ] **Step 3: Commit**

```bash
git add app/api/products/route.ts
git commit -m "feat(products): GET /api/products 支持 sellable=1 过滤"
```

---

### Task 2: 3 个销售页面的商品选择器接上 `sellable=1`

**Files:**
- Modify: `app/[locale]/classic/operator/place-order/page.tsx:475`
- Modify: `app/[locale]/classic/operator/quotations/[id]/page.tsx:132`
- Modify: `app/[locale]/classic/operator/orders/[id]/page.tsx:158`

**Interfaces:**
- Consumes: Task 1 的 `GET /api/products?sellable=1`
- Produces: 三个页面的商品搜索下拉不再出现 canBeSold=false 的商品

- [ ] **Step 1: place-order/page.tsx**

```ts
      // status=ACTIVE: 服务端过滤，不传输已归档商品；sellable=1: 不传输不可售商品
      apiGet<Product[]>('/api/products?status=ACTIVE&sellable=1').catch(() => []),
```

- [ ] **Step 2: quotations/[id]/page.tsx**

```ts
    apiGet<AllProduct[]>('/api/products?limit=500&sellable=1').then(p => setAllProducts(Array.isArray(p) ? p : [])).catch(() => {})
```

- [ ] **Step 3: orders/[id]/page.tsx**

```ts
    apiGet<AllProduct[]>('/api/products?limit=500&sellable=1').then(p => setAllProducts(Array.isArray(p) ? p : [])).catch(() => {})
```

- [ ] **Step 4: 静态确认三处都改了**

```bash
grep -n "sellable=1" \
  "app/[locale]/classic/operator/place-order/page.tsx" \
  "app/[locale]/classic/operator/quotations/[id]/page.tsx" \
  "app/[locale]/classic/operator/orders/[id]/page.tsx"
```

期望：三个文件各命中一行。

- [ ] **Step 5: 浏览器实测一个场景**

`npm run dev` 起服务，浏览器打开下单页（place-order），用 Task 1 里临时关闭过 canBeSold 的同一个商品名去商品搜索框搜索，确认下拉里搜不到。（Task 1 结束时已经把该商品的 canBeSold 改回了 true，如果要在浏览器里复测，先临时关掉、测完再改回来。）

- [ ] **Step 6: Commit**

```bash
git add "app/[locale]/classic/operator/place-order/page.tsx" \
  "app/[locale]/classic/operator/quotations/[id]/page.tsx" \
  "app/[locale]/classic/operator/orders/[id]/page.tsx"
git commit -m "feat(sales): 下单页/报价单/销售单商品选择器过滤不可售商品"
```

---

### Task 3: `POST /api/orders`（创建订单/报价单）新增行校验 canBeSold

**Files:**
- Modify: `app/api/orders/route.ts:254-266`

**Interfaces:**
- Consumes: `productsForStock`（已有查询，`prisma.product.findMany` 返回带 `template` 的商品数组）
- Produces: 创建订单时若任一行商品 `canBeSold === false`，返回 400，不创建订单

- [ ] **Step 1: 扩展已有查询的 select，加 canBeSold，并在其后插入校验**

把 `app/api/orders/route.ts` 里这一段：

```ts
      const productIds = lines.map((l) => l.productId)
      const productsForStock = await prisma.product.findMany({
        where: { id: { in: productIds } },
        include: { template: { select: { type: true, commissionPrice: true } } },
      })
      const stockMap = new Map(productsForStock.map((p) => [p.id, p]))
      // 件提成单价：优先取 Product.commissionPrice，fallback 到 ProductTemplate.commissionPrice
      const commissionPriceMap = new Map(
        productsForStock.map((p) => [p.id, p.commissionPrice ?? p.template?.commissionPrice ?? null])
      )
```

改成：

```ts
      const productIds = lines.map((l) => l.productId)
      const productsForStock = await prisma.product.findMany({
        where: { id: { in: productIds } },
        include: { template: { select: { type: true, commissionPrice: true, canBeSold: true } } },
      })

      // 准入闸门：新建订单/报价单里的商品必须 canBeSold=true（历史订单的老行不受此影响，见 orders/[id] PUT）
      const notSellable = productsForStock.filter((p) => p.template?.canBeSold === false)
      if (notSellable.length > 0) {
        return NextResponse.json(
          { error: `商品「${notSellable.map((p) => p.name).join('、')}」已下架，不可下单` },
          { status: 400 },
        )
      }

      const stockMap = new Map(productsForStock.map((p) => [p.id, p]))
      // 件提成单价：优先取 Product.commissionPrice，fallback 到 ProductTemplate.commissionPrice
      const commissionPriceMap = new Map(
        productsForStock.map((p) => [p.id, p.commissionPrice ?? p.template?.commissionPrice ?? null])
      )
```

- [ ] **Step 2: curl 验证**

用 Task 1 相同的登录方式拿到 `$TOKEN` 和一个真实商品 `$PID`/`$TPL`，关闭它的 `canBeSold`，然后直调创建订单接口：

```bash
curl -s -X PUT "http://localhost:3000/api/product-templates/$TPL" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"canBeSold": false}' > /dev/null

# 找一个真实存在的客户 ID（餐馆），替换 $CUSTOMER_ID
curl -s -w "\nSTATUS:%{http_code}\n" -X POST http://localhost:3000/api/orders \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"restaurantId\":\"$CUSTOMER_ID\",\"items\":[{\"productId\":\"$PID\",\"quantity\":1}]}"
# 期望：STATUS:400，body 里 error 含"已下架"

curl -s -X PUT "http://localhost:3000/api/product-templates/$TPL" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"canBeSold": true}' > /dev/null

# 复原后再跑一次同样的请求，确认能正常 201 创建成功（不是误伤所有下单）
curl -s -w "\nSTATUS:%{http_code}\n" -X POST http://localhost:3000/api/orders \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"restaurantId\":\"$CUSTOMER_ID\",\"items\":[{\"productId\":\"$PID\",\"quantity\":1}]}"
# 期望：STATUS:201
```

- [ ] **Step 3: Commit**

```bash
git add app/api/orders/route.ts
git commit -m "feat(orders): 创建订单/报价单时校验商品 canBeSold"
```

---

### Task 4: `PUT /api/orders/:id`（整单保存）新增行校验 canBeSold

**Files:**
- Modify: `app/api/orders/[id]/route.ts:227-239`

**Interfaces:**
- Consumes: 已有的 `newLineProducts` 查询（`!l.id` 判定为新增行）
- Produces: 整单保存时，只要有一个"新增行"（没有 `id` 的行）的商品 `canBeSold === false`，返回 400、不落库任何改动；已有行永不受影响。

- [ ] **Step 1: 扩展 `newLineProducts` 的 select，插入校验**

把 `app/api/orders/[id]/route.ts` 里这一段（第 227-239 行）：

```ts
        // SSOT: 新增行同样要写件提成快照,否则该行提成恒为 null
        const newLineProductIds = (linesPayload as Record<string, unknown>[])
          .filter(l => !l.id)
          .map(l => String(l.productId ?? ''))
          .filter(Boolean)
        const newLineProducts = newLineProductIds.length > 0
          ? await prisma.product.findMany({
              where: { id: { in: newLineProductIds } },
              include: { template: { select: { commissionPrice: true } } },
            })
          : []
        const newLineCommissionMap = new Map(
          newLineProducts.map(p => [p.id, p.commissionPrice ?? p.template?.commissionPrice ?? null])
        )
```

改成：

```ts
        // SSOT: 新增行同样要写件提成快照,否则该行提成恒为 null
        const newLineProductIds = (linesPayload as Record<string, unknown>[])
          .filter(l => !l.id)
          .map(l => String(l.productId ?? ''))
          .filter(Boolean)
        const newLineProducts = newLineProductIds.length > 0
          ? await prisma.product.findMany({
              where: { id: { in: newLineProductIds } },
              include: { template: { select: { commissionPrice: true, canBeSold: true } } },
            })
          : []

        // 准入闸门：只查新增行，已有行（哪怕它引用的商品后来被关闭 canBeSold）永远不受影响
        const notSellable = newLineProducts.filter(p => p.template?.canBeSold === false)
        if (notSellable.length > 0) {
          return NextResponse.json(
            { error: `商品「${notSellable.map(p => p.name).join('、')}」已下架，不可加入订单` },
            { status: 400 },
          )
        }

        const newLineCommissionMap = new Map(
          newLineProducts.map(p => [p.id, p.commissionPrice ?? p.template?.commissionPrice ?? null])
        )
```

- [ ] **Step 2: curl 验证 —— 新增行被挡，已有行不受影响**

找一个真实存在、状态允许编辑（非 LOCKED/CANCELLED）的订单 `$ORDER_ID`，及其现有的一行 `$EXISTING_LINE_ID`：

```bash
curl -s -X PUT "http://localhost:3000/api/product-templates/$TPL" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"canBeSold": false}' > /dev/null

# 场景 A：给整单保存新增一行引用被关闭的商品 → 期望 400
curl -s -w "\nSTATUS:%{http_code}\n" -X PUT "http://localhost:3000/api/orders/$ORDER_ID" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"id\":\"$EXISTING_LINE_ID\",\"orderedQty\":1,\"unitPrice\":1},{\"productId\":\"$PID\",\"productName\":\"test\",\"orderedQty\":1,\"unitPrice\":1}]}"
# 期望：STATUS:400

# 场景 B：只保存已有行（不新增），即使该行本身引用的就是这个已关闭的商品 → 期望成功，不被挡
curl -s -w "\nSTATUS:%{http_code}\n" -X PUT "http://localhost:3000/api/orders/$ORDER_ID" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"id\":\"$EXISTING_LINE_ID\",\"orderedQty\":2,\"unitPrice\":1}]}"
# 期望：STATUS:200

curl -s -X PUT "http://localhost:3000/api/product-templates/$TPL" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"canBeSold": true}' > /dev/null
```

- [ ] **Step 3: Commit**

```bash
git add "app/api/orders/[id]/route.ts"
git commit -m "feat(orders): 整单保存时新增行校验 canBeSold，历史行不受影响"
```

---

### Task 5: `POST /api/orders/:id/lines`（追加单行）校验 canBeSold

**Files:**
- Modify: `app/api/orders/[id]/lines/route.ts:35-48`

**Interfaces:**
- Produces: 追加单行接口若目标商品 `canBeSold === false`，返回 400，不创建行

- [ ] **Step 1: 在读到 productId 之后、创建行之前插入校验**

把 `app/api/orders/[id]/lines/route.ts` 里这一段：

```ts
      const {
        productId,
        productName,
        uomId,
        uomName,
        unitPrice,
        orderedQty,
        taxRate,
        sequence,
      } = body

      const subtotal = Math.round(Number(unitPrice) * Number(orderedQty) * 100) / 100
      // SSOT: 追加行同样要写件提成快照,否则该行提成恒为 null
      const commissionPrice = await resolveCommissionPrice(String(productId))
```

改成：

```ts
      const {
        productId,
        productName,
        uomId,
        uomName,
        unitPrice,
        orderedQty,
        taxRate,
        sequence,
      } = body

      const productToAdd = await prisma.product.findUnique({
        where: { id: String(productId) },
        include: { template: { select: { canBeSold: true } } },
      })
      if (productToAdd?.template?.canBeSold === false) {
        return NextResponse.json(
          { error: `商品「${productToAdd.name}」已下架，不可加入订单` },
          { status: 400 },
        )
      }

      const subtotal = Math.round(Number(unitPrice) * Number(orderedQty) * 100) / 100
      // SSOT: 追加行同样要写件提成快照,否则该行提成恒为 null
      const commissionPrice = await resolveCommissionPrice(String(productId))
```

- [ ] **Step 2: curl 验证**

```bash
curl -s -X PUT "http://localhost:3000/api/product-templates/$TPL" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"canBeSold": false}' > /dev/null

curl -s -w "\nSTATUS:%{http_code}\n" -X POST "http://localhost:3000/api/orders/$ORDER_ID/lines" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"productId\":\"$PID\",\"productName\":\"test\",\"unitPrice\":1,\"orderedQty\":1}"
# 期望：STATUS:400

curl -s -X PUT "http://localhost:3000/api/product-templates/$TPL" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"canBeSold": true}' > /dev/null
```

- [ ] **Step 3: Commit**

```bash
git add "app/api/orders/[id]/lines/route.ts"
git commit -m "feat(orders): 追加单行接口校验 canBeSold"
```

---

### Task 6: `lib/create-purchase-order.ts` 新增行校验 canBePurchased（含单元测试）

**Files:**
- Modify: `lib/create-purchase-order.ts`
- Test: `tests/create-purchase-order.test.ts`

**Interfaces:**
- Consumes: `tx.product.findMany({ where, include })`（mock 在测试里注入）
- Produces: `createPurchaseOrder(tx, input)` 在 `input.lines` 里任一 `productId` 对应商品 `canBePurchased === false` 时，`throw` 一个 `status: 400` 的 `Error`，被 `POST /api/purchase-orders` 和"采购建议转采购单"两条路径的 catch 块统一透传成 400 响应。

- [ ] **Step 1: 写失败的单元测试**

创建 `tests/create-purchase-order.test.ts`：

```ts
/**
 * canBePurchased 准入闸门：createPurchaseOrder 是 POST /api/purchase-orders 和
 * "采购建议转采购单"共用的唯一创建入口，改这一处即可同时覆盖两条路径。
 * 用 mock tx，不碰真实 DB。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPurchaseOrder } from '../lib/create-purchase-order'

function mockTx(products: Array<{ id: string; name: string; canBePurchased: boolean }>) {
  return {
    product: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        products
          .filter(p => where.id.in.includes(p.id))
          .map(p => ({ id: p.id, name: p.name, template: { canBePurchased: p.canBePurchased } })),
    },
    purchaseOrder: {
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'po_test', ...data }),
    },
  }
}

test('包含不可采购商品的行 → 抛出 400 错误，不创建 PO', async () => {
  const tx = mockTx([{ id: 'p1', name: '洋葱', canBePurchased: false }])
  await assert.rejects(
    () => createPurchaseOrder(tx, {
      supplierId: 'sup_1',
      lines: [{ productId: 'p1', productName: '洋葱', orderedQty: 10, unitCost: 2 }],
    }),
    (err: unknown) => {
      assert.match((err as Error).message, /洋葱/)
      assert.equal((err as { status?: number }).status, 400)
      return true
    },
  )
})

test('全部商品可采购 → 正常创建 PO', async () => {
  const tx = mockTx([{ id: 'p1', name: '洋葱', canBePurchased: true }])
  const po = await createPurchaseOrder(tx, {
    supplierId: 'sup_1',
    lines: [{ productId: 'p1', productName: '洋葱', orderedQty: 10, unitCost: 2 }],
  })
  assert.equal(po.id, 'po_test')
})

test('商品模板缺失 canBePurchased 字段（undefined）→ 默认放行', async () => {
  // Prisma 默认值是 true；mock 里模拟"没查到 template"这种边界情况，不应误伤
  const tx = {
    product: { findMany: async () => [{ id: 'p1', name: '洋葱', template: null }] },
    purchaseOrder: {
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 'po_test', ...data }),
    },
  }
  const po = await createPurchaseOrder(tx, {
    supplierId: 'sup_1',
    lines: [{ productId: 'p1', productName: '洋葱', orderedQty: 10, unitCost: 2 }],
  })
  assert.equal(po.id, 'po_test')
})
```

- [ ] **Step 2: 跑测试，确认失败（因为校验逻辑还不存在）**

```bash
npx --yes tsx --test tests/create-purchase-order.test.ts
```

期望：第一个 test 失败——`createPurchaseOrder` 目前不会 reject，`assert.rejects` 报错。

- [ ] **Step 3: 在 `lib/create-purchase-order.ts` 里实现校验**

在 `export async function createPurchaseOrder(tx: Tx, input: CreatePOInput) {` 函数体内，`// 询价单允许先只定供应商+日期开单...` 注释之后、`const currency = ...` 之前，插入：

```ts
  // 准入闸门：新增采购行必须 canBePurchased=true（已存在的 PO 老行不受此校验，见 [id]/route.ts PUT）
  const productIds = [...new Set(input.lines.map(l => l.productId))]
  if (productIds.length > 0) {
    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
      include: { template: { select: { canBePurchased: true } } },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notPurchasable = products.filter((p: any) => p.template?.canBePurchased === false)
    if (notPurchasable.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      throw Object.assign(new Error(`商品「${notPurchasable.map((p: any) => p.name).join('、')}」不可采购，无法加入采购单`), { status: 400 })
    }
  }
```

完整函数开头应长这样（供对照）：

```ts
export async function createPurchaseOrder(tx: Tx, input: CreatePOInput) {
  const supplierId = input.supplierId.trim()
  if (!supplierId) throw Object.assign(new Error('供应商不能为空'), { status: 400 })
  // 询价单允许先只定供应商+日期开单，产品之后在详情页逐条加（见 PurchaseOrderLine 的 POST/DELETE）

  // 准入闸门：新增采购行必须 canBePurchased=true（已存在的 PO 老行不受此校验，见 [id]/route.ts PUT）
  const productIds = [...new Set(input.lines.map(l => l.productId))]
  if (productIds.length > 0) {
    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
      include: { template: { select: { canBePurchased: true } } },
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notPurchasable = products.filter((p: any) => p.template?.canBePurchased === false)
    if (notPurchasable.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      throw Object.assign(new Error(`商品「${notPurchasable.map((p: any) => p.name).join('、')}」不可采购，无法加入采购单`), { status: 400 })
    }
  }

  const currency = (input.currency ?? 'EUR').toUpperCase()
  // ...(其余不变)
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
npx --yes tsx --test tests/create-purchase-order.test.ts
```

期望：3 个 test 全部 PASS。

- [ ] **Step 5: 跑一遍全量测试，确认没有改坏别的东西**

```bash
npm run test
```

期望：全部 PASS（含新加的 3 个）。

- [ ] **Step 6: Commit**

```bash
git add lib/create-purchase-order.ts tests/create-purchase-order.test.ts
git commit -m "feat(purchase): 建 PO 时校验商品 canBePurchased，覆盖直接建单与建议转单两条路径"
```

---

### Task 7: `PUT /api/purchase-orders/:id`（整单保存）新增行校验 canBePurchased

**Files:**
- Modify: `app/api/purchase-orders/[id]/route.ts:100-114`

**Interfaces:**
- Produces: 整单保存时，只要有一个"新增行"（`id` 以 `new-` 开头）的商品 `canBePurchased === false`，返回 400，不落库任何改动；已有行不受影响。

- [ ] **Step 1: 在 `isNewLine`/`deletedIds`/`nextSequence` 之后、`const lineOps = ...` 之前插入校验**

把 `app/api/purchase-orders/[id]/route.ts` 里这一段（第 100-114 行）：

```ts
      if (Array.isArray(linesPayload)) {
        // 新增行：客户端给临时 id（"new-" 前缀），必须带 productId 才能落库
        const isNewLine = (l: Record<string, unknown>) => String(l.id ?? '').startsWith('new-')
        const payloadIds = new Set(
          linesPayload.filter((l: Record<string, unknown>) => !isNewLine(l)).map((l: Record<string, unknown>) => String(l.id)),
        )
        // 删除行：原有行里，这次提交没带回来的即视为被删
        const deletedIds = Object.keys(oldLines).filter(lid => !payloadIds.has(lid))

        const maxSequence = Object.values(oldLines).reduce(
          (max, l) => Math.max(max, Number((l as Record<string, unknown>).sequence ?? 0)), 0,
        )
        let nextSequence = maxSequence

        const lineOps = linesPayload.map((l: Record<string, unknown>) => {
```

改成：

```ts
      if (Array.isArray(linesPayload)) {
        // 新增行：客户端给临时 id（"new-" 前缀），必须带 productId 才能落库
        const isNewLine = (l: Record<string, unknown>) => String(l.id ?? '').startsWith('new-')
        const payloadIds = new Set(
          linesPayload.filter((l: Record<string, unknown>) => !isNewLine(l)).map((l: Record<string, unknown>) => String(l.id)),
        )
        // 删除行：原有行里，这次提交没带回来的即视为被删
        const deletedIds = Object.keys(oldLines).filter(lid => !payloadIds.has(lid))

        const maxSequence = Object.values(oldLines).reduce(
          (max, l) => Math.max(max, Number((l as Record<string, unknown>).sequence ?? 0)), 0,
        )
        let nextSequence = maxSequence

        // 准入闸门：只查新增行，已有行（哪怕它引用的商品后来被关闭 canBePurchased）永远不受影响
        const newLinePOProductIds = linesPayload
          .filter((l: Record<string, unknown>) => isNewLine(l))
          .map((l: Record<string, unknown>) => String(l.productId ?? ''))
          .filter(Boolean)
        if (newLinePOProductIds.length > 0) {
          const newLinePOProducts = await p.product.findMany({
            where: { id: { in: newLinePOProductIds } },
            include: { template: { select: { canBePurchased: true } } },
          })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const notPurchasable = newLinePOProducts.filter((prod: any) => prod.template?.canBePurchased === false)
          if (notPurchasable.length > 0) {
            return NextResponse.json(
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              { error: `商品「${notPurchasable.map((prod: any) => prod.name).join('、')}」不可采购，无法加入采购单` },
              { status: 400 },
            )
          }
        }

        const lineOps = linesPayload.map((l: Record<string, unknown>) => {
```

（`p` 是本文件 PUT handler 里已有的 `const p = prisma as any`，见第 58 行，直接复用。）

- [ ] **Step 2: curl 验证**

找一个真实存在、状态为 DRAFT/SENT 的采购单 `$PO_ID`：

```bash
curl -s -X PUT "http://localhost:3000/api/product-templates/$TPL" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"canBePurchased": false}' > /dev/null

curl -s -w "\nSTATUS:%{http_code}\n" -X PUT "http://localhost:3000/api/purchase-orders/$PO_ID" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"lines\":[{\"id\":\"new-1\",\"productId\":\"$PID\",\"productName\":\"test\",\"orderedQty\":1,\"unitCost\":1}]}"
# 期望：STATUS:400

curl -s -X PUT "http://localhost:3000/api/product-templates/$TPL" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"canBePurchased": true}' > /dev/null
```

- [ ] **Step 3: Commit**

```bash
git add "app/api/purchase-orders/[id]/route.ts"
git commit -m "feat(purchase): 整单保存时新增行校验 canBePurchased，历史行不受影响"
```

---

### Task 8: PDF/Excel 导入的候选商品池排除不可采购商品

**Files:**
- Modify: `app/api/purchase-orders/import/route.ts:62-65`

**Interfaces:**
- Produces: `matchProducts()` 的候选池不再包含 `canBePurchased === false` 的商品，这类商品在导入文件里对应的行自然落成 `matchedProductId: null`（`confidence: 'none'`），走现有的人工处理路径，不新建 UI。

- [ ] **Step 1: 候选池查询加 where**

把 `app/api/purchase-orders/import/route.ts` 里这一段：

```ts
      // 从数据库获取所有商品用于匹配
      const allProducts = await prisma.product.findMany({
        select: { id: true, name: true },
      })
```

改成：

```ts
      // 从数据库获取所有商品用于匹配；不可采购的商品不参与匹配，交给人工处理（落成 confidence:'none'）
      const allProducts = await prisma.product.findMany({
        where: { template: { canBePurchased: true } },
        select: { id: true, name: true },
      })
```

- [ ] **Step 2: 用脚本验证候选池确实排除了不可采购商品**

不用真的构造 PDF/Excel 文件，直接用一段一次性 tsx 脚本核对查询结果（验证完删掉）：

```bash
cat > /tmp/verify-import-pool.ts << 'EOF'
import { PrismaClient } from './lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'
import { config } from 'dotenv'
config({ path: '.env.local' })
neonConfig.webSocketConstructor = ws
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })

async function main() {
  const target = await prisma.product.findFirst({ include: { template: true } })
  if (!target) throw new Error('库里没有商品，找不到可测的对象')
  await prisma.productTemplate.update({ where: { id: target.templateId }, data: { canBePurchased: false } })

  const pool = await prisma.product.findMany({
    where: { template: { canBePurchased: true } },
    select: { id: true, name: true },
  })
  const stillIn = pool.some(p => p.id === target.id)
  console.log(stillIn ? 'FAIL: 不可采购商品仍在候选池里' : `PASS: ${target.name} 已被排除`)

  await prisma.productTemplate.update({ where: { id: target.templateId }, data: { canBePurchased: true } })
}
main().finally(() => prisma.$disconnect())
EOF
npx tsx /tmp/verify-import-pool.ts
rm /tmp/verify-import-pool.ts
```

期望输出：`PASS: <商品名> 已被排除`。

- [ ] **Step 3: Commit**

```bash
git add app/api/purchase-orders/import/route.ts
git commit -m "feat(purchase): PDF/Excel 导入匹配候选池排除不可采购商品"
```

---

## 完成后的整体核对（对照产品文档/CLAUDE.md 完成标准）

- [ ] 8 个 task 全部 commit
- [ ] `npm run build` 无报错
- [ ] `npm run typecheck` 无报错
- [ ] `npm run test` 全部 PASS
- [ ] `npx prisma migrate status` —— 本计划不涉及 schema 变更，应显示无 pending migration
- [ ] 服务器日志（`npm run dev` 输出）在跑完上面所有 curl 验证后，没有非预期的 error/warn
