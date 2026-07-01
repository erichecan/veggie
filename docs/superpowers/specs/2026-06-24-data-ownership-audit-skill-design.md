# 设计:`auditing-data-ownership` skill

> 日期:2026-06-24
> 目标:把"SSOT / 数据所有权审计"方法论固化成一个全局、跨项目可复用、可自动执行的 skill。
> 形态决策(已与用户确认):脚本产证据 + Claude 判定;自动探测栈 + 适配器(Prisma 先做透,其余 grep 兜底);脚本用 Node(`.mjs`);产出 = 字段所有权矩阵 + 可落地的修复决策表。

---

## 1. 定位与边界

这是"数据方法论族"里缺失的**结构层**一环,不与已有 skill 重叠:

| Skill | 审计的层 | 回答的问题 |
|---|---|---|
| `validating-data-integrity` | 数据值层 | 现有数据彼此对得上吗?(stock ≠ movements) |
| **`auditing-data-ownership`(本 skill)** | **结构层(schema/字段)** | 同一业务事实是不是被存了多份?列表是不是读了不同源? |
| `designing-seed-data` | 数据生成层 | 种子数据能驱动端到端流程吗? |
| `testing-end-to-end-experience` | 行为层 | 真实 API 驱动下流程真的跑通吗? |

**核心命题(一句话心法):** 每个业务事实——谁写它?谁读它?它是存的还是算的?凡是答案出现"多个写入点 / 多处都声称权威",就是病灶。

**触发场景:** 列表数据彼此矛盾但程序不报错;状态机没法调试;"一个功能一个功能堆"后字段散落、命名不规范;端到端跑不通且怀疑是数据所有权混乱(非逻辑 bug、非 DB 错误)。这区别于 `validating-data-integrity` 的"数据值对不上"——本 skill 查的是"结构上本就是一个实体却被存进了多个地方"。

**只读保证:** 审计全程不改任何代码或数据,只产出分析文档。

## 2. 四步流程(脚本产证据 → Claude 判定)

```
第1步 探测技术栈      detect-stack.mjs:识别 ORM/DB 层(schema.prisma / TypeORM entities /
                     Drizzle / Mongoose models / Django models.py / 裸 SQL),选扫描规则;
                     未知栈降级到通用 grep 模式并告知用户覆盖率有限。
第2步 脚本扫原始证据  collect-evidence.mjs:对每个"实体.字段",机械收集——定义在哪、
                     哪些文件写它(create/update/写赋值)、哪些文件读它(select/include/页面引用)
                     → 输出 evidence.json(纯事实,绝不下判断)。
第3步 Claude 判定分类  Claude 读 evidence.json,把每个字段标成四类之一,标出 SSOT 违反与读源不一致;
                     无法机械判定的归属/派生关系由 Claude 结合语义裁定。
第4步 生成两份产出物  ①字段所有权矩阵(证据+分类)②修复决策表(行动)。
```

**分工铁律:** 脚本只做"机械归集",绝不下判断;Claude 只做"判断",不重复机械活。脚本产出是证据,不是结论。

## 3. 四分类法(Claude 判定标准)

每个字段必须落到且只落到一类:

- **canonical(权威)** — 该事实的唯一真相来源。✅ 健康。
- **derived / 合理快照(派生)** — 应从别处算出或下单时快照冻结(如 `OrderLine.productName` 冻结当时商品名;`Order.pricelistId` 定价解析后冻结)。要标注"派生自谁、何时快照、是否需要刷新"。
- **cache(冗余副本)** — 另一个 canonical 的拷贝,有不同步风险。⚠️ 病灶。
- **dead(死字段)** — schema 里有,但无人读 / 无人写。🗑️ 待删或补逻辑。

**判定为病灶的两种核心情况:**
- (a) 同一事实出现**多个 canonical**(多个可写真相,互不回写)——如真实案例 P0-1:`Order.driverSlotId` ↔ `PickingWave.orderIds[]`。
- (b) 字段是 **cache 却无回填/同步机制**——如真实案例 `Order.items`(Json)从第一次改单起永久腐化。

