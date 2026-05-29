# Veggie Demo 扩展设计文档

**日期：** 2026-04-11  
**项目：** veggie-demo  
**状态：** 待实施

---

## 一、背景

在现有 6 个角色（运营/餐馆/拣货员/分货员/司机/老板）基础上，扩展以下能力：
1. 新增财务视角
2. 老板视角补充今日订单数
3. 新增仓库管理员视角（含采购记录）
4. 流程变更：生成拣货单时同步预建配送行程
5. 仓库 SVG 地形图（基于手绘重绘）
6. 拣货单界面展示可高亮地形图

---

## 二、数据模型变更

### 2.1 Customer 新增字段

```typescript
export interface Customer {
  // 现有字段...
  paymentTerm: 'cash' | 'weekly' | 'monthly'  // 现付 / 周结 / 月结
}
```

**Mock 数据分配：**
- Hang Dai Chinese → `weekly`
- Good World → `monthly`
- Pearl River → `cash`
- Ka Shing → `weekly`

### 2.2 新增 PurchaseRecord 类型

```typescript
export interface PurchaseRecord {
  id: string
  productId: string
  productName: string
  spec: string
  quantity: number      // 入库数量
  unitCost: number      // 进货单价（€）
  supplier: string      // 供应商名
  arrivedAt: string     // 到货时间（ISO）
  createdAt: string
}
```

**Mock 数据：** 近 7 天，覆盖 6 种商品，约 15 条记录，2-3 个供应商。

### 2.3 AppStore 新增字段

```typescript
export interface AppStore {
  // 现有字段...
  purchases: PurchaseRecord[]
}
```

### 2.4 Role 新增两个值

```typescript
export type Role = 'operator' | 'restaurant' | 'picker' | 'sorter' | 'driver' | 'boss' | 'finance' | 'warehouse'
```

### 2.5 Trip 新增"待指定"状态支持

`driverId` 和 `driverName` 改为可选，允许为空（预建行程时司机待定）：

```typescript
export interface Trip {
  // 现有字段...
  driverId?: string      // 可选（预建行程时为空）
  driverName?: string    // 可选
}
```

---

## 三、流程变更：生成拣货单同步预建行程

### 变更位置
`app/operator/orders/page.tsx` → `generateWave()` 函数

### 逻辑
1. 生成 `PickingWave` 后，立即创建一条 `Trip`：
   - `status: 'pending'`
   - `driverId: ''`，`driverName: '待指定'`
   - `restaurants`：从波次关联订单中聚合所有餐馆站点
   - `departTime`：空字符串（待定）
2. 同时调用 `StoreAPI.addTrip(trip)`
3. toast 提示："已生成拣货波次并预建配送行程，请前往配送行程页指定司机"

### 配送行程页变更（`app/operator/trips/page.tsx`）
- 待指定行程（`driverName === '待指定'`）显示橙色"待指定司机"标签
- 点击行程打开详情弹窗，新增"指定司机"和"设置出发时间"编辑功能
- 取消原有"+ 创建行程"按钮（行程由系统自动生成）

---

## 四、新增页面

### 4.1 财务视角 `/finance`

**路由：** `app/finance/`  
**布局：** 复用现有 layout 模式（含角色 header）

**页面内容：**

**顶部指标卡（今日）：**
- 现收金额（`paymentMethod === 'cash'` 的已完成订单）
- 转账金额（`paymentMethod === 'online'` 的已完成订单）
- 未结款总额（所有未完成订单中 weekly/monthly 客户的金额合计）

**未结款清单（表格）：**

| 客户 | 结算方式 | 本期未结 | 历史欠款 | 合计 |
|------|----------|---------|---------|------|
| Hang Dai | 周结 | €XX | €XX | €XX |

- 本期未结：`status !== 'completed'` 的订单
- 历史欠款：mock 固定数据（模拟上期未清）
- 按 weekly / monthly 分组展示

**数据来源：** `StoreAPI.getOrders()` + `StoreAPI.getCustomers()`

### 4.2 仓库管理员视角 `/warehouse`

**路由：** `app/warehouse/`

**页面 Tab 设计（4 个 Tab）：**

#### Tab 1：今日进货
- 列表：今日（到货时间 = 今天）的采购记录
- 显示：供应商、商品、规格、数量、进货单价

#### Tab 2：今日出货
- 来源：今日已完成行程关联订单的商品汇总
- 显示：商品名、规格、出货总量

#### Tab 3：库存总览
- 商品库存表：名称、规格、当前库存
- 库存 ≤ 20：红色"需补货"标签
- 7 天内无订单出货：橙色"滞销预警"标签
- 顶部提示卡："建议每周五进行库存清点"

