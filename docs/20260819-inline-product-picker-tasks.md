# 统一「加商品」交互：编辑态复用新建态的行内选品

客户 20260818 反馈：quotation / sale order **Edit 时的加商品模块**与**新建时**是两套实现，
导致 Tab / Enter 行为不一致。20260814 曾试图只统一「字段上的键盘处理」
（`lib/order-line-keys.ts`），没解决——补丁打在了错的层上：**加商品的交互模型本身就是两套**。

本次要求：让两边跑同一份代码；业务逻辑（定价、提交）仍各写各的。

## 已定的三条（用户 20260819 拍板）

1. 编辑页多出的 4 列（Internal Reference / Quantity On Hand / Delivered Qty / Invoiced Qty）**保留**，
   共享组件支持额外列。
2. **只有新加的行能选商品**，已存在的行 Product 列保持只读
   （换 productId 会牵动价格快照、提成快照、拣货锁与库存流水，风险太高）。
3. 新建页底部 `Configure a product / Add a section / Add a note` 三个死按钮**删除**；
   两边都只留 `+ Add a product`。

## ⛔ 一条不守住就会打坏保存

`app/api/orders/[id]/route.ts:381` 用 **`if (l.id)`** 区分 update / create：

- `l.id` 有值 → `orderLine.update({ where: { id } })`
- `l.id` 为空 → `orderLine.create(...)`

编辑页现在给新行的 id 是**空串**，多个新行的 React `key` 会撞车（现存隐患，
被「底部搜索框一次只加一行」掩盖了）。改造后新行需要临时 id 才能正确渲染，
**但提交前必须把临时 id 清回空串**，否则后端会拿一个不存在的 id 去 update，保存直接失败。

## 任务

- [x] T1 抽出行内选品 hook，新建页接入（纯重构，行为零变化）
      验收：新建页点 Product 单元格就地搜索、↑↓ 移动、Enter 选中并开下一行、
            Tab 选中并聚焦描述框、Esc 关闭、外点关闭 —— 全部与改造前一致；
            `place-order/page.tsx` 不再持有 activeLineId/lineSearch/dropRect/handleLineKey
      产出：components/classic/useInlineProductPicker.tsx、OrderLineEditor.tsx、place-order/page.tsx
      依赖：无

- [x] T2 新建页删掉三个死按钮，footer 收口到 OrderLineEditor
      验收：新建页底部只剩 `+ Add a product`；点击行为不变
      产出：OrderLineEditor.tsx、place-order/page.tsx
      依赖：T1

- [ ] T3 临时 id 清空的单元测试（先写，锁住上面那条约束）
      验收：新行提交 payload 的 id 必须是空串；已有行的 id 必须原样保留
      产出：lib/order-line-draft.ts、tests/order-line-draft.test.ts
      依赖：无

- [ ] T4 报价单编辑页接入
      验收：Edit 态下 `+ Add a product` 插空行 → 行内选品 → Tab/Enter 走位与新建页一致；
            已有行 Product 只读；保存后回查数据库确认新行是 create 出来的真实记录
      产出：quotations/[id]/page.tsx
      依赖：T1 T2 T3

- [ ] T5 销售单编辑页接入
      验收：同 T4
      产出：orders/[id]/page.tsx
      依赖：T4

- [ ] T6 真浏览器端到端验证两页
      验收：新建/编辑各走一遍加商品 + Tab + Enter；编辑页保存后回查 DB
      依赖：T5

## T1/T2 验证记录（20260819，真浏览器）

验证库：本地 docker PG 5433 `veggie_uiverify`（`db push` + 补跑 8 个权限迁移）。
⚠️ `prisma migrate deploy` 在**全新空库**上跑不通（`20260419_decimal_partner_indexes` 事务中止），
只能 `db push`；权限数据要另外补，且用户必须挂 `UserRoleLink` 才有权限位图——
`roles[]` 数组不产生权限，`resolveUserPermissions` 只读 roleLinks。
另：dev server 必须显式传 `JWT_SECRET`，否则 middleware 退回内置 fallback，所有页面 307 回 /enter。

新建页逐条实测，与改造前一致：

| 行为 | 结果 |
|---|---|
| `+ Add a product` 插空行并自动进搜索态 | ✅ 自动聚焦 |
| 下拉出现候选 | ✅ |
| Enter 选中 → 自动开下一行、焦点回搜索框（连续录入） | ✅ |
| Tab 选中 → 焦点落到本行描述框 | ✅ `data-desc-line` |
| ↑↓ 移动高亮 | ✅ 0→1→2→1 |
| Esc 关闭下拉 | ✅ |
| 点已有行商品格可重选 | ✅（新建页语义不变） |
| 三个死按钮已消失 | ✅ |
