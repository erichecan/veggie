# veggie 部署效果闭环日志 · 2026-10-02

## 生产镜像服务端代码编译成 V8 字节码 + 合并另一会话 24 个提交（2 次提交，1 次部署）

**本次改动想达成什么**

用户明确诉求：不想让有服务器访问权限的人把部署产物整个拷走后随意阅读/改动代码，哪怕借助 AI 辅助也不应该能轻易看懂——不是防拥有 root 权限、愿意上专门逆向工具的攻击者，是把"文本编辑器打开就能看懂改"的门槛抬到"要专门工具才能看懂"。

实现：`Dockerfile` 的 `builder` 阶段 `next build` 之后新增 `npm run build:bytenode`（`scripts/bytenode-compile.mjs`），把 standalone 产物里 `app/pages/chunks` 三个目录下的 `.js` 编译成 bytenode 字节码，原文件就地换成 3 行 loader stub，其余代码 `require` 路径不变。只影响 Docker 构建产物，本地 `npm run dev`/`npm run build` 不受影响。

本地 `docker-compose.local-pg.yml` 全链路实测中发现并修复两类必须跳过编译的文件（均为 Next/vendor 自身运行时胶水代码，非业务逻辑，跳过代价很小）：
- `*manifest*.js`：Next 用 `fs.readFileSync` + `vm.runInNewContext` 直接吃这类文件，不走 `require()`，loader stub 里的 `require('bytenode')` 在该沙箱里直接 `ReferenceError`，首页 500。
- 含动态 `import()` 的文件（Prisma 7 的 WASM 查询引擎、next-intl 按 locale 动态加载消息）：bytenode 用 `vm.Script` 手动执行，没接 `importModuleDynamically` 钩子，运行到该行即 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`，登录接口 500。

推送时发现 `origin/main` 已领先本地 24 个提交（另一会话完成的商品批量导入/价格历史/字体等 PR #1~#13），且其中 8 个改过 `products/page.tsx`（与本次改动的同一文件）。按用户确认的方案 rebase 到最新 `origin/main`（无冲突），rebase 后重新跑了一轮 `tsc --noEmit`/`npm run build`/完整 Docker 构建 + 容器实测，确认合并后的代码仍然健康，才推送部署。

**技术观测（我负责）**

| 项 | 结果 |
|---|---|
| npx tsc --noEmit（rebase 后） | ✅ 0 错（中途一次本地 stale Prisma Client 导致的假阳性已通过 `npx prisma generate` 排除） |
| npm run build（rebase 后） | ✅ 全部路由构建成功 |
| 本地 docker-compose 全链路实测（bytenode 修复前后各一轮 + rebase 后再跑一轮） | ✅ 登录(JWT+RBAC)/18 条业务 API/18 条分析报表 API/2 条真实 Puppeteer 二进制 PDF（行程汇总单+拣货单）/2 条写入接口全部通过，`docker logs` 零报错 |
| 容器内验证防护目标 | ✅ grep `commissionRate` 等业务关键字，编译后的 1340+ 个 chunk 文件内已搜不到明文 |
| 本地 db push 对比 migrate deploy | ⚠️ 本地从空库用 `db push` 时 `productNo` 列一度没建出来（Prisma 7.7.0 的 `db push` 对该 autoincrement 列的 diff 检测有问题），直接用 migration.sql 原文手工 `ALTER TABLE` 验证确认**迁移文件本身正确**，生产走的是 `prisma migrate deploy` 直接执行该 SQL，不受此 `db push` 本地工具问题影响 |
| GitHub Actions Deploy to droplet (`125da55`) | ✅ 10m3s 全绿 |
| 生产首页存活 | ✅ `curl https://www.johnstonebros.ie/` 200 |
| 提交 | `3a66986` 分面筛选胶囊拆分显示等（另一会话 UI 修复）+ `125da55` build(docker) 字节码编译 |

**定性观测（用户/客户负责）**

无直接用户可见变化（纯基础设施加固）；分面筛选胶囊拆分显示、内联编辑按行禁用、保存按钮错误反馈这几项是另一会话完成的 UI 修复，若有专门验收需求请用户自行确认视觉效果。

**状态**：技术侧已达成（本地复现+修复验证+生产部署核实）；定性侧无需用户验收（基础设施变更）

---

## 价格表列表 Name/Last Updated on 列加排序（1 次提交+部署）

**本次改动想达成什么**

[用户原话] 用户发来截图标注：Pricelist Name 列"大写小写混在一起排序"、Last Updated on 列应"按照时间排序"。根因：这两列此前都没设 `sortable`，点列头没有任何反应，列表恒按后端 `sequence` 字段的任意存储顺序展示——视觉上就是名称大小写随机混排、更新时间也毫无先后规律。

修复：两列加上可点击排序，`name` 用 `localeCompare` + `sensitivity:'base'` 做大小写不敏感比较，`updatedAt` 按真实时间戳比较（非字符串字典序）；`sortKey`/`sortDir` 并入该页面既有的 sessionStorage 列表状态持久化机制。

**技术观测（我负责）**

| 项 | 结果 |
|---|---|
| npx tsc --noEmit | ✅ 0 错 |
| npx eslint | ✅ 0 错（1 条预置无关警告） |
| 浏览器实测（本地 dev，真实登录会话） | ✅ 点 Name 升序：Contract→Restaurant→Retail→Standard→Takeaway→Wholesale 清晰分组；点 Last Updated on 升序：80 条记录时间戳单调递增（16/07 02:04 → 25/08 05:39）；刷新页面排序状态保留 |
| GitHub Actions Deploy to droplet (`577fd2e`) | ✅ 6m19s 全绿 |
| 生产首页存活 | ✅ `curl https://www.johnstonebros.ie/` 200 |
| 提交 | `577fd2e fix(pricelists): 价格表列表 Name/Last Updated on 列加排序` |

**已知瑕疵（不在本次修复范围）**

`sortKey`/`sortDir` 复用了该页面另外 6 个字段（`searchInput`/`tab`/`columnFilters` 等）同款的"`useState(saved?.field)` 从 sessionStorage 读初始值"写法——当该字段此前被存过非默认值时，SSR 首屏与客户端 hydration 会短暂不一致，触发一次 React hydration 警告（浏览器控制台可见，React 自动用客户端结果重渲一次，不影响最终显示与功能）。这是该页面一直就有的架构模式，6 个既有字段同样存在此问题，不是本次排序改动独有的新缺陷，本次不展开修。

**定性观测（用户/客户负责）**

请用户在生产上打开 价格表 列表页，点击 "Pricelist Name" 和 "Last Updated on" 两个列头，确认排序结果符合预期（名称按字母顺序、时间按先后顺序）。

**状态**：技术侧已达成（本地复现+修复验证+生产部署核实）；定性侧待用户在生产上过一遍确认
