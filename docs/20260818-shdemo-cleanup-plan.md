# SHDEMO 演示订单清理 —— 执行前清单（待确认）

> 生成时间：2026-08-18 · 生产库（DigitalOcean droplet 167.99.86.19，宿主机 PostgreSQL）
> 脚本：`scripts/cleanup-shdemo-demo-orders-20260818.ts`
> 本文件是 **dry-run（只读）** 的原样输出，尚未对生产写入任何数据。

## 背景

2026-07-07 为了让「日销售管理中心 → 缺货处理」页面有数据演示，用
`prisma/seed-events/seed-shortage-demo.ts` 往**生产库**补种了 18 张假订单（`SHDEMO-0001` … `SHDEMO-0018`）。
客户在订单列表里看到这批单号后提出疑问，2026-08-18 确认清除。

种子脚本自带的 `--clean` 回滚**已失效**：它靠 `externalRef='seed-shortage-demo'` 找单，
而生产库里这 18 张单的 externalRef 现在全是 NULL（后来被当真单排进了波次，标记在更新中被清掉），
状态也从 CONFIRMED 变成了 WAVE_ASSIGNED。所以改按 `code LIKE 'SHDEMO-%'` 认。

## 影响面（已逐表查过）

| 项目 | 数量 | 处理方式 |
|---|---|---|
| 订单 | 18 张（€29,550.10） | 删除 |
| 订单行 | 111 | 随订单级联删除 |
| 审计日志 | 60 | 随订单级联删除 |
| 送货单 | 18 | 随订单级联删除 |
| 拣货差异 | 0 | — |
| 库存流水 StockMove | 84 条（涉及 49 个商品） | 显式删除，并把 qtyOnHand 增量加回 |
| 拣货波次 PickingWave | 8 个（**全部由演示单组成**） | 整体删除 |
| Trip 行程 | 0 | 无牵连 |
| 对账单 Statement | 0 | 无牵连（脚本遇到引用会直接中止） |

库存修正只动这 49 个商品，用「减去被删流水之和」做增量修正 ——
**不**调用 `recomputeOnHand`（那是全表归零重算，会顺手改掉一大批与本次无关的历史不守恒商品）。

## 本地验证结论

在本地 PostgreSQL 验证库上构造同构场景（3 张演示单 + 1 张真实对照单 + 1 个纯演示波次 + 1 个混合波次），
跑完 `--apply` 后用**独立 SQL**（不看脚本自己的复查）核对：

- 演示单及其行/日志/送货单/流水全部清零，真实对照单 `OP-260818-999` 的 1 行 / 1 送货单 / 1 日志 / 1 流水**毫发无损**
- 纯演示波次被删除；混合波次只摘掉演示单 id，保留真实单
- 三个商品库存精确回到 96 / 100 / 100，与手算一致

## 生产 dry-run 原样输出

