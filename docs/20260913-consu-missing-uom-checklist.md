# Consumable 商品缺失销售单位（goodsType）清单

背景：`lib/print/trip-picking-template.ts` 的拣货单分表逻辑已改为只看销售单位
`Uom.goodsType`（LOOSE=零散货，其余=整箱整袋），不再靠 `Product.type` 强制把
Consumable 商品分进零散货表。生产库里有 21 个 Consumable 商品完全没配置任何
Uom/goodsType（既没有基准单位，也没有可售单位），改动后会默认落进"整箱整袋"表。
本清单按"是否真实商品"分组，供运营去 商品→设置→计量单位 逐个核对补全。

数据来源：生产库只读查询，2026-09-13。`total_order_lines`=历史全部订单行数，
`recent_order_lines`=近 180 天订单行数。

## 一、真实商品，需要核对是否分对表（建议按顺序处理）

| 商品名 | 分类 | 历史订单行 | 近180天 | 建议 |
|---|---|---:|---:|---|
| Heera Garlic Powder 1KG | Spices | 204 | 10 | **优先处理**：订单量大，需确认是按 KG 称重零散卖还是整包卖，配对应 Uom |
| OW Soybean Roll 180g | Dry Food | 9 | 0 | 按包装规格看应是整袋/整包，建议配 PKT/BAG 类 goodsType=BULK |
| FRUIT MIX | Fruit | 1 | 0 | 需确认是称重拼盘（LOOSE）还是固定装（BULK） |
| Coriander Prepacked | Herbs | 0 | 0 | 名字带"Prepacked"，大概率是预包装小袋，建议配 BULK |
| Egg Stirrer 50cm | Sundry | 1 | 0 | 器具类，按"个"卖，配任意 goodsType=BULK 的 Uom 即可 |
| Eggbeater Piece | Sundry | 1 | 0 | 同上，器具类 |
| UT 12'S BAMBOO HANDLE STRAINER BRASS | Packaging | 0 | 0 | 器具类，同上 |
| UT S/S SPIDER SKIMMER 6'S | Packaging | 0 | 0 | 器具类，同上 |
| FACE SHIELD | Sundry | 0 | 0 | 防护用品，按"个"卖，同上 |

## 二、疑似测试数据 / 记账调整项，不是真实拣货商品

这些不会真正出现在仓库拣货作业里，可以不配 Uom；如果确认是废弃测试数据，
建议交给数据清理另行处理（超出本次改动范围，不在此清单里动手）。

| 商品名 | 分类 | 历史订单行 | 近180天 | 备注 |
|---|---|---:|---:|---|
| price difference | （无分类） | 26 | 4 | 记账用差价调整行，非实物 |
| Small Offer Set | （无分类） | 75 | 2 | 促销赠品套装，是否需要在拣货单上出现待业务确认 |
| Discount | （无分类） | 2 | 2 | 折扣调整行，非实物 |
| Deliver Service | Sundry | 3 | 1 | 配送服务费，非实物 |
| vest | （无分类） | 10 | 10 | 名称无意义，疑似测试脏数据但仍在被下单，需先问业务这是什么 |
| test AA | TEST | 10 | 7 | 测试分类下的测试商品 |
| test BB | TEST | 9 | 4 | 同上 |
| reuse | （无分类） | 2 | 2 | 名称无意义，需业务确认 |
| shirmp | （无分类） | 2 | 2 | 疑似 "shrimp" 拼写错误的测试/临时商品 |
| TEST CONSUMABLE | （无分类） | 1 | 1 | 明确的测试商品 |
| osp | （无分类） | 0 | 0 | 名称无意义，无历史订单 |
| tttt | （无分类） | 0 | 0 | 明确的测试商品，无历史订单 |

## 处理建议

1. 第一组（9 个真实商品）：去 Settings→计量单位 给它们配上合适的基准/可售单位
   （已有 goodsType 标注的同类商品可以参考着配），配完之后拣货单分表就会准确。
2. 第二组（12 个）里 `vest`/`reuse`/`shirmp` 三个仍有近期订单但名字无业务含义，
   建议先找业务确认这三个到底是什么，不要直接当废弃数据清理。
3. 本清单只影响"拣货单进哪张表"，不影响库存扣减等其他逻辑（那部分仍由
   `Product.type` 控制，未改动）。