**额外要查的两个交叉信号(从真实审计提炼,机械脚本难发现,Claude 必须主动看):**
- **设计意图与实现自相矛盾**:注释/迁移声明"单一存储=X",但代码仍在写 Y(真实案例 `batch/route.ts` 注释 vs `orders/[id]/route.ts:133`)。
- **读 FK 写 String 倒挂 / 源派生倒置**:声明的权威字段无写入口,实际在写的是 legacy 副本(真实案例 `ProductTemplate.uomId` vs `unitOfMeasure`)。

## 4. 两份产出物

**A. 字段所有权矩阵**(证据+分类层,按业务链路分组):

```
实体  | 字段         | 定义于 | 写入点(file:line,时机) | 读取点 | 分类      | 问题
Order | deliveryDate | schema | 下单/编辑/确认出发回填   | 列表/打印 | derived   | 出发时被 wave.waveDate 反向覆盖,源派生倒置
Wave  | orderIds     | schema | dispatch 拖拽           | 调度中心  | canonical | 唯一权威 ✅
```

**B. 修复决策表**(行动层,最终交付):对每条 SSOT 冲突给"二选一"owner 决策 + Strangler 安全重构步骤。

```
冲突: order.driverSlotId vs wave.orderIds 都声称"这单归谁送"
决策: 保留 wave.orderIds 为 canonical;driverSlotId 降为"下单默认意向"
步骤: 1.封装统一读取口 getOrderDispatch() 2.列表改读它 3.回填校验 4.停写副本 5.删字段
风险: 中 | 影响读取点: 3 处 | 可选护栏: db:validate 加"订单调度信息单源"不变量
```

**Strangler 重构顺序(写进决策表头,铁律):** 先统一读 → 回填数据 → 再删重复写 → 最后删死字段。绝不一次性大改。前两步零风险。

CI 不变量护栏本次不作为默认产出,但每条冲突的决策行末尾附"可选护栏"建议(接到既有 `db:validate`),用户想要时随手可落。

## 5. 文件结构

```
~/.claude/skills/auditing-data-ownership/
├── SKILL.md                      # 触发条件 + 四步流程 + 四分类判定标准 + Common Mistakes
├── scripts/
│   ├── detect-stack.mjs          # 第1步:探测 ORM/DB 层,输出栈类型 + 扫描配置
│   └── collect-evidence.mjs      # 第2步:按栈规则扫 schema + grep 读写点 → evidence.json
├── references/
│   ├── ownership-matrix.md       # 矩阵模板 + 四分类判定示例(取自 veggie 真实案例)
│   └── refactor-decision.md      # 决策表模板 + Strangler 重构顺序 + owner 选择原则
└── adapters/
    └── prisma.md                 # Prisma 扫描规则(schema 解析、写入点/读取点的代码特征);
                                  # 其余栈走通用 grep 兜底,逐步补 typeorm.md / drizzle.md 等
```

**脚本健壮性要求:** `collect-evidence.mjs` 对大型代码库要能跑(grep/ripgrep 驱动,不全文 AST);读写点用"代码特征正则 + 文件分类"近似,不追求 100% 精确——证据表允许 Claude 复核修正。脚本失败要降级而非崩溃(未知栈仍输出字段清单 + 提示手工补读写点)。

## 6. 验收标准

- 在 veggie(Prisma 栈)上跑,`collect-evidence.mjs` 能对 `schema.prisma` 全部 model 字段产出 evidence.json,且对争议字段(`Order.driverSlotId`、`Order.items`、`Product.qtyOnHand`)正确列出多个写入点。
- Claude 据此能复现真实审计的 P0 病灶判定(至少 P0-1 多真相、P0-3 腐化副本)。
- 在一个非 Prisma 项目(或人为改名 schema)上跑,脚本能降级到通用模式并明确告知覆盖率限制,不崩溃。
- 两份产出物模板可直接套用,决策表含 Strangler 顺序。

---

*本 spec 经用户确认设计后落档。下一步:writing-plans 产出实现计划。*
