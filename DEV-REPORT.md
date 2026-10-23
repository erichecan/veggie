# DEV-REPORT（20261023 续）：权限快照追平 + 按可售单位查看商品（搜索 / 基础价快速修改）

## 三、权限快照（CI 红了一个多月的 8 条权限守卫）

| 项 | 处理 | 结果 |
| --- | --- | --- |
| 4 个匿名入口（register、public/products、public/categories、cron/ledger-check） | 用户确认有意公开；逐个核对：register 限流 5 次/分钟只建 RESTAURANT 账号，public/* 不 select 价格库存且限流，cron 校验 x-cron-secret | 进匿名白名单并写明理由 |
| 39 个新 handler 不在快照/基线里 | 用仓库自带脚本只做加法；脚本跑完逐格比对新旧 JSON | 已有格 0 处变化 |
| `/api/products/[id]/pricelist-rules` | handler 没挂 require，旧 token 的仓库/外部销售能读价格规则 | 补 `require: master.pricelist.read` |
| 旧 token 白名单缺导出/新页面入口 | 按「列表与导出成对」补齐，只追平新体系已发的权限 | — |
| 5 格旧 token 比新体系严 | 登记例外：签 token 只有 login 一处，仓库首个提交起一律带 pm，7 天过期 | — |
| `npm test` | 本地全量 | ✅ 996 条 0 失败（7 条需真实库跳过） |

⚠️ 留给你决定的：新权限体系里 DRIVER 持有 `dispatch.trip.update`，因此也能调「统一补完成行程」（会把所有已标记完成波次的行程补成完成并结提成）。这是权限设计问题，本次没改。

## 四、按可售单位查看商品：搜索 + 基础售价/成本/毛重/装货顺序快速修改

截图红字需求：1. 搜索：产品名、description、产品分类、product spec；2. 产品的基础售价和 cost、毛重、装货顺序，快速修改。

| 场景 | 复现方式 | 状态 |
| --- | --- | --- |
| 搜索框按 名称 / 内部编号 / 描述 / 产品分类（中英文名）/ 产品规格（商品 spec + 各可售单位 spec）任一命中 | 商品 → 按可售单位查看商品 → 搜索框 | 符合（商品列表页的搜索口径不变） |
| 新增「基础售价」「基础成本」两列，每个商品第一行可直接改（= 商品的 listPrice / standardPrice） | 点第一行的基础售价/基础成本 | 符合 |
| 改完基础价，各单位的售价/成本按新基础价自动换算 | 改完看同一商品其它行 | 符合 |
| 毛重：有可售单位的改该单位；没配可售单位的商品也能改（写商品自己的毛重） | 点毛重 | 符合 |
| 装货顺序：有可售单位的行可改（原本就支持）；没配可售单位的商品没有可存的位置，悬停有提示 | 点装货顺序 | 符合 |

## 验证结果（第四部分）

| 用户流程 | 验证方式 | 结果 |
| --- | --- | --- |
| 搜索 8 个词（pepper / 彩椒 / 中式蔬菜 / Chinese / 10*200g / 5kg / 4*500 / zzz） | curl GET /api/products/by-sale-unit?search= | ✅ 分别命中名称/描述/分类中英文/商品规格/单位规格，zzz 0 条 |
| 改基础售价 4.60→5.00、基础成本 3.00→3.20 | Playwright | ✅ BAG(×5) 售价 23→25、成本 15→16；100克 0.46→0.50、0.30→0.32；库里 listPrice/standardPrice 已更新，最后更新人=运营主管 |
| 第二行基础价不可改 | Playwright 读悬停提示 | ✅「基础售价/成本是整个商品共用的，请在这个商品的第一行修改」 |
| 没配可售单位商品改毛重 2.10→2.35 | Playwright + 查库 | ✅ Product.weight=2.35 |
| 有可售单位的改毛重 5.20→5.40 | Playwright + 查库 | ✅ ProductSaleUom.grossWeight=5.40 |
| 输入 -3 | Playwright | ✅ 提示「请输入合法的非负数字」，不提交 |
| 按基础售价排序 | Playwright | ✅ 5.00 → 14 → 31 → 125 |
| 浏览器控制台 / dev 日志 | Playwright + grep | ✅ 无错误 |
| tsc / eslint / npm test | 本地 | ✅ 0 error；996 条 0 失败 |

**涉及文件**：`app/api/products/by-sale-unit/route.ts`、`app/[locale]/classic/operator/products/by-sale-unit/page.tsx`、`lib/types.ts`、`app/api/products/[id]/route.ts`（变更日志补记 weight）。

---

# DEV-REPORT（20261023）：价格表「最后更新人」+ 客户列表直接增加/减少/替换价格表

本轮两个需求，同一个 PR：
1. 「价格表里需要增加最后更新人，然后都要有筛选功能，排序功能」
2. 客户列表截图：「浮层错位了」+ 标注「价格表的修改，增加/减少/替换 价格表」（已确认是新需求，一起做）

---

# 二、客户列表：价格表一格可增加 / 减少 / 替换，修复浮层错位

## 给你看的

| 场景 | 复现方式 | 状态 |
| --- | --- | --- |
| Edit 模式点客户的「价格表」格子，弹出编辑面板，紧贴在这一格下面 | 客户 → Mode 切到 Edit → 点价格表 | 符合 |
| **替换**：点面板里某个价格表的名字 → 搜索 → 选新的 | 面板内 | 符合 |
| **减少**：点 × 移除 | 面板内 | 符合 |
| **增加**：「+ 添加价格表」→ 搜索 → 回车/点选；没挂价格表的客户点开直接进入添加 | 面板内 | 符合 |
| 调优先级：↑ / ↓（1 = 优先级最高，跟客户详情页同一套顺序） | 面板内 | 符合 |
| 改完点「保存」一次提交；「取消」/ Esc / 点外面 = 不保存 | 面板内 | 符合 |
| 同一价格表不能挂两次（搜索列表里自动排除已挂的） | 面板内 | 符合 |
| Read 模式仍是原来的只读「挂靠的价格表」列表 | Mode 切回 Read | 符合 |

**「浮层错位」是什么、怎么修的**：以前 Edit 模式下这一格点文字弹的是只读浮层（改不了），点空白处才进编辑，
进编辑时格子里换成输入框，整张表重新排版、各列横向跳动（实测「价格表」列 x 从 1058 跳到 1015，「地址」列也跟着动）。
现在 Edit 模式只有一个编辑面板，浮在表格上方、对齐这一格，单元格本身尺寸不变，打开/保存前后各列位置完全不动
（实测 地址/价格表/Price Type 列 x 始终 459/1074/1275）。

**顺带修的一个隐患**：保存客户时，旧代码先单独删掉客户的全部价格表、再更新客户。
更新一旦失败（比如 Sage Account 撞号返回 409），客户的价格表就全没了。现在删旧+建新跟客户更新放在同一次写入里，失败就整体不动。

## 验证结果

| 用户流程 | 验证方式 | 结果 |
| --- | --- | --- |
| Edit 模式点开面板，表格不重排 | Playwright 量三列列头 x 坐标：打开前/打开后/保存后 | ✅ 完全一致 |
| 面板位置 | Playwright：触发格下沿 y=235 → 面板顶 y=239，左边对齐 | ✅ |
| 替换 + 移除 + 添加 + 上移 后保存 | Playwright 操作 Achara（TAKEAWAY菜价/MUSASHI/TAKEAWAY-2菜价）→ 查库 | ✅ 库里变成 1.TAKEAWAY菜价 2.LINKEE 3.CITY CENTRE菜价，提示「已保存」，最后修改人=运营主管 |
| 取消 / Esc | Playwright | ✅ 不提交，格子不变 |
| 空客户添加 | Playwright 操作 Bamboo Garden | ✅ 挂上 MUSASHI |
| Edit ↔ Read 来回切后只读浮层仍能打开 | Playwright | ✅（开发中发现切换后打不开 + 控制台报 controlled/uncontrolled，已修） |
| 重复 id / 空 id | curl PUT `["pl_42","pl_42","pl_35",""]` | ✅ 存成 pl_42、pl_35 两条 |
| 更新失败不丢价格表 | curl PUT 价格表 + 撞号 Sage Account | ✅ 409，价格表原样保留 |
| 清空 / 只改别的字段 | curl PUT `[]` / 只传 creditLimit | ✅ 清空 / 价格表不动 |
| 浏览器控制台 | Playwright pageerror + console.error | ✅ 无错误 |
| tsc / eslint / npm test | 本地 | ✅ tsc 0 error；npm test 996 条中 8 条失败，与 main 上完全相同（权限快照，见 PR 说明），本轮未新增 |

**涉及文件**：新增 `components/classic/PricelistLinksEditor.tsx`；改 `app/[locale]/classic/operator/customers/page.tsx`、`app/api/customers/[id]/route.ts`。

---

# 一、价格表列表新增「最后更新人」列，所有列可筛选、可排序

## 给你看的

| 场景 | 截图/复现方式 | 状态 |
| --- | --- | --- |
| 价格表列表新增 **Last Updated by** 列（在 Last Updated on 右边） | 销售 → 价格表 | 符合 |
| 谁改了价格表就记谁：详情页保存、列表行内编辑、新建/复制、CSV 批量导入、删除商品连带移除价格规则 | 改任意价格表后回列表看该列 | 符合 |
| Last Updated by 可筛选：列头 ▼ 下拉勾选人名（含「（空）」）；Filters 面板也可按最后更新人筛选；Group By 可按最后更新人分组 | 列头 ▼ | 符合 |
| 每一列都能排序：Pricelist Name / Last Updated on / Last Updated by / Currency / Selectable | 点列头 | 符合（新增后三列的排序） |
| 每一列都能筛选：名称、币种（文本框）、更新时间（📅 日期区间）、最后更新人、Selectable（▼ 是/否） | 列头 | 符合（新增后两列的筛选） |

**待你确认的点（数据现状，不是功能缺失）：**
- 历史价格表此前从没记录过修改人。迁移只回填**能从操作日志证实**的：该价格表最近一条日志恰好写在它当前更新时间之后 10 分钟以内的才认。
  截图里那一大批「08/10/2026 19:08」的价格表是当时数据迁移/脚本统一改的，没有对应的人，**会显示为「—」**；之后有人再改一次就会正常显示。这是刻意不编造身份（同 Product.updatedBy 的做法）。
- 排序时没有更新人的行，不论升降序都排在最后。

## 测试账号（本地验证库，非生产）

| 角色 | 账号 | 密码 |
| --- | --- | --- |
| 运营主管 | `prisma/seed.ts` 里的 OPERATOR 种子账号 | Test12345678（SEED_PASSWORD） |
| 老板 | `prisma/seed.ts` 里的 BOSS 种子账号 | Test12345678（SEED_PASSWORD） |

本地库：`prisma db push`（改动前 schema）→ 手动执行新迁移 SQL → `prisma/seed.ts`（97 个价格表）→ `scripts/rbac/apply-data-migrations.ts`。

## 验证结果

| 用户流程 | 验证方式 | 结果 |
| --- | --- | --- |
| 迁移回填规则 | 构造 6 个价格表 + 操作日志后执行迁移 SQL | ✅ 日志晚 2s → Alice；userName 为空 → 用邮箱 bob@x；两条日志 → 取最新的 Dave；日志早于更新时间 / 晚 20 分钟 / 无日志 → 空 |
| 列表接口带出 updatedBy | curl GET /api/pricelists | ✅ |
| 详情页保存记更新人 | curl PUT /api/pricelists/:id（故意传 updatedBy=HACKER） | ✅ 记为登录人「运营主管」，客户端传的被忽略 |
| 新建/复制记更新人 | curl POST /api/pricelists（故意传 updatedBy=HACKER） | ✅ 记为「运营主管」 |
| CSV 批量导入记更新人 | curl POST /api/pricelists/bulk（老板账号，1 更新 + 1 新建） | ✅ 两条都记为「老板」 |
| 不存在的价格表 | curl PUT /api/pricelists/nope | ✅ 404「价格表不存在」 |
| 未登录修改 | curl PUT 不带 token | ✅「未授权访问」 |
| 列头 ▼ 筛选最后更新人 | Playwright 勾选「老板」 | ✅ 只剩 MUSASHI、Bulk brand new 两行 |
| 按最后更新人升序/降序 | Playwright 点列头两次 | ✅ 有名字的按名字排，空的排最后 |
| Selectable / Currency 排序、Selectable ▼ 是/否 | Playwright | ✅ |
| Group By 最后更新人 | Playwright | ✅ 按人分组，空的归「（空）」 |
| 浏览器控制台 / dev 服务器日志 | Playwright pageerror + console.error；grep dev.log | ✅ 无错误 |
| 类型检查 / lint | `tsc --noEmit`；eslint 改动文件 | ✅ 0 error（仅与原代码同类的未使用变量 warning） |

## 已知不可用功能

无。

## 存档用的

**涉及文件**：
- `prisma/schema.prisma`、`prisma/migrations/20261023000001_pricelist_updated_by/migration.sql`：`OdooPricelist.updatedBy TEXT` + 有据回填
- `app/api/pricelists/route.ts`（POST）、`app/api/pricelists/[id]/route.ts`（PUT）、`app/api/pricelists/bulk/route.ts`（导入）：写入 `user.name || user.email`，不信客户端
- `lib/pricelist-rule-log.ts`、`app/api/products/[id]/route.ts`：删商品连带删价格规则时记删商品的人
- `app/[locale]/classic/operator/pricelists/page.tsx`：新列、列头多选筛选（状态随 sessionStorage 保存、「清除」一并清掉）、全部列排序、Filters/Group By 增加最后更新人；行内编辑后用服务端返回值刷新更新时间/更新人
- `lib/types.ts`：`OdooPricelist.updatedBy`
