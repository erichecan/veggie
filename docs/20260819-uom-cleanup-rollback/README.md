# 20260819 生产库单位与商品名清理 — 执行记录与回滚脚本

客户 20260819 批准执行三项生产数据变更。本目录存放**执行前的原值**，
任何一步出问题都可以拿对应的 `.sql` 直接回滚。

执行方式：SSH 到 `167.99.86.19`，`sudo -u postgres psql -d veggie`，
每步一个事务（`BEGIN ... COMMIT`），执行前先 `\copy` 导出原值，执行后立即回读验证。

## 执行了什么

### ① 垃圾商品（`rollback-step3-*.sql`）

**原计划是全部归档，实测后改了手段** —— 那 10 个"垃圾商品"里 8 个有真实订单记录，
最近使用到 2026-07（执行前一个月）：

| 商品 | 订单行 | 最后使用 | 库存 |
|---|---|---|---|
| TEST 1P | 32 | 2026-07-13 | 0 |
| price difference | 24 | 2026-07-17 | 0 |
| TEST 14P | 9 | 2026-04-28 | 43.847 |
| test BB | 9 | 2026-07-17 | 0 |
| test AA | 8 | 2026-07-13 | 0 |
| REUSE | 3 | 2026-07-18 | -1 |
| reuse | 2 | 2026-07-11 | 0 |
| TEST CONSUMABLE | 1 | 2026-06-19 | 0 |
| **tttt / osp** | **0** | 从未 | 0 |

它们不是垃圾，是业务在用的占位商品（差价调整、周转筐押金、测试单）。
归档会让操作员下单时找不到，直接影响日常。所以：

- `tttt`、`osp`（零交易）→ **归档**（2 个模板 + 2 个变体）
- 其余 8 个 → **只取消 `canBePurchased`**，销售侧不动

目的（不再污染采购导入的匹配候选）达成，业务零影响，且完全可逆。

### ② 商品名连续空格（`rollback-step2-*.sql`）

74 条（69 个连续空白 + 5 个首尾空白），`ProductTemplate` 与 `Product` 各 74 条。
只压缩空白，**不改任何一个字符**。

客户报的那条修好了：
`ASIAN CHOICE␣␣Black Tiger Shrimp HOSO 31/40 700g PKT`
→ `ASIAN CHOICE Black Tiger Shrimp HOSO 31/40 700g PKT`

⚠️ 清洗后新增 1 组同名：`AUTHENTIC Pork␣␣Gyoza 600g PKT` 与
`AUTHENTIC Pork Gyoza 600g PKT` —— 本来就是同一商品的重复录入，
两条都已归档、库存 0，不出现在任何选品里，判定为无影响。

### ③ 计量单位表重建（`rollback-step1-uoms.sql`）

判据来自 `lib/uom/extract-from-product-name.ts`（19 条单测），
输入是清洗空格后的 1734 个 ACTIVE 可售商品名，提炼出 **20 个单位，覆盖 94.3%**。

- 新建 1 个：`SINGLE`（其余 19 个库里已有）
- `kg` → 改名 `KG` 并激活（59 个商品在用，此前竟是 inactive）
- 停用 19 个：商品名里从未出现**且零引用**的自造单位
  （件/包/扎/把/板/桶/瓶/盘/筐/箱/罐/袋、L/mL/day/h、1.5KG/CASE、3KG/CASE、4KG/CASE）

单位总数 52 → 53，现役 **24** 个。

⚠️ **4 个有引用的保留了 active**，没停用：

| 单位 | 为什么还在 |
|---|---|
| `头` | 客户 0819 在那个已归档的 tiger shrimp 上配了 2 条多规格 —— 当时没有 PKT 可选，只能挑「头」 |
| `盒` | 同上 1 条 + 1 个模板的采购单位 |
| `1KG` | 1 条多规格引用 |
| `EACH` | 1 个模板的销售单位 |

现在 PKT / CASE 都有了，客户重新配一次那个 tiger shrimp 的规格后，
`头` 和 `1KG` 就会变成零引用，届时可以再跑一次停用。

## 回滚方法

```bash
scp -i docs/dev-server-info/key_dev2026 -P 2200 <某个>.sql dev@167.99.86.19:/tmp/
ssh -i docs/dev-server-info/key_dev2026 -p 2200 dev@167.99.86.19 \
  "sudo -u postgres psql -d veggie -f /tmp/<某个>.sql"
```

`rollback-step1-uoms.sql` 是**全部 52 个单位**执行前的 name + active 快照，
整份重放即可回到执行前状态。

## 执行后验证

- 生产首页 HTTP 200，`/api/health` → `{"status":"ok","db":"ok"}`
- `/api/uoms` 带 `where: { active: true }`，停用的单位不会再出现在任何下拉里

## ⚠️ 尚未部署的代码

`ProductSaleUom.factor`（换算系数挂商品）在分支 `feat/uom-overhaul-and-purchase-import`
上，**生产库还没有这一列**。所以生产此刻的多规格仍是旧行为
（换算读全局 `Uom.factor`，而现在所有单位 factor 都是 1 → 1:1，与清理前一致，不会变坏）。
多规格真正生效要等该分支合并部署 + 迁移执行。