```
=== SHDEMO 演示订单清理 · DRY-RUN（只读） ===
【订单】18 张，金额合计 €29550.10
  SHDEMO-0001  WAVE_ASSIGNED  €  1107.76  配送日 2026-07-07  AE D5
  SHDEMO-0002  WAVE_ASSIGNED  €   758.95  配送日 2026-07-07  Administrator
  SHDEMO-0003  WAVE_ASSIGNED  €  1301.89  配送日 2026-07-07  Johnstone Fruit & Veg Ltd
  SHDEMO-0004  WAVE_ASSIGNED  €   680.24  配送日 2026-07-07  Lucky Garden Chinese Restaurant
  SHDEMO-0005  WAVE_ASSIGNED  €  1177.40  配送日 2026-07-07  Golden Dragon Cantonese Kitchen
  SHDEMO-0006  WAVE_ASSIGNED  €  1392.50  配送日 2026-07-07  Red Lotus Thai & Asian Cuisine
  SHDEMO-0007  WAVE_ASSIGNED  €  1091.50  配送日 2026-07-07  Bamboo Garden Restaurant
  SHDEMO-0008  WAVE_ASSIGNED  €  2090.72  配送日 2026-07-07  Phoenix Asian Supermarket & Deli
  SHDEMO-0009  WAVE_ASSIGNED  €  1565.55  配送日 2026-07-07  Jazz Chinese Restaurant
  SHDEMO-0010  WAVE_ASSIGNED  €   895.00  配送日 2026-07-07  Yummy Wok Asian Street Food
  SHDEMO-0011  WAVE_ASSIGNED  €  6756.00  配送日 2026-07-07  Indian Palace Skerries
  SHDEMO-0012  WAVE_ASSIGNED  €  2788.98  配送日 2026-07-07  Oriental Emporium-D6
  SHDEMO-0013  WAVE_ASSIGNED  €   460.14  配送日 2026-07-07  Golden Grain
  SHDEMO-0014  WAVE_ASSIGNED  €   879.74  配送日 2026-07-07  C & LUM LTD Tallaght
  SHDEMO-0015  WAVE_ASSIGNED  €   977.70  配送日 2026-07-07  Cash-Zheng
  SHDEMO-0016  WAVE_ASSIGNED  €  2595.95  配送日 2026-07-07  Veg-Ex
  SHDEMO-0017  WAVE_ASSIGNED  €  1979.50  配送日 2026-07-07  SSB Mullingar
  SHDEMO-0018  WAVE_ASSIGNED  €  1050.58  配送日 2026-07-07  HDL D1
【随订单级联删除】订单行 111 · 审计日志 60 · 送货单 18 · 拣货差异 0
【库存流水】84 条将删除，涉及 49 个商品：
  *Frozen* WANG Boiled Sweet Corn 24*360g CASE     12 条      -47.000 →     139.000  (+186.000)
  *Blue Bag*Odlums Cream Plain Flour 8*2KG         9 条       68.000 →     157.000  (+89.000)
  *Blue Bag*Odlums Cream Plain Flour 25Kg          9 条       63.000 →     136.000  (+73.000)
  12 OZ STC Cup & Lids 300's CASE                  2 条       24.000 →      51.000  (+27.000)
  Chilli Red Class-1 CASE                          2 条       23.000 →      46.000  (+23.000)
  DAESANG Korean BEEF RIB BBQ Bulgogi Sauce(2367   2 条       24.000 →      47.000  (+23.000)
  CN Ham Tan(salted cooked egg) 24*6pcs CASE       2 条       14.000 →      32.000  (+18.000)
  Chilli Powder Extra-Hot 1KG PKT                  2 条       24.000 →      41.000  (+17.000)
  DS Pork&Veg Bun 20*6's CASE                      2 条       24.000 →      39.000  (+15.000)
  DS Prawn Dumpling Ha Kau 10*40's CASE            1 条       24.000 →      39.000  (+15.000)
  Coconut and Red Bean Bread 24*85g CASE           1 条       24.000 →      38.000  (+14.000)
  CFW002N White C-Fold Hand Towel 2295' 2ply 21*   1 条       24.000 →      38.000  (+14.000)
  Chipping potato 25KG BAG                         1 条       24.000 →      38.000  (+14.000)
  DS Shanghai Bun Pork 10*28's CASE                1 条       24.000 →      38.000  (+14.000)
  Black Sesame Dried Jujube With Walnuts 1KG CAS   1 条       24.000 →      37.000  (+13.000)
  CN Jinzai Fried Anchovy Snack Sauce 40*110g CA   1 条       23.000 →      36.000  (+13.000)
  *Seeds* Star Anise 1KG PKT                       1 条       92.000 →     104.000  (+12.000)
  Amoy Hoi Sin BBQ Sauce 12*482g CASE              1 条       22.000 →      34.000  (+12.000)
  BLENDERS Garlic MAYONNAISE 10L BUCKET            1 条       23.000 →      35.000  (+12.000)
  Chang Tamarind Without Seed 50*454g CASE         1 条       24.000 →      36.000  (+12.000)
  Choisam CASE                                     1 条       24.000 →      35.000  (+11.000)
  BAG  Onion SP. 20kg                              1 条       -8.002 →       2.998  (+11.000)
  4 OZ SATCO Clear Cup&Lid 1000's CASE             1 条       24.000 →      35.000  (+11.000)
  Black Sesame Seed 10*1KG CASE                    1 条       24.000 →      35.000  (+11.000)
  Aji Chicken&Veg Gyoza 10*600g CASE               1 条       23.000 →      33.000  (+10.000)
  Bicarbonate Of Soda 4*3KG CASE                   2 条       23.000 →      33.000  (+10.000)
  Dongguan Rice Vermicelli 30*400g CASE            1 条       24.000 →      34.000  (+10.000)
  Cooking Wine 10L DRUM                            1 条       24.000 →      33.000  (+9.000)
  ChangSi Ejiao Honey Jujube (dates) 20x235g CAS   1 条       24.000 →      33.000  (+9.000)
  Bread Filled with Chocolate Cream Bread 24*85g   1 条       24.000 →      32.000  (+8.000)
  Charta Premium Copier Paper A4                   1 条       24.000 →      32.000  (+8.000)
  Cock Sour Bamboo Shoot Slice 12*850g CASE        1 条       24.000 →      32.000  (+8.000)
  Aji Prawn Gyoza 10*600g CASE                     1 条       24.000 →      31.000  (+7.000)
  Cambodian Rice Vermicelli Yinsi 50*300g CASE     1 条       24.000 →      31.000  (+7.000)
  Affilla Cress CASE                               1 条       24.000 →      30.000  (+6.000)
  Bamboo Charcoal CASE                             1 条       24.000 →      30.000  (+6.000)
  Aubergine CASE                                   1 条       24.000 →      29.000  (+5.000)
  2 OZ Hinged Sauce Cups 1000's CASE               1 条       24.000 →      29.000  (+5.000)
  Asahi Baran 50*1000Pcs CASE                      2 条       24.000 →      29.000  (+5.000)
  CHEF Vinegar 2*5L CASE                           1 条       23.000 →      28.000  (+5.000)
  Dragon Fruit Red CASE                            1 条       24.000 →      29.000  (+5.000)
  Dried Longan with shell&with seed 10*500g CASE   1 条       24.000 →      29.000  (+5.000)
  Chilli Powder 1KG PKT                            1 条       24.000 →      28.000  (+4.000)
  Deepio Greasebuster 6kg CASE                     1 条       24.000 →      28.000  (+4.000)
  Cucumber CASE                                    1 条       10.000 →      13.000  (+3.000)
  26/30 PD Prawn IQF (Black Box) 6*800g CASE       1 条       24.000 →      27.000  (+3.000)
  Cauliflower CASE                                 1 条       24.000 →      27.000  (+3.000)
  Mushroom CASE                                    1 条        8.000 →       9.000  (+1.000)
  Pepper Green 5KG CASE                            1 条       17.000 →      18.000  (+1.000)
【拣货波次】受影响 8 个
  整体删除（清完就空了）: 2026-07-07 #5 John  原 2 单，全是演示单
  整体删除（清完就空了）: 2026-07-07 #4 BAO  原 3 单，全是演示单
  整体删除（清完就空了）: 2026-07-07 #17 SEAN  原 2 单，全是演示单
  整体删除（清完就空了）: 2026-07-07 #1 ANDRIUS  原 2 单，全是演示单
  整体删除（清完就空了）: 2026-07-07 #7 WIT  原 1 单，全是演示单
  整体删除（清完就空了）: 2026-07-07 #3 BAO  原 6 单，全是演示单
  整体删除（清完就空了）: 2026-07-07 #22 John  原 1 单，全是演示单
  整体删除（清完就空了）: 2026-07-07 #9 hanhua  原 1 单，全是演示单
(DRY-RUN，未写入任何数据。确认无误后加 --apply 执行)
```

