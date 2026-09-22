# veggie 部署效果闭环日志 · 2026-09-22

## 进销对比分析加销售/毛利列与Excel导出 + 司机送货明细报表（2026-09-22）

**本次改动想达成什么**

客户发来两张手写批注截图：
1. 毛利分析页截图批注："某时间段内，某几个产品，进货数量，购进金额，销售数量，
   销售额，毛利。excel 输出。"——判断该口径同时跨采购与销售两侧，不适合塞进
   毛利分析（纯销售侧、成本用估算口径），复活孤儿路由 procurement-analysis
   （20260920 被摘导航，代码原样留着），改名"进销对比分析"重新挂回导航，按
   产品维度补销售/毛利三列，CSV 导出换 Excel。
2. Odoo 旧系统 Sales Analysis 截图批注两条需求，讨论后确认第一条（司机考核：
   送货量 vs 路线远近 vs 工作时间/工资）大部分做不了——"路线远近"和"工作
   时间/工资"系统里完全没有对应数据，需要客户先确认数据来源，本次不动；
   第二条（每司机×每客户×每产品×每天上/下午的送货明细，司机一份公司一份）
   数据都在（Trip/PickingWave/DriverSlot 都记了 am/pm 时段，只是没接入报表），
   本次在司机提成页新增这张明细表 + 独立 CSV 导出。

提交前跑了 `/code-review high`，10 条 findings 里确认并修了 4 条真问题：
- procurement-analysis：supplierId 筛选原来只影响采购侧，销售/毛利列仍统计
  全公司数据，供应商筛选对这三列形同虚设——已收窄销售查询范围到该供应商
  实际采购到的产品集合（用生产数据验证：筛前销售额€140612/580个产品，筛后
  €371/4个产品）
- procurement-analysis：groupBy 切换时未清空旧 data，切换瞬间点导出会拿旧
  维度数据配新维度表头——已清空 + 导出按钮加 disabled 守卫
- driver-commission：PickingWave.timeOfDay（小写 am/pm）与 Trip.timeSlot
  （大写 AM/PM）大小写不一致，导致无波次的手工 Trip 时段列静默显示为空——
  SQL 层统一 LOWER() 转小写
- driver-commission：CSV 转义遗漏裸 \r，跟 lib/csv-export.ts 对齐补上；顺带
  把司机提成页面拆出 ExportButtons 组件压回 CLAUDE.md 150 行上限
其余 6 条（两个独立 fetch 无序竞态、timeOfDayLabel 重复实现、两查询未
Promise.all 并行、毛利公式手抄未共享、productIds 过滤逻辑重复三处）判断是
低风险/成本不对等的技术债或与既有代码库既定取舍一致，未修，理由见对应
commit message。

**技术观测（我负责）**

| 项 | 结果 |
|---|---|
| tsc --noEmit | ✅ 0 错 |
| eslint（改动文件） | ✅ 无新增问题（3 处历史遗留的 set-state-in-effect 警告，改动前就存在，与本次无关） |
| 本地浏览器实测（boss 本地测试账号） | ✅ 进销对比分析：按产品维度 11 列正确显示、按供应商维度自动回退 8 列、Excel 导出内容正确（581行/含新3列）；司机提成：新增送货明细表格渲染正常、导出按钮正确置灰（本地库这段时间无 Trip 数据） |
| 生产库只读 SQL 验证（新 SQL 语法/join/分组） | ✅ 用生产库仅存的 1 条非 PENDING Trip 记录跑通新查询，返回预期结构的 7 行数据 |
| GitHub Actions CI | ⛔→✅ 首推（458739a）因漏更新权限可达性基线两处快照（`lib/rbac/parity-baseline.json`、`scripts/audit/role-reachability.json`）失败；补跑 `update-parity-baseline.ts`/`save-reachability.ts` 后（run 35731216140）绿，本地 `npm test` 923 pass / 1 fail（pricing-override.test.ts 依赖本地库不存在的 ABCT 客户，与本次改动无关，早有专门 commit 处理这个已知本地环境问题） |
| GitHub Actions Deploy to droplet | ✅ 绿，6m46s（run 35731216111） |
| 生产容器镜像 tag | ✅ `9556a73ec77ee784896831caf8d2036bbbe1039d`，与本地 HEAD 一致，`docker compose ps` 状态 healthy |
| 生产首页 | ✅ `curl https://www.johnstonebros.ie/` → 200 |
| 生产新路由探针（未登录） | ✅ `/api/analytics/procurement-analysis/pivot`、`/api/analytics/driver-commission/product-detail` 均返回 401（鉴权生效，非 404/500，证明 route-map.ts 登记生效） |
| 部署后应用日志 | ✅ `docker compose logs app` 干净，无 error |
| 提交 | `f853d03 feat(boss): 进销对比分析加销售/毛利列与Excel导出`、`458739a feat(boss): 司机提成页新增按司机×客户×产品×半天送货明细`、`9556a73 fix(ci): 补权限可达性基线，纳入司机送货明细新路由` |

⛔ **我没能验证的**：生产上没有登录账号（既有约定：不为测试重置真实用户密码），
两个新页面/新列在生产真实数据下长什么样、Excel 导出内容是否符合预期，未经
我肉眼在生产上确认，只验到路由层鉴权正确 + SQL 本身在生产 schema 下能跑通。

**定性观测（用户/客户负责）**

登录 https://www.johnstonebros.ie/classic/boss ，确认：
1. 导航里出现「进销对比分析」，选一个熟悉的供应商 + 时间段，核对"进货数量/
   购进金额"跟你记忆中的采购情况对得上，"销售数量/销售额/毛利"三列数字
   看着合理，点"下载 Excel"文件能打开、内容跟屏幕一致
2. 进「司机提成」页，往下滚到"按司机×客户×产品×半天的送货明细"表格，挑一个
   司机某一天的记录，核对是否跟实际送货情况一致（客户、产品、数量），
   点"导出送货明细 CSV"确认司机拿到的那份只有他自己的行

问谁：用户本人（进销对比分析口径），后续视情况问客户（送货明细是否是他要的格式）。

**状态**：待观测