#### Tab 4：采购记录
- 近 30 天所有采购记录（按到货时间倒序）
- 显示：商品、供应商、数量、单价、到货时间

**数据来源：** `StoreAPI.getPurchases()`（新增）、`StoreAPI.getProducts()`、`StoreAPI.getOrders()`、`StoreAPI.getTrips()`

### 4.3 老板视角补充

在 `app/boss/page.tsx` 中，将「今日订单数」从副标题升级为独立 stat 卡片（当前 4 卡片 → 5 卡片，调整为 2+3 或 wrap 布局）。

---

## 五、仓库 SVG 地形图

### 5.1 组件位置
`components/warehouse/WarehouseMap.tsx`

### 5.2 平面图布局（一楼）

```
┌─────────────────────────────────┐
│            包装盒               │
├──────────┬──────────────────────┤
│  大袋货  │       米面油         │
├──────────┤                      │
│          │       调料筐         │
│  冷藏库  ├──────────────────────┤
│ ┌──────┐ │                      │
│ │叶菜区│ │                      │
│ │根茎区│ │       分拣区         │
│ │菌菇区│ │     （大区块）       │
│ └──────┘ │                      │
├──────────┤                      │
│  冷冻库  ├──────────────────────┤
│          │   办公室 / 点单区    │
└──────────┴──────┬───────────────┘
                  │ 门
```

### 5.3 区块映射

| 拣货区名 | 地图高亮区块 |
|---------|------------|
| 叶菜区  | 冷藏库-叶菜区子块 |
| 根茎区  | 冷藏库-根茎区子块 |
| 菌菇区  | 冷藏库-菌菇区子块 |
| 配送区  | 分拣区 |

### 5.4 Props 接口

```typescript
interface WarehouseMapProps {
  highlightZones?: string[]   // 当前需要高亮的区名，如 ['叶菜区', '根茎区']
  className?: string
}
```

高亮区块：绿色填充 + 绿色边框脉冲动画；非高亮区块：灰色填充。

### 5.5 嵌入位置

`app/picker/wave/[id]/page.tsx`（拣货详情页）：
- 在页面顶部或侧边展示 `WarehouseMap`
- `highlightZones` 传入当前未完成的分区名称列表
- 随拣货进度动态更新高亮

---

## 六、入口注册

### 6.1 mock-data.ts 新增

```typescript
export const DEMO_FINANCE = [{ id: 'fin_001', name: 'Finance - Mary' }]
export const DEMO_WAREHOUSE = [{ id: 'wh_001', name: 'Warehouse - Tom' }]
```

### 6.2 app/page.tsx 新增两张角色卡片

- 财务人员（💳 蓝色系）
- 仓库管理员（🏗️ 黄色系）

### 6.3 app/guide/page.tsx 新增步骤

在第 6 步（生成拣货波次）后补充说明：系统同时预建行程；  
新增财务和仓库的演示步骤（可选 optional）。

### 6.4 types.ts Role

```typescript
export type Role = 'operator' | 'restaurant' | 'picker' | 'sorter' | 'driver' | 'boss' | 'finance' | 'warehouse'
```

---

## 七、不做的事（YAGNI）

- 不新增采购经理角色（录入采购记录的功能留给未来正式版）
- 不做财务报表导出
- 不做仓库地图的路径规划功能
- 不做历史欠款的动态计算（用 mock 固定值演示即可）

---

## 八、文件变更清单

| 文件 | 操作 |
|------|------|
| `lib/types.ts` | 修改 Customer、Trip，新增 PurchaseRecord、扩展 Role |
| `lib/mock-data.ts` | 新增 DEMO_FINANCE、DEMO_WAREHOUSE、MOCK_PURCHASES，更新 DEMO_CUSTOMERS |
| `lib/store.ts` | 新增 purchases 字段，新增 StoreAPI.getPurchases() |
| `app/operator/orders/page.tsx` | generateWave() 同步创建 Trip |
| `app/operator/trips/page.tsx` | 支持待指定行程编辑；移除手动创建按钮 |
| `app/finance/page.tsx` | 新建 |
| `app/finance/layout.tsx` | 新建 |
| `app/warehouse/page.tsx` | 新建 |
| `app/warehouse/layout.tsx` | 新建 |
| `app/boss/page.tsx` | 新增订单数卡片 |
| `components/warehouse/WarehouseMap.tsx` | 新建 SVG 地形图组件 |
| `app/picker/wave/[id]/page.tsx` | 嵌入 WarehouseMap |
| `app/page.tsx` | 新增财务/仓库角色卡片 |
| `app/guide/page.tsx` | 补充新步骤 |
