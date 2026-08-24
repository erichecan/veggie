# DEV-PLAN — 信息广场（内部消息布告栏）

> 更新日期：2026-08-24
> 读取依据：无独立 PRD 文档；需求由用户对话直接描述并经多轮澄清确定。
> 触发背景：同事们目前把"哪个商品缺货了""供应商调价了""仓库到了什么货"这类信息发在微信群里，容易丢、不好查。想做一个内部"信息广场"沉淀这些信息。

---

## 0. 已确认的产品决策（对话澄清结果）

| 问题 | 决策 |
|---|---|
| 定位 | 消息广场，不是论坛——**不做点赞/评论/热度排序**，纯发布+浏览 |
| 本轮范围 | 只做**人工发帖** + 分类筛选 + 搜索 + 置顶 + 时间线。系统自动发帖（缺货预警/到货通知/调价提醒）列入 Phase 2，本轮不做，但 schema 预留字段避免二次迁移 |
| 发帖权限 | 所有**内部**登录用户都能发（不含 `RESTAURANT` 客户门户账号） |
| 可见范围 | 只对内部员工开放，客户看不到 |
| 分类 | 固定四类：缺货 / 到货 / 调价 / 其他（不开放自由 tag） |
| 图片 | 支持，复用 `getObjectStore()` 抽象（S3 兼容，符合部署铁律） |
| 置顶 | 保留置顶功能。`BOSS`/`OPERATOR` 可置顶、可删任意帖；其他人只能删自己的帖子 |
| ⚠️ 保密红线 | **价格、成本类具体数字禁止出现**在广场里——包括 Phase 2 的"调价提醒"系统贴，届时只能提示"XX商品供应商价格有调整"，不带金额；人工发帖前端也要有一句提示语提醒不要贴价格/成本截图 |

---

## 1. 模块拆解

| # | 模块 | 范围 | 需要 schema | 
|---|------|------|:---:|
| A | `BulletinPost` 数据模型 + migration | 新表 | 是 |
| B | API：列表(筛选/搜索/分页)、发帖、删帖、置顶/取消置顶 | `app/api/bulletin-posts/**` | 否 |
| C | 图片上传 | 复用 `/api/upload-image`，需要把 `ALLOWED_ROLES` 放开给发帖允许的角色，或新增独立上传口径 | 否（改现有文件） |
| D | 页面：信息广场（发帖框 + 分类筛选 + 搜索框 + 时间线列表，置顶帖单独顶部区块） | `app/[locale]/classic/bulletin/page.tsx` | 否 |
| E | 权限接入：路由表登记 + 各内部角色导航栏加入口 | `lib/rbac/route-map.ts` + 各 layout 导航 | 否 |

---

## 2. Schema 设计

```prisma
enum BulletinCategory {
  SHORTAGE      // 缺货
  ARRIVAL       // 到货
  PRICE_CHANGE  // 调价（内容禁止带具体金额，产品层面约束，非数据库约束）
  OTHER
}

enum BulletinSource {
  MANUAL // 同事手动发布
  AUTO   // 系统自动生成（Phase 2 才会真正写入，本轮枚举先建好）
}

model BulletinPost {
  id            String            @id @default(cuid())
  category      BulletinCategory
  source        BulletinSource    @default(MANUAL)
  content       String            @db.Text
  imageUrl      String?

  authorId      String?
  author        User?             @relation("BulletinPostAuthor", fields: [authorId], references: [id])

  pinned        Boolean           @default(false)
  pinnedAt      DateTime?
  pinnedByUserId String?
  pinnedBy      User?             @relation("BulletinPostPinnedBy", fields: [pinnedByUserId], references: [id])

  createdAt     DateTime          @default(now())

  @@index([category, createdAt])
  @@index([pinned, createdAt])
}
```

- `authorId` 允许空，是为 Phase 2 的 AUTO 贴留的（系统发帖没有人类作者）。
- 不做软删除：删除就是物理删除，符合"布告栏"的定位（不是需要审计追溯的正式单据）。
- 不加 `title` 字段——一句话文字信息不需要标题，参考微信群消息的形态。

---