## 执行方式（待确认后运行）

```bash
scp -P 2200 scripts/cleanup-shdemo-demo-orders-20260818.ts dev@167.99.86.19:/tmp/cleanup-shdemo.ts
ssh -p 2200 dev@167.99.86.19 'sudo sh -c "cd /opt/veggie && TAG=\$(cat .deployed_tag) \
  docker compose --profile tools run --rm -T \
  -v /tmp/cleanup-shdemo.ts:/app/scripts/cleanup-shdemo.ts \
  migrator npx tsx scripts/cleanup-shdemo.ts --apply"'
```

运行时镜像 `veggie-app` 里没有 prisma CLI 与驱动包，必须走 `migrator` 镜像（profile tools）。
脚本删完会自己复查一遍残留与库存，任一项不符即以非 0 退出。

## 注意

- 删除后，2026-07-07 当天的销售统计会减少 €29,550.10，配送记录少 8 个波次 —— 这是**修正**，那本来就是假数据。
- 49 个商品的库存会**上升**（演示单当初真扣了库存）。其中两个当前是负库存：
  `*Frozen* WANG Boiled Sweet Corn` -47 → 139、`BAG Onion SP. 20kg` -8.002 → 2.998。
- 操作不可逆，但有兜底：`veggie-backup.timer` 每天 03:15 自动 pg_dump，
  最新一份是 `2026-08-18T02-15-18Z...sql.gz`（85 MB），`/data/veggie/backups/backups/` 下至少留了 7 天。
  真出问题可以从这份备份里把这 18 张单捞回来。

