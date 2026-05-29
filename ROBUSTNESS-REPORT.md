# 系统健壮性修复报告

> 修复时间：2026-04-17  
> 验证命令：`npx tsc --noEmit` → ✅ 零错误

---

## 修复总览（12 个维度）

| # | 维度 | 状态 | 说明 |
|---|------|------|------|
| 1 | 图片上传类型/大小校验 | ✅ 已有 | 上传接口已有 5MB 限制和 MIME 类型校验 |
| 2 | 极端数字输入 | ✅ 已修复 | 所有写入接口加入服务端数值范围校验 |
| 3 | 极端文本输入 | ✅ 已修复 | 所有字段统一做 trim + slice 截断 |
| 4 | 空状态 UI | ✅ 已有 | 各列表页均有空状态提示 |
| 5 | 并发提交（双击/多次点击） | ✅ 已修复 | 所有提交按钮加入 loading 状态防重复 |
| 6 | 网络中断 / Neon 冷启动 | ✅ 已有 | toast 错误提示 + try/catch 覆盖全部接口 |
| 7 | 角色权限隔离 | ✅ 已修复 | withAuth 前置验证 + demo/reset 限 OPERATOR |
| 8 | JWT 过期 / 401 自动跳转 | ✅ 已修复 | lib/api.ts 统一拦截 401 → 清 token → 跳 /enter |
| 9 | 页面刷新数据持久化 | ✅ 已有 | 购物车用 sessionStorage，刷新后恢复 |
| 10 | 数据库连接韧性 | ✅ 已有 | Neon serverless adapter + 连接池超时配置 |
| 11 | 大数据集内存/性能 | ✅ 已修复 | 所有 findMany 加 take 上限，防全表扫描 |
| 12 | 图片加载失败降级 | ✅ 已修复 | onError 回退到占位图或空灰块 |

---

## 详细修复记录

### 一、安全加固（withAuth 前置认证）

**修复前的问题：** `requireAuth` 在 DB 操作之后调用，且包在 `.catch(() => {})` 中被静默忽略，任何人均可写入数据。

**修复后：** 在 `lib/auth.ts` 中新增 `withAuth(req, handler, allowedRoles?)` 包装函数，认证在 DB 操作之前完成：

```typescript
export async function withAuth(
  request: Request,
  handler: (user: JwtPayload) => Promise<Response>,
  allowedRoles?: string[]
): Promise<Response>
```

**涉及文件（全部改用 withAuth）：**
- `api/customers` POST/PUT/DELETE
- `api/orders` POST / `api/orders/[id]` PUT/DELETE
- `api/invoices` POST / `api/invoices/[id]` PUT
- `api/pricelists` POST / `api/pricelists/[id]` PUT/DELETE
- `api/product-templates` POST / `api/product-templates/[id]` PUT/DELETE
- `api/products/[id]` PUT/DELETE
- `api/purchases` POST / `api/purchases/[id]` DELETE
- `api/stock-moves` POST
- `api/waves` POST / `api/waves/[id]` PUT/DELETE
- `api/trips` POST / `api/trips/[id]` PUT/DELETE
- `api/demo/reset` POST（仅限 OPERATOR 角色）

---

### 二、服务端数值校验

所有写入接口新增输入范围检查，防止数据库存入异常值：

| 接口 | 字段 | 限制 |
|------|------|------|
| `POST /api/purchases` | quantity | 1–100,000 |
| `POST /api/purchases` | unitCost | > 0，≤ 1,000,000 |
| `POST /api/orders` | 每个商品 qty | 1–10,000 |
| `POST /api/orders` | 每个商品 price | 0–1,000,000 |
| `POST /api/orders` | totalAmount | ≥ 0 |
| `POST /api/stock-moves` | qty | ≠ 0，绝对值 ≤ 100,000 |
| `PUT /api/product-templates/[id]` | listPrice | 0–1,000,000 |
| `PUT /api/product-templates/[id]` | standardPrice | 0–1,000,000 |
| `PUT /api/product-templates/[id]` | customerTaxRate | 0–1 |
| `PUT /api/products/[id]` | listPrice | 0–1,000,000 |
| `PUT /api/products/[id]` | standardPrice | 0–1,000,000 |

---

### 三、文本长度截断

所有字符串字段在写入前统一 `.trim().slice(0, N)`：

| 字段类型 | 最大长度 |
|----------|----------|
| 名称（商品名、供应商名、餐馆名等） | 200 字符 |
| 编号（内部编号、规格等） | 100 字符 |
| 地址 | 500 字符 |
| 备注 / 描述 | 500–2,000 字符 |
| 手机 | 50 字符 |
| 邮箱 | 200 字符 |

---

### 四、并发提交防护

以下页面所有提交按钮均新增 `loading` 状态，点击后立即禁用，`finally` 中恢复：

- `app/restaurant/page.tsx` — 支付按钮（`submitting` 状态）
- `app/operator/orders/page.tsx` — 生成拣货波次按钮（`generating` 状态）
- `app/operator/customers/page.tsx` — 保存客户按钮（`saving` 状态）
- `app/operator/invoices/page.tsx` — 生成发票按钮（`generating` 状态）
- `app/warehouse/page.tsx` — 入库保存、库存调整按钮（`purchaseSaving`、`adjustSaving` 状态）

---

### 五、JWT 过期自动跳转

`lib/api.ts` 的统一 fetch 封装现在处理 401 响应：

```typescript
if (res.status === 401) {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('veggie_token')
    window.location.href = '/enter'
  }
  throw new ApiError('登录已过期，请重新登录', 401)
}
```

---

### 六、大数据集查询上限

所有 `findMany` 接口加入 `take` 上限，防止全表扫描导致超时或内存溢出：

| 接口 | 默认上限 |
|------|----------|
| `GET /api/orders` | 500 条 |
| `GET /api/stock-moves` | 1,000 条 |

---

### 七、图片加载失败降级

- 商品列表 (`operator/products/page.tsx`)：图片加载失败时替换为灰色占位块
- 餐馆下单页 (`restaurant/page.tsx`)：商品图和购物车项图均有 `/placeholder.png` 回退

---

### 八、表单 step 属性补全

所有整数/小数数字输入框补全 `step` 属性，防止浏览器默认步长与业务不符：

- `operator/products/[id]` — 排序序号 `step="1"`
- `operator/pricelists/[id]` — 预览数量 `step={1}`、最小购买量 `step="any"`
- `operator/pricing` — 最小数量 `step="1"`、模拟数量 `step="1"`
- `operator/customers` — 信用额度 `step="0.01"`
- `warehouse` — 入库数量 `step="1"`、调整数量 `step="1"`
- `picker/wave/[id]` — 已拣数量 `step="1"`
- `driver/trip/[id]` — 退货数量 `step="1"`

---

## TypeScript 验证

```
npx tsc --noEmit
# 输出：（无错误）
```

所有修改通过 TypeScript 严格模式检查，零类型错误。
