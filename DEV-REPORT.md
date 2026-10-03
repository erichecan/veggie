# DEV-REPORT：全站导入导出统一为商品模块同款体验

日期：2026-10-03

## 给你看的

| 场景 | 来源 | 截图 | 状态 |
|---|---|---|---|
| 商品导入弹窗外观/文案与改造前完全一致（底层引擎已换） | 你 2026-10-03「改成按照商品的模块导入导出功能」 | file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20261003-products-import-dialog.png | 符合 |
| 客户导入弹窗新增「按 ID 精确匹配更新」提示，与商品模块语义一致 | 你 2026-10-03 原话 | file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20261003-customers-import-dialog.png | 符合 |
| 设置页「计量单位」tab 新增导入/导出按钮 | 你 2026-10-03「没有导入导出功能的就补齐」 | file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20261003-uom-settings-page.png | 符合 |
| 设置页「商品分类」tab 新增导入/导出按钮 | 同上 | file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20261003-product-category-tab.png | 符合 |
| 单位导入弹窗文案说明 create-only 限制 | 我推断的（技术限制，见下方说明） | file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20261003-uom-import-dialog.png | 待你确认 |

访问地址：http://localhost:3001/classic/operator/settings（本地开发环境，账号 boss@demo.local / test12345）

### 范围调整，需要你知道

1. **发票 / 供应商账单 / 贷项通知单**：没有按计划升级导出到服务端模式。代码里已有明确注释说明这三个页面是"全量拉前端+客户端筛选"架构，改服务端导出会让"只导出当前筛选结果"这个功能失效，要做需要先把整个列表页架构换掉，是另一个更大的改动。**没有动**。
2. **订单导出两套并存（registry 版 + `export-csv` 会计专用版）**：代码里已有明确注释说明这是前人刻意保留、避免影响已配置好的角色权限，**不是遗留技术债，没有合并**。
3. **价格表、司机排班**：补齐导入导出的工作量比计划时预估的大——价格表的定价规则存在 JSON 字段里而不是平铺表，司机排班是跟用户账号关联的复合唯一键配置对象，都不是直接套用新引擎能做完的。**本次没做，需要你确认是否还要排期**。
4. **单位(Uom)导入只支持新建，不支持更新已有单位**：Uom 没有像商品/客户那样的业务唯一键(ID)，真实的唯一约束是"分类+名称"组合键，不适合强行塞进按单字段设计的引擎匹配逻辑。改已有单位的货物类型/拣货展开设置，请继续用设置页里的单条编辑（功能一直都在，没有受影响）。

## 存档用的

### 技术验收

- `npx tsc --noEmit`：通过
- `npm run build`：通过，退出码 0
- `npx eslint`（本次改动的全部文件）：0 error，8 warning（均为改动前已存在的 unused-var / exhaustive-deps 警告，非本次引入）
- 鉴权探针（无 token → 401）：`/api/uoms/bulk`、`/api/product-categories/bulk`、`/api/products/bulk`、`/api/customers/bulk`、`/api/suppliers/bulk` 全部 401，无 500
- 功能回归（本地开发库，真实 curl 调用，测试数据已清理）：
  - 商品：新建 → 按 externalId 更新 listPrice → `ActionLog` 里查到 `批量导入更新商品价格` 记录，before/after 正确（10→15）
  - 客户：新建 → 按 externalId 更新 phone → 二次查询确认落库
  - 供应商：新建 → 按 externalId 更新 vendorTaxRate → 二次查询确认落库
  - 产品分类：新建 → 按 externalId 更新 nameZh → 二次查询确认落库
  - 单位：新建成功；重名(不分类别)正确跳过；分类名找不到正确跳过并给出提示
