# 拣货单设计文档

## 一、原始设计：按波次 + 商品分区汇总

### 概念

系统按**拣货波次（PickingWave）**组织仓库拣货工作。一个波次包含若干张已确认的餐馆订单，波次内的所有商品按**仓库分区（Zone）**汇总，形成一张"拣货单"，由仓库拣货员执行。

### 数据流

```
多张已确认订单
  → 聚合所有商品（按 productId 合并，累加数量，记录涉及餐馆）
  → 按仓库分区分组（getZone 函数根据商品名称映射到 A区/B区/冷区 等）
  → 生成 PickingWave.zones（JSON 字段）
  → 同时创建关联 Trip（driverId = null，待后续指定司机）
```

### 拣货单格式

拣货员看到的是**分区视图**：

```
[波次编号] — 拣货单
  📦 A区（蔬菜）
    土豆        需拣: 50kg   涉及餐馆: A餐馆、B餐馆
    西红柿      需拣: 30kg   涉及餐馆: B餐馆
  📦 B区（干货）
    大米        需拣: 100kg  涉及餐馆: A餐馆
  📦 冷区
    猪肉        需拣: 20kg   涉及餐馆: A餐馆、C餐馆
```

### 问题

- 司机信息在波次创建时不绑定，Trip 的 `driverId` 为 null
- 拣货单打印出来没有司机/配送批次信息
- 仓库不知道这批货是谁来取、何时取

---

## 二、新设计（方案 A）：创建波次时必须绑定司机批次

### 变更动机

客户需求：**拣货单必须按司机批次产生**。每张拣货单对应一个司机的一次配送，这样仓库在拣货时就能清楚地知道货物归属，并在拣货单打印件上显示司机和配送时段。

### 核心规则

> **一个波次 = 一个司机 + 一个配送时段（AM/PM）**

创建波次时必须：
1. 选择司机（从系统注册的 DRIVER 角色用户中选取）
2. 选择配送时段（AM 上午 / PM 下午）
3. 选择要合入波次的已确认订单

系统自动：
- 创建 PickingWave（商品分区数据不变）
- 创建关联 Trip（waveId 绑定，driverId/driverName/timeSlot 立即填入）
- 将所选订单状态更新为 WAVE_ASSIGNED

### 拣货单格式（变更后）

拣货单头部增加司机和时段信息，用于打印：

```
[波次编号] — 拣货单
司机: 张师傅 | 配送时段: 上午 | 打印时间: 2026-05-09 08:30

  📦 A区（蔬菜）
    土豆        需拣: 50kg   涉及餐馆: A餐馆、B餐馆
    ...
```

### 数据流（变更后）

```
用户操作：
  1. 勾选已确认订单
  2. 选择司机 + 时段（新增步骤）
  3. 点击「合并生成波次」

系统执行：
  → apiPost('/api/waves', { orderIds, zones })  — 创建波次（同原来）
  → apiPost('/api/trips', {
       orderIds,
       driverId,          // 真实司机ID（原来是 null）
       timeSlot,          // 'AM' | 'PM'（原来缺失）
       deliveryBatch: null
     })                   — 创建关联行程（走 trips 新流程，传 orderIds）
```

### 变更文件清单

| 文件 | 变更内容 |
|------|---------|
| `app/api/trips/route.ts` | GET 增加 `?waveId=xxx` 过滤；无需改 POST |
| `app/[locale]/classic/operator/waves/page.tsx` | 加载 DRIVER 用户列表；在"合并生成波次"前弹出司机+时段选择面板 |
| `app/[locale]/classic/operator/waves/[id]/page.tsx` | 通过 `?waveId` 查询关联 Trip，在详情页和打印头显示司机信息 |

### 不变的部分

- 拣货单的**商品分区汇总逻辑**完全不变（仍按 getZone 分区）
- PickingWave 数据结构不变
- Trip / PickingWave DB schema 不变（Trip 原本就有 `waveId`、`driverId`、`timeSlot` 字段）
- 拣货员看到的分区视图不变