---

# 执行结果（2026-08-18 已完成）

用户确认后对生产库执行 `--apply`，脚本退出码 0，自查复查全绿。

## 脚本自查

```
=== 复查 ===
残留订单 0 · 残留流水 0 · 残留波次引用 0 · 残留订单行 0 · 残留送货单 0
库存与预期不符的商品：0 个
✅ 清理完成，复查全绿。
```

## 独立 SQL 复核（不依赖脚本自己的结论）

| 检查项 | 结果 |
|---|---|
| SHDEMO 订单 / 流水 / 孤儿送货单 | 0 / 0 / 0 |
| 那 8 个演示波次 | 全部删除，剩 0 |
| **全库**指向已删订单的悬空波次引用 | 0 |
| 抽查库存（对照 dry-run 预测值） | `*Blue Bag*Odlums…8*2KG` 157 · `*Frozen* WANG Sweet Corn` 139 · `BAG Onion SP. 20kg` 2.998 · `Mushroom CASE` 9 · `Pepper Green 5KG CASE` 18 —— 逐项吻合 |
| 订单编号形态 | 只剩「Odoo 导入 149,802」+「新规则 63」，SHDEMO 类别消失 |
| 2026-07-07 剩余波次 | 0（那天原本 8 个波次全是演示的，无真实配送） |

## 服务状态

- `/api/health` → `{"status":"ok","db":"ok"}`
- 容器 `veggie-app-1` Up (healthy)
- 生产域名 https://www.johnstonebros.ie/ → HTTP 200

## 经验（下次做同类操作可直接复用）

生产库跑一次性 TS 脚本的正确姿势：

- 运行时镜像 `veggie-app` 是 Next standalone，`node_modules` 被 nft 裁剪过，**没有 prisma CLI 和驱动包**，脚本在里面跑不了。要用 `migrator` 镜像（compose 里 `profiles: ["tools"]`，从 builder 阶段派生，带 tsx v4.21）。
- 镜像 tag 必须取 `/opt/veggie/.deployed_tag`；`sudo -E` **不会**把 `TAG` 传进去（sudo 明确忽略并给出警告），结果会退化成拉 `:latest` 而报 `unauthorized`。正确写法是 `sudo sh -c "cd /opt/veggie && TAG=\$(cat .deployed_tag) docker compose …"`。
- 脚本用 `-v /tmp/xxx.ts:/app/scripts/xxx.ts` 挂进去即可，不必重新构建镜像；`run --rm -T` 的 `-T` 别省，非交互 ssh 下不加会吃 stdin。
