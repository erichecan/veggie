# 任务台账：退换货流程补缺口

对应计划：[DEV-PLAN.md](../DEV-PLAN.md)（20260922 重写版，推翻了同名文件更早的 ReturnCase 新表方案）

- [x] ReturnItem 类型扩展（lib/types.ts）
      验收命令：`npx tsc --noEmit`
      可看物：无（数据层）
      定性状态：不涉及
      证据：`scripts/verify-return-flow.sh` 全部通过
      依赖：无

- [x] 仓库核实接口 + 状态机改动（POST/PUT returns 路由）
      验收命令：`scripts/verify-return-flow.py` 状态机探针
      可看物：无
      定性状态：不涉及
      证据：15/15 探针通过，见 DEV-REPORT.md
      依赖：类型扩展

- [x] 旧数据兼容：历史退货记录状态不受新状态机影响
      验收命令：代码审查——`flatten()`/审核路由默认值仍是 `?? 'PENDING_REVIEW'`，未改
      可看物：无
      定性状态：不涉及
      证据：`app/[locale]/classic/operator/returns/page.tsx` 默认值未动
      依赖：仓库核实接口

- [x] 仓库端页面 warehouse/returns
      验收命令：浏览器实测（warehouse(at)demo.local）
      可看物：docs/shots/20260922-warehouse-returns.png
      定性状态：待你确认
      证据：核实通过后列表清空、toast 提示"已转入销售审核"
      依赖：仓库核实接口、RBAC

- [x] RBAC：warehouse_verify 新权限点 + SALES 追加审核权限 + DRIVER 上报权限
      验收命令：curl/Python 401/401/403 + 权限生效探针
      可看物：无
      定性状态：不涉及
      证据：`scripts/verify-return-flow.py` 全部通过；两条迁移已应用（20260923001437、20260923002138）
      依赖：仓库核实接口

- [x] operator/returns 页面：过滤 WAREHOUSE_PENDING + 换货关联新单号
      验收命令：浏览器实测（operator3(at)demo.local，SALES+OPERATOR 兼任）
      可看物：docs/shots/20260922-operator-returns-exchange.png
      定性状态：待你确认
      证据：新增"待仓库核实"tab；换货类型记录出现"关联的换货新单号"输入框
      依赖：RBAC

- [x] sales 角色可达 operator/returns 页面
      验收命令：浏览器实测（operator3(at)demo.local）
      可看物：docs/shots/20260922-operator-returns-exchange.png（同上，导航栏可见"Sales"身份+Inventory Tab）
      定性状态：待你确认
      证据：page.operator.access 已覆盖此角色，无需改动路由权限，仅补上审核接口权限即可操作
      依赖：RBAC

- [x] 司机端：改走专用接口 + 拍照 + 司机签名
      验收命令：浏览器实测（driver(at)demo.local）+ Python unitPrice 快照探针
      可看物：docs/shots/20260922-driver-return-exception-modal.png
      定性状态：待你确认
      证据：提交后 unitPrice/driverSignature/status 均正确落库；顺手发现并修复 SignaturePad 占位文案错误（司机签名场景误显示"请客户签名"）
      依赖：仓库核实接口、RBAC

- [x] 司机端：历史订单退换货入口
      验收命令：Python 探针（COMPLETED 状态行程提交退货）
      可看物：无独立页面——复用现有 driver/trip/[id] 执行页，已完成的行程会显示"补报退换货"按钮
      定性状态：待你确认
      证据：探针"COMPLETED 历史行程仍可补报退货"通过
      依赖：仓库核实接口

- [x] verify 脚本 + DEV-REPORT
      验收命令：`scripts/verify-return-flow.sh`
      可看物：DEV-REPORT.md
      定性状态：待你确认
      证据：17/17 探针 + tsc + build 全部通过（含 /code-review high 之后补的 2 条回归探针）
      依赖：以上全部

- [x] /code-review high + /security-review（CLAUDE.md 第十一节要求）
      验收命令：见 DEV-REPORT.md「/code-review high 发现处理记录」
      可看物：无
      定性状态：不涉及
      证据：6 条 code-review 发现中 4 条已修复（VERIFYING 回归、returnId 精确匹配、页面拆分、悬空注释）、2 条记录为既有模式不处理；security-review 候选发现复核置信度 5/10 未达报告门槛
      依赖：以上全部
