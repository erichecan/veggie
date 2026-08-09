# 价格表嵌套跳出进价 —— 完整测试评估

> 客户报告：测试 `CITY CENTREtest` 价格表（下面嵌套 `M7N3M1test`），跳出来的价格是 COST PRICE。
> 结论：**属实，且已造成 4 笔真实少收**。根因是定价引擎对 Odoo 的 margin 语义实现错了两处。

---

## 1. 现象复现

生产库真实数据：

| | |
|---|---|
| `pl_35` = `CITY CENTREtest` | 5 条规则，最后一条是 `applyOn=global`、`formulaBase=pricelist` → `pl_89` |
| `pl_89` = `M7N3M1test` | 1 条规则，`applyOn=variant`、`list_price + 6` |
| 命中商品 | `Red Unicorn Long Grain Rice 20kg BAG`，牌价 **25.50**，进价 **18.03** |

那条嵌套规则上带着：

```json
"priceMinMargin": 0,
"priceMaxMargin": 0
```

拿生产数据跑修复前的引擎：

```
直接查 M7N3M1test        → 31.50   ✅（25.50 + 6，正确）
查 CITY CENTREtest（嵌套）→ 18.03   ⛔ 正是进价
```

---

## 2. 根因：两处偏离 Odoo，叠加后价格被钉死在进价

Odoo 12 `product/models/product_pricelist.py` 的 `_compute_price_rule`：

```python
price_limit = price                       # ← 基准价，折扣之前
price = price - price * (rule.price_discount / 100)
if rule.price_round:
    price = tools.float_round(price, precision_rounding=rule.price_round)
if rule.price_surcharge:
    price += price_surcharge
if rule.price_min_margin:                 # ← 真值判断，0 直接跳过
    price = max(price, price_limit + price_min_margin)
if rule.price_max_margin:                 # ← 同上
    price = min(price, price_limit + price_max_margin)
```

我们的实现有两处不同：

| # | 偏离 | 后果 |
|---|---|---|
| **D1** | 用 `item.priceMinMargin !== undefined` 判断，而不是真值判断 | `0` 被当成生效的约束。min 与 max 同时为 0 时 → `min(max(价, X), X)`，价格被**恒等钉死在 X** |
| **D2** | 夹取基准取 `product.standardPrice`（**进价**），而不是 `price_limit`（**基准价**） | 上面那个 X 正好就是进价 → 跳出 COST PRICE |
| **D3** | `roundingMethod`（Odoo 的 `price_round`）**引擎从头到尾没读过** | 页面上能填、能存库，但对价格毫无影响。当前生产 0 条规则设了它，属潜伏问题 |

D1 单独存在时只是"价格被钉在基准价"；D1 + D2 叠加，才正好等于进价。客户看到的就是这个组合。

**触发门槛很低**：UI 的 `onChange` 写的是 `e.target.value ? Number(...) : undefined`，
用户在「最低利润」里输入 `0`（一个很自然的动作，意思是"不设下限"），
`"0"` 是非空字符串 → 真的存进 `0` → 这条规则的价格从此等于进价。

---

## 3. ⚠️ 这个问题上一轮出现过，但当时是改数据绕过去的

`tests/pricing-engine-formula.test.ts` 里留着这样一行：

```ts
// 生产库这条数据当时被 priceMinMargin/priceMaxMargin=0 覆盖，Bug 2 已修复为 undefined
priceMinMargin: undefined, priceMaxMargin: undefined,
```

但 20260808 从生产 dump 出来，**`pl_35` 这条规则的 `0/0` 原封不动躺在那里**。
也就是说当时只把测试里的值改成了 `undefined`，生产数据没动，引擎逻辑也没动。

同一轮还把错误语义写进了断言并锁死：

```ts
assert.equal(r.price, 35, '牌价 50 ... 被 priceMaxMargin=5 封顶在 成本30+5=35')
assert.equal(r.price, 30, 'minMargin=0 应兜底到成本价30，且0要被当成真实值而非"未设置"')
```

这两条都与 Odoo 相反。**把 `undefined` 写进测试，等于把 bug 藏起来** ——
测试全绿，生产照错。

> 「不低于成本价出售」这个业务诉求本身是合理的，但它不是 Odoo 里 `margin=0` 的含义。
> 真要这么做，应当**基准选 `standard_price`、margin 给正数**，让意图写在脸上。
> 已按这个写法补了一条测试。

---

## 4. 实际损失

- 挂 `CITY CENTREtest` 的客户：**73 个**（都是优先级 1）。这不是测试价格表，
  只是有人给它改名加了 `test` 后缀。
- 挂这张表的订单 20 954 笔，其中 **20 947 笔是从 Odoo 导入的历史单**
  （自带原价，不经我们的引擎），**本系统新建的只有 7 笔**。
- 受影响的只有嵌套表里那一个商品（其余商品嵌套未命中 → 跳过该规则 → 回退牌价，价格正常）。

以进价成交的订单行：

