# 审计后续修复 — 任务台账

> 起始：2026-08-02（接 `docs/20260802-contract-feature-audit-tasks.md` 的三条遗留决策）
> 用户已拍板三项全做。**台账是进度的唯一真相。**

## 状态汇总

| 周期 | 任务 | 状态 | commit |
|---|---|---|---|
| D1 | F1 PUBLIC_API_ROUTES 回归测试 | [x] | |
| D2 | F2 摘掉利润表死链入口 | [ ] | |
| D3 | F3 补应付账龄报表（API + 页面） | [ ] | |
| D4 | F4 备份落点改 S3 兼容存储 | [ ] | |
| D5 | F5 验证 + 部署 + 生产实测 | [ ] | |

---

## 任务明细

### F1 PUBLIC_API_ROUTES 回归测试
把「白名单加错两个月没人发现」这件事变成会失败的测试。

- 不只断言当前名单内容——要**枚举 `app/api` 下全部路由**，算出 middleware 会放行哪些，
  与显式快照比对。任何新路由变成公开都让测试红，除非有人主动改快照并写理由。
- **验收**：
  1. `npm test` 通过
  2. 手动把 `/api/customers` 加回白名单 → 测试必须失败（反向验证，证明它真的能抓到）
  3. 快照里每个公开路由都有一行说明为什么可以公开
- **产出**：`tests/public-api-routes.test.ts`，`middleware.ts` 导出白名单
- **依赖**：无

### F2 摘掉利润表死链入口
- `boss/layout.tsx:22` 的「利润表」指向不存在的页面，点击 404。
- **处理**：摘掉入口，并在原处留注释写清补齐它需要什么（费用数据源缺失是根因）。
- **验收**：BOSS 导航不再出现利润表；`grep income-statement` 只剩注释；tsc 通过
- **依赖**：无

### F3 补应付账龄报表
应付账龄数据齐备（VendorBill 25 条，含 dueDate/amountDue/amountPaid/status/supplierId），
与已有应收账龄对称，补出来是真东西。

- **验收**：
  1. `GET /api/analytics/ap-aging` 返回 200，账龄桶与应收同口径
  2. 页面 `/classic/boss/analytics/ap-aging` 可打开，导航入口不再 404
  3. 桶合计 = 未结清账单总额（用探针核对，不是肉眼看）
  4. 鉴权：无 token 401、低权限角色 403
- **产出**：`app/api/analytics/ap-aging/route.ts`、`app/[locale]/classic/boss/analytics/ap-aging/page.tsx`
- **依赖**：无

### F4 备份落点改 S3 兼容存储
按部署铁律：不为将要拆掉的架构新建 GCS 桶。备份要能在 Cloud Run 和 DigitalOcean 两边都跑。

- **处理**：把 `lib/backup.ts` 里直连 `@google-cloud/storage` 的部分抽到一层 driver 后面，
  按环境变量选 `s3`（S3 兼容，含 DO Spaces）或 `gcs`（保留兼容），迁移时只改配置不改代码。
- ⛔ 不得在本任务里开通任何云资源（建桶要用户自己做），代码要能在未配置时给出清晰报错。
- **验收**：
  1. `BACKUP_DRIVER` 未配置时报错信息说清要配哪几个环境变量，不是 500 堆栈
  2. tsc 通过、`npm test` 通过
  3. `lib/backup.ts` 不再无条件 import `@google-cloud/storage`
  4. 文档写清 DO Spaces 需要的 4 个环境变量
- **依赖**：无

### F5 验证 + 部署
- **验收**：build 通过、全部测试通过、push 后生产实测应付账龄接口 200 且鉴权正常
- **依赖**：F1–F4

---

## 决策记录

- **利润表不补，只摘入口**：利润表 = 收入 − 成本 − 费用，而费用无数据来源
  （无「其他支出」录入模块、`JournalEntry` 0 条、`Account` 仅 10 个科目且无分录）。
  硬做会产出一张缺全部运营费用的表，给甲方看比没有更糟。补齐它的前置条件已写进代码注释。
- **应付账龄补**：数据齐备且与应收对称，属于真能交付的。

### D1 完成记录
- 白名单与判定逻辑抽到 （middleware 与测试共用，避免两处漂移）
-  4 个测试：扫描逻辑自检 / 公开集合 vs 快照 / 敏感前缀黑名单 / 每条白名单都要有书面理由
- **反向验证做了**：把 `/api/customers` 加回白名单后 3 个测试变红，
  且错误信息列出前缀匹配连带放行的 6 条子路由（customers、[id]、[id]/credit、
  [id]/last-prices、bulk、coordinates）——证明它真能抓到这次的漏洞形态
- 全量 109 个测试通过，tsc 通过

## 遗留问题

- （待填）
