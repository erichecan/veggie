# veggie 部署日志 · 2026-10-05

本次部署覆盖当天两批需求：客户自增编号和导入导出字段、客户详情前后导航、产品列表编辑按钮精简、客户归档命名，以及三级商品分类和移动端关键操作适配。

## 提交与部署

- 功能提交：`ae4b48c5cefe8d3a28dc4cb91df66e34ae075b52`。
- 已推送到 `origin/main`。
- GitHub Actions：<https://github.com/erichecan/veggie/actions/runs/37392477629>。
- `Deploy to droplet` 全部步骤成功，耗时 7 分 30 秒。
- 正式地址：<https://www.johnstonebros.ie/>。
- 生产服务器确认部署镜像对应本次功能提交，健康检查成功，没有触发回滚。

## 数据库迁移

生产流水线执行并成功应用：

- `20261005000001_customer_number_and_contact_fields`
- `20261005000002_product_category_tree`

前一阶段应用到本地配置的 Neon 数据库，本次部署另外通过生产 migrator 镜像应用到生产数据库。

## 验证

- 生产构建 `npm run build` 成功。
- 类型检查及 41 项相关测试通过。
- 浏览器回归通过，覆盖中英文、360/390/768/1440px、分类树与配送分配/移出。
- 生产首页 HTTP 200。
- 生产 `/api/health` 返回 `status: ok`、`db: ok`；版本切换后 uptime 重置，确认服务已重启。
- 本次提交钩子误报两个示例邮箱；确认均为模板/预览测试数据后，按仓库钩子说明跳过该次检查提交。未提交环境变量或真实客户数据。

开发验收与界面预览见 `20261005-product-category-mobile-implementation.md`。已有 ESLint 和权限冻结基线测试问题记录在该文档中，未在本次范围内调整。