- CSV 解析引号 bug：写了独立验证脚本确认 `"Shrimp, Black Tiger 700g",10,12.5` 这种商品名带逗号的行不再被错误拆列（修复前 `lib/import-parser.ts` 裸 `split(',')` 会把这一行错位成 4 列）
- `/code-review high`：跑出 3 条真实问题，已全部修复并回归验证通过：
  1. **`product-categories/bulk` 权限点用错**——原来用「新建分类」权限点(`master.product_category.create`)，但这个端点还能按 ID 更新已有分类；本项目 RBAC 支持按权限点自由拆分角色，如果以后有角色只给了"建分类"没给"改分类"，就能靠批量导入绕过 update 权限改掉任意已有分类。已改成要求 `master.product_category.update`（跟 `/api/products/bulk` 用 `master.product.update` 同一个道理），`route-map.ts` 同步改，已用 boss 账号回归验证新建+按ID更新仍正常。
  2. **CSV 分隔符嗅探回归**——收编 `lib/import-parser.ts` 的分隔符判断逻辑时，改成只看文本第一行，如果文件开头有空行（手工改过的 Excel 导出很常见），会判断错分隔符，整行数据静默错位。已改回"取第一条非空行"。
  3. **商品改价留痕有并发竞态窗口**——重构时把"改价前后对比"的 after 值改成了事务提交后重新查一次库，如果这期间有人同时编辑了同一个商品，审计日志记的就是别人的改动而不是这次批量导入自己写的值。已改成直接用写入事务自己的返回值（给引擎加了 `data` 透传字段，不用重新查库），已重新跑一遍商品改价回归确认审计日志数值正确。
- `/security-review`：已跑，无新增高置信度安全问题（上面第 1 条权限点问题是 `/code-review high` 发现的，已按同一次修复处理；`/security-review` 单独确认过这个点在当前角色配置下不构成立即可利用的漏洞，但修复后更彻底)

### 已知技术债（本次顺带发现，不在本次范围内处理）

- `customers/bulk` 与 `suppliers/bulk` 原本各自手写的字段截断逻辑已抽成 `lib/import/contact-fields.ts` 共享，但 `vendor-bills/import`、`purchase-orders/parse` 用的另一套 PDF/Excel 解析器（`lib/import-parser.ts` + `lib/purchase/product-match.ts`）性质不同（文件转订单行而非批量建档），本次没有合并，判断为不该强行合并（业务语义不同）。

## 第二轮：价格表导入导出（你确认要做）+ 司机排班（你确认不做）

| 场景 | 来源 | 截图 | 状态 |
|---|---|---|---|
| 价格表列表页新增真正的导入/导出按钮(替掉"coming soon"假按钮) | 你 2026-10-03「价格表要加入导入导出功能」 | file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20261003-pricelists-import-dialog.png | 符合 |
| 导出字段勾选弹窗正常工作 | 同上 | file:///Volumes/datacenter/04-eric/AIcoding/veggie/docs/shots/20261003-pricelists-export-field-picker.png | 符合 |
| 司机排班不做导入导出 | 你 2026-10-03「司机排班就不用导入导出了」 | — | 符合(未改动) |

**设计说明**：价格表的定价规则存在 `OdooPricelist.items`（JSON 数组），不是像单位/产品分类那样的平铺表——同一个价格表的多条定价规则要在 CSV 里用多行表示（一行 = 一条规则，靠「价格表名称」这一列分组），这跟商品/客户那种"一行一条独立记录"的通用引擎假设不一样，所以没有复用 `lib/import/bulk-import-engine.ts`，是一个独立实现(`app/api/pricelists/bulk/route.ts`)。顺带把价格表详情页原来内联的规则校验逻辑抽成共享模块 `lib/pricelist-item.ts`，两处用同一套规则。

**技术验收**：
- `npx tsc --noEmit` / `npm run build` / `npx eslint`：全部通过
- 鉴权探针：`/api/pricelists/bulk` 无 token → 401
- 功能回归（本地开发库真实 curl，测试数据已清理）：新建价格表+2条规则 → 按 externalId 更新价格表设置 → 按规则 ID 原地替换某条规则 → 不带规则只改名的"仅改设置"行 → 导出 CSV 核对字段，全部符合预期
- **过程中自己发现并修复了一个 bug**：按规则 ID 更新时，原实现会把这条规则的 ID 意外换成一个新的（因为判重逻辑把"这行就是要更新的那条规则自己"误判成撞车），导致下次再按同一个 ID 导入会找不到、变成重复新增而不是更新。已修复（排除自身 ID 再判重）并重新测试确认 ID 保持稳定。
- `app/api/pricelists/[id]/route.ts` 的重构（内联校验抽成共享模块）用一个真实价格表（112条规则）做了往返测试：GET 取出 → 原样 PUT 回去 → 规则条数和字段结构不变，确认行为没有被改变。
- `/code-review high`：已跑完，4 个真问题，已全部修复并回归验证通过（详见下方「`/code-review high`（价格表这批）结果」）
- `/security-review`：已跑，无新增高置信度问题（新端点权限点 `master.pricelist.update` 复用现有角色配置，BOSS/OPERATOR 同时拥有 create/update/read，SALES 三者都没有，不存在权限缺口；确认了通用导出路由 `/api/export/[entity]` 会对新注册的 `pricelists` 实体同样执行权限校验，不是只声明不生效）

