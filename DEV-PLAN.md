# DEV-PLAN：用户管理拆分 + 餐馆自助注册（待审核）

日期：2026-09-26
来源：本次对话讨论。无产品文档参与（口头需求）。

## 一、这次要解决什么

1. 用户管理页（`/classic/operator/users`）现在把内部员工（销售/司机/财务/老板…）和餐馆客户账号（`RESTAURANT` 角色）混在同一张表里，不好管理——拆成两个独立 tab。
2. 目前餐馆账号只能由内部管理员在后台手工建，且"建账号"和"绑定到具体客户档案"这两步是脱节的（现有建号表单没有选 Customer 的输入项）。这次要给餐馆一个在线自助注册入口：填手机号/餐馆名称/用户名/密码/邮箱/地址，提交后**新建一条客户档案 + 一个「待审核」状态的登录账号**，不能立即登录下单；内部人工确认是真实餐馆、配上价格表和信用额度后才批准激活。（此为你已拍板的关键决策：新建客户+待审核，而非自动激活，也不是去匹配老客户档案。）

## 二、模块拆解

| 模块 | 改动 |
|---|---|
| Schema | `User` 新增 `pendingApproval Boolean @default(false)`（只有自助注册产生的账号是 true，管理员手工建号的账号不受影响） |
| 注册页面 | 新增公开路由 `app/[locale]/register/page.tsx`（无需登录），表单字段：餐馆名称、联系人姓名（对应"用户名"）、邮箱（登录用）、密码、联系电话、地址 |
| 注册 API | 新增 `POST /api/auth/register`：校验 + 新建 `Customer`（仅填 name/phone/address/email，信用额度/价格表留空待审核补齐）+ 新建 `User`（role=RESTAURANT, isActive=false, pendingApproval=true, customerId=新Customer.id） |
| 登录逻辑 | `app/api/auth/login/route.ts` 加分支：`pendingApproval===true` 时返回"账号审核中，请等待管理员审核通过"，而不是现有的"账号已停用"文案（两者原因不同，不能共用一句话） |
| 用户管理页 | `page.tsx` 的 tab 从「用户/角色」改成「内部员工/餐馆账号/角色」三个 tab；`users-tab.tsx` 复用同一份组件，按角色过滤两次渲染 |
| 审核操作 | 「餐馆账号」tab 加"待审核"筛选高亮 + 批准/拒绝按钮：批准 = `isActive=true, pendingApproval=false`；拒绝 = 删除该 User + 当初一起新建的空 Customer（删除前必须校验这个 Customer 名下确实没有订单/发票，双重保险，不能只假设"待审核期间不可能有单"） |

## 三、路由清单

| 路由 | 说明 |
|---|---|
| `GET /register`（新增，公开） | 餐馆自助注册页 |
| `POST /api/auth/register`（新增） | 提交注册 |
| `PUT /api/users/[id]`（改） | 加 `{ approve: true }` / `{ reject: true }` 两种 body，复用现有接口而不是新开两个路由 |
| `/classic/operator/users`（改） | tab 拆分 |

## 四、风险点

- **反刷注册**：表单是公开的，任何人都能填。这次不做短信/邮箱验证码（记入技术债），先靠"待审核"人工闸门兜底——审核通过前账号完全不能登录、不能下单，脏数据最多是一条待审核记录，不会污染真实业务数据。
- **拒绝时的级联删除**：必须显式查一遍这个 Customer 名下 orderCount/invoiceCount 是否为 0 才允许删，不能假设"待审核期间不可能有单"就跳过校验。
- **用户名 ≠ 登录邮箱**：`User` 表没有独立 username 字段，注册表单的"用户名"映射到 `User.name`（联系人姓名），登录仍然用邮箱。
- **"手机号"和"电话"重复**：`Customer` 表只有一个 `phone` 字段，注册表单只保留一个"联系电话"输入框，不做两个重复字段。

## 五、附录 A：技术验收标准

- `npx tsc --noEmit`、`npm run build` 通过
- `npx prisma migrate status` up to date（新增 `pendingApproval` 字段的迁移已应用）
- 路由探针：`/register` 匿名可访问且渲染正常；`/classic/operator/users` 三个 tab 都能进
- 鉴权探针：`POST /api/auth/register` 匿名可调用（这是唯一允许匿名写入的新增点，需要专门确认没有越权到能设置角色/信用额度等敏感字段）；`PUT /api/users/[id]` 的 approve/reject 操作必须要求管理权限
- 功能探针：注册一个新账号 → 用该账号登录应返回"审核中"而不是 200 → 后台批准 → 再登录应成功
- 拒绝场景探针：给拒绝的 Customer 手工插一条测试订单，验证删除操作会被拦截（而不是级联删掉订单）

verify.sh 会补充对应的 curl 探针，跑绿才算完成，不许凭代码审查判断"应该没问题"。
