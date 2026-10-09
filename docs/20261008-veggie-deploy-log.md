# 2026-10-08 生产发布记录

- 代码提交：`61a8570a21aced0424ea99b096779c0ae00ed76a`，已推送 `main`。
- 内容：
  1. 价格表详情页 Archived/Active 徽章改成可点击 button（非编辑态下点击弹确认框后立即调用 `handleSave` 切换 `active`），解决"归档状态改不回来"的问题。
  2. 客户列表 Pricelist 列改为取消按 `active` 过滤价格表名字映射，修复归档价格表显示成 `pl_xx` 原始 id 而非真实名字（PL-35）。
  3. 客户列表 Pricelist 列新增 Popover，点击展开显示该客户挂靠的全部价格表（按 sequence 排序），不止主价格表 +N 的折叠提示。
- 本次提交落地时 `origin/main` 已领先 33 个提交（并发会话在价格表模块、客户/供应商归档筛选等做了大量独立改动，含客户列表"仅已归档"筛选、价格表批量操作、导入历史等）。通过 `git pull --rebase` 合并，customers/page.tsx 出现 1 处冲突（新旧挂载 `useEffect` 结构不一致），已手动解决为：保留对方的分页/筛选状态恢复结构，只补回"价格表名字映射不按 active 过滤"这一行为修复；pricelists/[id]/page.tsx 自动合并无冲突（对方新增的编辑态 `update('active', ...)` 与我这边非编辑态的 confirm+`handleSave` 是互补的两条路径，未发现重复或矛盾）。
- GitHub Actions `Deploy to droplet`：<https://github.com/erichecan/veggie/actions/runs/37863482312>，结果 `success`，耗时约 7m53s。
- ⚠️ `CI` 工作流（<https://github.com/erichecan/veggie/actions/runs/37863482307>）中 `测试（含权限守卫）` 与 `权限可达性快照` 两步失败——这是**继承的既有红状态**，上一次合并（#28，`eebe032`，6 小时前）CI 已是同样两步失败，与本次改动的两个文件无关，不阻塞本次部署（`Deploy to droplet` 是独立工作流，不依赖 `CI` 通过）。疑似关联项目记忆 `rbac-grant-migrations-bypass-seed-json-20260919`（权限发放迁移绕过 `seed-rbac.json` 导致 CI 守卫连红）——留作后续单独排查，不在本次范围内处理。

## 验证结果

- 提交前 `npx tsc --noEmit`、`npm run build` 全部通过。
- 合并后（吃进对方 33 个提交）重新跑 `npx prisma generate` + `npx tsc --noEmit` + `npm run build`，均无报错。
- 本地浏览器（Playwright）在开发库上逐条验证过（详见会话记录）：
  - 价格表 `pl_139`（Retail Pricelist 47）Archived→Active→Archived 来回切换，confirm 弹窗文案正确，`已保存` toast 正常，状态还原。
  - 客户列表点击价格表单元格（Green Garden / Crown Kitchen）弹出 Popover 显示挂靠价格表列表，且不触发行点击跳转（URL 未变）。
  - PL-35 的代码修复本身通过类型检查确认，但本地开发库没有"客户挂靠已归档价格表"的真实数据，未能在浏览器里肉眼复现这一具体场景。
- 部署后生产 URL 探活：`https://www.johnstonebros.ie/` → `HTTP 200`；`https://www.johnstonebros.ie/classic/operator/customers` → `HTTP 200`。

## 待观测

- 定性观测：请客户/业务员实际点一下某个挂了已归档价格表的客户的 Pricelist 列，确认显示的是价格表名字而不是 `pl_xx`；以及在价格表详情页试一次归档/恢复按钮。状态：待你确认。