| 订单 | 日期 | 客户 | 状态 | 成交价 | 应为 | 少收 |
|---|---|---|---|---:|---:|---:|
| OP-260718-003 | 07-18 | 818 Cake Studio D13 | PENDING | 18.03 | 31.50 | 13.47 |
| OP-260719-001 | 07-19 | 818 Cake Studio D13 | PENDING | 18.03 | 31.50 | 13.47 |
| OP-260719-002 | 07-19 | 818 Cake Studio D13 | PENDING | 18.03 | 31.50 | 13.47 |
| OP-260720-001 | 07-20 | 818 Cake Studio D13 | PENDING | 18.03 | 31.50 | 13.47 |
| | | | | | **合计** | **€53.88** |

**四笔状态都还是 PENDING（未开票）**，所以改价还来得及。
是否改价是业务决定，本次未动订单数据。

---

## 5. 修复

`lib/pricing-engine.ts` 的 formula 分支改为与 Odoo 对齐：

- margin 判断改真值：`if (item.priceMinMargin)` —— 0 表示不设限
- 夹取基准改为 `priceLimit = formulaBase`（基准价），不再用进价
- 补上 `roundingMethod` 的舍入，且严格按 Odoo 顺序：**折扣 → 舍入 → 加价 → margin 夹取**
  （先加价再舍入会把加价一起 round 掉，结果与 Odoo 对不上）

修复后同样用生产数据验证：

```
查 CITY CENTREtest（嵌套 M7N3M1test）→ 31.50   ✅
牌价 25.50 打五折 + 最低利润 2  → max(12.75, 25.50+2) = 27.50  ✅
牌价 25.50 加价 10 + 最高利润 3 → min(35.50, 25.50+3) = 28.50  ✅
牌价 25.50 减 7% 舍入到 0.05    → 23.70                        ✅
```

回归测试：客户场景那条改成用**生产库里真实的 `0/0`**（而不是 `undefined`），
这样它才真的守得住这个 bug。全量 384 测试 0 失败。

---

## 6. 遗留

- [x] ~~那 4 笔 PENDING 订单是否改价~~ ✅ 2026-08-08 已补价（用户确认）

      单价 18.03 → 31.50，四张单总额各 +13.47：
      129.03→142.50 · 61.03→74.50 · 137.53→151.00 · 163.03→176.50。

      **没有走整单 PUT 重算**：那个接口一律用引擎权威价覆盖每一行，会把同单里
      另外两条 25.50 的米行和洋葱行一起改掉 —— 用户要的是「4 笔补价」，
      不该顺手扩大范围。改用定向更新，并同步了三处：`OrderLine.unitPrice/subtotal`、
      `Order.items` 快照（这是个双存字段，只改 OrderLine 会两份数据分叉）、
      `Order.totalAmount`。改完校验三者一致，并写了 `ActionLog` 留痕
      （不走接口就没有自动审计，凭空多出 13.47 会说不清）。
- [ ] `pl_35` 上残留的 `priceMinMargin:0 / priceMaxMargin:0` 引擎已按"不设限"处理，
      留着无害。若想让配置更干净可以清掉，不紧急。
- [x] ~~UI 的「最低/最高利润」加提示~~ ✅ 2026-08-08 已加（用户确认）

      三个字段的 placeholder 改成「留空 = 不设限」/「0 = 不舍入」，下方加一条说明：
      **两者都是相对「基准价」计算，不是相对进价**。标签也补了中文。

- [x] ~~同一张单里 25.50 的行~~ ✅ 2026-08-08 已一并补齐（用户确认）

      查全之后发现是 **8 行 25.50，但只有 3 行是同一回事**，不能按单价批量匹配：

      | 订单 | 状态 | 价格表 | 价格来源 | 处置 |
      |---|---|---|---|---|
      | OP-260718-003（2 行）· OP-260719-001（1 行） | PENDING | pl_35 | DEFAULT | ✅ 补到 31.50 |
      | OP-260703-003 | WAVE_ASSIGNED | **无价格表** | DEFAULT | 未动 —— 没挂价格表，牌价 25.50 本来就对 |
      | OP-260704-002（3 行） | WAVE_ASSIGNED | **pl_67** | LAST/DEFAULT | 未动 —— 另一张价格表，与本次无关 |
      | OP-260703-001 | WAVE_ASSIGNED | pl_35 | **LAST** | 未动 —— 见下 |

      补完后 OP-260718-003 → 154.50、OP-260719-001 → 80.50，两张单里该商品的
      全部 5 行统一为 31.50，`items` 快照与总额一致，已通过接口回读确认。

- [ ] ⚠️ **OP-260703-001 待定**：同样挂 pl_35，同样是 25.50，但价格来源是
      `LAST`（最近成交价）而不是牌价兜底，且状态已是 `WAVE_ASSIGNED`（排了波次）。
      按今天的规则它也应是 31.50（2 行，差 €12）。因为口径与状态都和上面那批不同，
      本次未动，需要单独决定。

- [ ] `roundingMethod` 现在生效了。生产当前 0 条规则用到它，但这意味着
      **以前填过这个字段的人，看到的价格与预期不符却无从察觉** —— 已确认现网无此情况。