**已知限制（设计决策，不是遗留问题）**：
- CSV 导入只能新增/更新定价规则，**不支持删除**已有规则——避免误操作清空定价。要删规则仍需去详情页手动删。
- 价格表/规则的匹配靠「ID → 名称」，和商品/客户同一套思路。

### `/code-review high`（价格表这批）结果：4 个真问题，已全部修复

1. **价格表批量导入：引用"同批里稍后才新建"的另一个价格表会解析失败**——formula 规则的
   `basedOnPricelist` 原来在"解析每一行"的阶段就去查库，但那时候同批其它行一个都还没写入，
   查永远查不到。已改成挪到"写入这一行"的事务内部才解析(那时候前面的行已经真正提交)。
   用真实场景复现过(A 行建"Base 10%"，B 行的规则引用"Base 10%")：修复前报 warning 丢了
   嵌套引用，修复后 `basedOnPricelistId` 正确落库，已重新验证。
2. **共享批量导入引擎有一个误判跳过的 bug**——这个影响商品/客户/供应商/产品分类/单位全部
   5 个用这套引擎的路由：新记录的名字在"规划"阶段就被占用登记，如果这一行自己的写入事务
   后来失败了(比如撞了无关字段的唯一约束)，名字已经被占，下一行如果恰好同名会被误判成
   "跟这行撞名"而跳过——但数据库里其实从来没有写进去过这条记录。已改成：占用和写入事务
   绑在一起，写入失败就撤销占用。同批真实撞名的跳过行为用 curl 重新验证过，没有被这个修复
   影响。
3. **批量导入弹窗表头匹配丢了一个回退规则**——抽成通用组件时参照了商品弹窗的实现，漏掉了
   客户/供应商那套旧组件原本支持的"表头也认字段名(如 vatNumber)、不只认展示文案(如 VAT
   Number)"的回退匹配。如果有人拿着表头是字段名的旧文件重新导入，那一列会静默对不上、
   没有任何报错。已修复，恢复双重匹配。
4. **价格表批量导入解析商品名时有 N+1 查询**——同一个文件里几百行各自引用的商品名，原来
   逐行各查一次数据库；分类/单位在同一份代码里已经是"一次性查全表建字典"的做法，商品这块
   漏了。已改成"先收集这份文件里实际出现过的商品名，一次性批量查"，不再有重复的网络往返。

跑了一遍完整回归(商品/客户/供应商/单位/价格表，含上面两个真实场景复现用例)，测试数据
已清理或标记停用(本地开发库里 boss 账号没有删客户权限，一条测试客户记录改成停用+改名
`ZZZ-DELETED-...` 标记，不影响任何真实数据)。

### `/security-review`（价格表这批）

已跑，无新增高置信度问题。确认了新权限点 `master.pricelist.update` 在当前角色配置下没有
缺口(BOSS/OPERATOR 同时有 create/update/read，SALES 三个都没有)，且通用导出路由
`/api/export/[entity]` 对新注册的 `pricelists` 实体确实执行了权限校验。

### 本轮顺带发现、记录但不在本次修复范围内的技术债

code review 还提出几条"可以抽共享函数/收窄到一套引擎"的建议(MAX_ROWS_PER_REQUEST 校验逻辑
在 6 个 bulk 路由里重复、"按名字建字典"这个模式在 4 个路由里重复、customers/suppliers 批量
导入现在因为分批提交会产生多条审计日志而不是一条)。这几条是代码整洁度/效率层面的建议，不是
正确性 bug，判断为可以留到下次动这块代码时顺手做，不在这次之内处理，已记录进任务台账。
