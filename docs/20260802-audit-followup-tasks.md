# 审计后续修复 — 任务台账

> 起始：2026-08-02（接 `docs/20260802-contract-feature-audit-tasks.md` 的三条遗留决策）
> 用户已拍板三项全做。**台账是进度的唯一真相。**

## 状态汇总

| 周期 | 任务 | 状态 | commit |
|---|---|---|---|
| D1 | F1 PUBLIC_API_ROUTES 回归测试 | [x] | |
| D2 | F2 摘掉利润表死链入口 | [x] | |
| D3 | F3 补应付账龄报表（API + 页面） | [x] | |
| D4 | F4 备份落点改 S3 兼容存储 | [x] | |
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
- 白名单与判定逻辑抽到 `lib/public-routes.ts`（middleware 与测试共用，避免两处漂移）
- `tests/public-api-routes.test.ts` 4 个测试：扫描逻辑自检 / 公开集合 vs 快照 / 敏感前缀黑名单 / 每条白名单都要有书面理由
- **反向验证做了**：把 `/api/customers` 加回白名单后 3 个测试变红，
  且错误信息列出前缀匹配连带放行的 6 条子路由（customers、[id]、[id]/credit、
  [id]/last-prices、bulk、coordinates）——证明它真能抓到这次的漏洞形态
- 全量 109 个测试通过，tsc 通过

### D2 完成记录
- `boss/layout.tsx` 摘掉「利润表」入口，原处留注释写清**恢复它的三个前置条件**：
  建费用录入 / 让 JournalEntry 真正产生分录 / 出成本结转

### D3 完成记录
- `lib/analytics/metrics.ts` 新增 `AGING_BUCKETS` 别名，明确应收应付**共用同一套账龄阈值**
  （阈值不一致的话「应收 60 天以上 vs 应付 60 天以上」就没法对读）
- `app/api/analytics/ap-aging/route.ts`：SQL 内 GROUP BY 分桶，返回行数锁定在「供应商数 × 6 桶」
- `app/[locale]/classic/boss/analytics/ap-aging/page.tsx`：与应收同结构，但配色改掉了风险色阶
  （欠供应商钱是付款优先级问题，不是坏账风险）

**做的过程中撞到的真问题**：25 张供应商账单**全是 DRAFT 未过账**（合计 €27,925.60），
且**0 张填了到期日**。若严格照搬应收的 POSTED 口径，这页会永远显示 0——技术正确但
看起来像又一个坏页面。处理方式：账龄表保持正确会计口径，另加 `pending` 字段与页面提示条，
把「25 张草稿共 €27,925.60 尚未过账」讲在明处。

**实测**：接口 200；`pending` 数字与库内 DRAFT 聚合完全一致；
鉴权 无token=401 / DRIVER=403。

### D4 完成记录
- `lib/storage/backup-store.ts`：三个 driver（`local` 默认 / `s3` 目标形态 / `gcs` 遗留兼容），
  由 `BACKUP_DRIVER` 选。SDK 一律动态 import，没选到的 driver 不进运行时。
- `lib/backup.ts` 不再 import `@google-cloud/storage`；下载路由同时支持签名 URL 与文件流。
- **端到端跑通了**：用 `local` driver 完整走 `pg_dump → gzip → 落盘 → 下载流`，
  产出 **81.7 MB**，解压是合法 SQL（48 个 CREATE TABLE）。
  **这是该系统第一次成功产出备份**（此前 3 次任务成功 0 次）。探针 job 与 82MB 产物已清理。
- 配置文档 `docs/20260802-backup-storage-config.md`：DO Spaces / MinIO / AWS 各自要配哪几个变量。

**过程中发现并堵掉的一个新风险**：生产 cloudbuild 没设 `BACKUP_DRIVER`，
改造后会默认成 `local`——而 Cloud Run 容器磁盘重启即失，备份会"成功"然后消失，
比现在响亮地失败危险得多。已加两道闸：
1. `isEphemeralFilesystem()` 检测到 Cloud Run/Heroku/Fly 时，选 local 直接抛错并指向 s3
2. cloudbuild.yaml 显式写死 `BACKUP_DRIVER=gcs`，保持当前行为，待用户备好 Spaces 再切
另：`BACKUP_DRIVER` 拼错（如写成 `spaces`）直接抛错，不静默回退——静默回退正是上面那种消失模式。

**测试**：`tests/backup-store.test.ts` 11 个用例（driver 选择 / 配置缺失报错内容 /
local 读写删 / 幂等删除 / describe 不泄露密钥 / 无状态环境拒绝 / 显式绕过）。全量 120 个测试通过。

## 遗留问题

- （待填）