## 3. API 设计（`app/api/bulletin-posts/`）

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/bulletin-posts` | 登录即可 | 支持 `?category=` `?q=`(全文关键词) `?cursor=`分页；置顶帖始终排在最前，其余按 `createdAt` 倒序 |
| POST | `/api/bulletin-posts` | 登录即可 | body: `category` `content` `imageUrl?`；`authorId` 取自 token，不接受前端传入 |
| DELETE | `/api/bulletin-posts/[id]` | 登录即可，handler 内校验：本人 或 `BOSS`/`OPERATOR` 角色 | 非本人非管理角色返回 403 |
| PATCH | `/api/bulletin-posts/[id]/pin` | handler 内校验角色为 `BOSS`/`OPERATOR` | body: `{ pinned: boolean }` |

**权限点决策（需要你确认）**：这个模块打算**不接入**现有的可配置权限点体系（`lib/rbac/catalog.ts` + sortkeys 同步），而是直接在路由表登记 `permission: null`（登录即可，和 `/api/notifications/**` 同款），管理动作（删任意帖/置顶）在 handler 内部硬判断 `BOSS`/`OPERATOR` 角色。

理由：信息广场本身的产品定位就是"不被管控"，接入正式权限点意味着要在配置页给每个角色勾选一遍"能不能看广场""能不能置顶"，这和"所有人都能发布"的定位矛盾，还会多背一次 sortkeys 同步的操作成本。

如果你觉得这样不够规范、以后想在权限配置页里能单独关掉某个角色的发帖权，告诉我，我改成走正式权限点（多两个权限点：`bulletin.post.create`、`bulletin.post.manage`）。

---

## 4. 页面设计

`/classic/bulletin`（新顶层前缀，不挂在任何现有角色目录下）

- 顶部：发帖框（分类下拉 + 文字输入 + 图片上传按钮），提交后插入列表最前
- 筛选：分类 tab（全部/缺货/到货/调价/其他）+ 关键词搜索框
- 列表：置顶帖单独一个"置顶"分组在最上方，其余按时间倒序；每条显示作者、角色、时间、分类标签；本人或管理角色能看到删除按钮，管理角色能看到置顶/取消置顶按钮
- 空状态：无数据时给出引导文案，不是空白页

**导航入口**：加进 `OPERATOR` / `BOSS` / `FINANCE` / `WAREHOUSE` / `ACCOUNTING` 这五个内部办公角色的导航栏。`DRIVER` / `SORTER` 导航本轮不改（页面本身不限权限，能直接访问 URL，只是暂不在他们的菜单里放入口）——这条算"本轮明确不做"，如果需要一起加，告诉我。

---

## 5. Phase 2（本轮不做，仅记录路线图）

三类自动系统贴的挂钩点（已确认代码里存在对应事件）：

| 类型 | 触发点 | 内容口径（⚠️禁止带金额） |
|---|---|---|
| 缺货预警 | `Product.qtyOnHand` 降到 ≤0 或低于阈值（阈值字段待定） | "XX商品缺货了" |
| 到货通知 | `GoodsReceipt` 完成收货 | "XX商品到货N箱"（数量可以，金额不行） |
| 调价提醒 | 新采购单价 vs 上一次采购单价出现变化 | "XX商品供应商价格有调整，详情联系采购"——不带具体单价/涨跌幅度 |

---

## 6. 风险点

- 图片上传当前 `ALLOWED_ROLES` 只有 `OPERATOR/BOSS/WAREHOUSE/FINANCE`，`SALES`/`ACCOUNTING`/`DISPATCH` 等角色发帖若要带图会被现有接口拒绝——需要决定是放开这个白名单，还是广场帖子的图片走独立上传口径。
- 全文搜索用 Postgres `ILIKE` 足够（量级预计不大），不引入额外搜索引擎。
- 这是新模块+新表，按项目惯例走本 DEV-PLAN 确认流程，暂不涉及生产数据、不涉及 GCP 资源。

---

## 需你确认

1. §3 的权限口径（不接正式权限点，管理动作硬判断角色）能接受吗？
2. §4 导航入口只加 5 个内部办公角色，`DRIVER`/`SORTER` 本轮不加，可以吗？
3. §6 图片上传角色白名单要不要一起放开？

回复"确认，开始开发"（或指出要改的点）后我再动手。
