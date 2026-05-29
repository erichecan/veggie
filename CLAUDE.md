@AGENTS.md

---

## 完成标准（开发完成前必须全部达到）

> "服务启动成功"不等于"开发完成"。
> 以下标准必须全部达到，才允许输出完成报告。

### 禁止以下行为：
- ⛔ 只检查 `npm run build` 通过就报告完成
- ⛔ 只检查服务端口有响应就报告完成
- ⛔ 页面能打开但按钮点击无反应，仍报告完成
- ⛔ 数据库是空的，没有种子数据，仍报告完成
- ⛔ 某些路由返回 500 / 404，但未在报告中注明

### 必须完成的验证步骤：

**1. 种子数据（Seed Data）**

如果是新项目或数据库为空，必须先创建种子数据再验证，否则所有功能都是空壳：

```bash
# 检查数据库是否有数据
npx prisma studio &   # 打开后检查核心表是否有记录

# 如果为空，运行种子脚本（如有）
npx prisma db seed

# 如果没有种子脚本，手动创建最小测试数据集：
# - 至少 1 个测试用户（含登录凭证）
# - 至少 1 条核心业务数据（如：商品、订单、任务等）
# 并在 DEV-REPORT.md 里注明测试账号和密码
```

**2. 用户流程逐条验证**

对照产品文档中的用户流程，用 `curl` 或启动 Playwright 逐条走通：

```bash
# 示例：验证登录流程
TOKEN=$(curl -s -X POST http://localhost:[端口]/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"test@test.com","password":"test123"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

echo "Token: $TOKEN"

# 示例：用 token 访问受保护接口
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:[端口]/api/[核心资源] | head -20
```

**3. 所有可点击元素必须有响应**

逐一检查产品文档中提到的每个操作入口：

- 按钮点击后是否有反应（不能是死按钮）
- 表单提交后是否有成功/失败反馈
- 列表为空时是否有空状态提示，而不是空白页
- 跳转链接是否真的能跳转，不能是 `href="#"` 或 404

**4. 错误场景验证**

不只验证"正常流程"，还要验证边界情况：

```bash
# 未登录访问受保护页面 → 应跳转登录页，不能显示 500
curl -s http://localhost:[端口]/dashboard

# 错误密码登录 → 应返回提示，不能崩溃
curl -s -X POST http://localhost:[端口]/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"test@test.com","password":"wrong"}'

# 访问不存在的资源 → 应返回 404 提示，不能是空白
curl -s http://localhost:[端口]/api/orders/nonexistent-id
```

**5. 服务器日志检查**

启动服务并操作后，检查日志有无隐藏错误：

```bash
# 检查最近 100 行日志有无 error / warning
tail -100 /tmp/dev.log | grep -i "error\|warn\|exception\|failed"
```

有任何 error 级别日志，必须修复后才能报告完成。

---

### DEV-REPORT.md 必须包含的额外信息：

```markdown
## 测试账号
| 角色 | 账号 | 密码 |
|------|------|------|
| 管理员 | admin@test.com | test123 |
| 普通用户 | user@test.com | test123 |

## 验证结果
| 用户流程 | 验证方式 | 结果 |
|----------|----------|------|
| 登录 | curl POST /api/auth/login | ✅ 正常返回 token |
| 查看商品列表 | curl GET /api/products | ✅ 返回 3 条种子数据 |
| 提交订单 | curl POST /api/orders | ✅ 创建成功 |
| 未登录访问 /dashboard | curl GET /dashboard | ✅ 跳转到登录页 |

## 已知不可用功能
[如有功能尚未实现或存在问题，必须在这里列出，不能隐瞒]
```
