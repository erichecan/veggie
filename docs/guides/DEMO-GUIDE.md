# 蔬菜批发系统 · 演示流程指南

**演示地址：** https://veggie-demo-dfd7b2qpra-de.a.run.app

> 本系统模拟一家蔬菜批发商从接单到送货的完整流程，共 5 个角色。
> 建议在电脑浏览器上体验，按下方顺序逐步操作。

---

## 角色一览

| 角色 | 负责什么 |
|------|---------|
| 🏭 运营人员 | 管理商品、处理订单、生成拣货波次、创建配送行程、设置客户定价 |
| 🍜 餐馆老板 | 浏览商品、下单 |
| 📦 拣货员 | 在仓库按单拣货 |
| 🔀 分货员 | 将拣好的货按餐馆分类 |
| 🚛 司机 | 配送并确认签收 |

---

## 第一步：运营人员 · 查看商品

**用这个链接进入运营界面：**

👉 [进入运营人员界面](https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=operator&id=op_001&name=Operator+-+Li+Mei&path=/operator/products)

`https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=operator&id=op_001&name=Operator+-+Li+Mei&path=/operator/products`

**操作：**
1. 进入后可以看到商品列表，包含菠菜、胡萝卜、西兰花等 7 款在售商品
2. 点击任意商品右侧的「编辑」，可以修改名称、价格、库存
3. 点击「+ 新建商品」可以添加新商品（演示用，填完点保存即可）

---

## 第二步：运营人员 · 设置客户定价（可选体验）

**在顶部导航点击「客户定价」，或直接用链接：**

👉 [进入客户定价](https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=operator&id=op_001&name=Operator+-+Li+Mei&path=/operator/pricing)

`https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=operator&id=op_001&name=Operator+-+Li+Mei&path=/operator/pricing`

**操作：**
1. 左侧选择一家餐馆，例如「Golden Wok」
2. 在「全局默认折扣」行，规则类型选「按比例折扣」，输入 `90`，表示九折
3. 也可以在某个商品行单独设置「固定单价」，覆盖全局折扣
4. 点击右上角「保存价格表」
5. 切换到「Jade Garden」，可以设置不同的折扣

> 设置完成后，该餐馆下单时看到的价格就会自动反映折扣。

---

## 第三步：餐馆老板 · 浏览商品并下单

> 建议新开一个浏览器标签页，模拟餐馆老板的视角。

**用这个链接进入餐馆界面：**

👉 [进入餐馆 Golden Wok](https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=restaurant&id=rest_001&name=Golden+Wok&path=/restaurant)

`https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=restaurant&id=rest_001&name=Golden+Wok&path=/restaurant`

**操作：**
1. 可以看到商品列表，价格已反映运营设置的折扣（如果第二步跳过则显示原价）
2. 点击商品卡片上的「加入购物车」，多选几样
3. 点击右上角「🛒 购物车」查看已选商品，可以调整数量
4. 点击「提交订单」→「确认付款」，订单即生成

**也可以让另一家餐馆也下单（模拟多客户场景）：**

👉 [进入餐馆 Jade Garden](https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=restaurant&id=rest_002&name=Jade+Garden&path=/restaurant)

`https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=restaurant&id=rest_002&name=Jade+Garden&path=/restaurant`

重复上方操作，再下一笔订单。

---

## 第四步：运营人员 · 生成拣货波次

**回到运营人员界面，点击顶部「订单管理」，或用链接：**

👉 [进入订单管理](https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=operator&id=op_001&name=Operator+-+Li+Mei&path=/operator/orders)

`https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=operator&id=op_001&name=Operator+-+Li+Mei&path=/operator/orders`

**操作：**
1. 可以看到刚才餐馆提交的订单，状态为「待处理」
2. 勾选想合并拣货的订单（可以全选）
3. 点击「生成拣货波次」
4. 系统自动按商品区域（叶菜区、根茎区等）汇总成一张拣货单

---

## 第五步：运营人员 · 查看拣货波次并分配

**点击顶部「拣货波次」，或用链接：**

👉 [进入拣货波次](https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=operator&id=op_001&name=Operator+-+Li+Mei&path=/operator/waves)

`https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=operator&id=op_001&name=Operator+-+Li+Mei&path=/operator/waves`

**操作：**
1. 可以看到刚生成的波次，点击「查看详情」
2. 看到按商品区域分组的拣货清单，以及每项商品需要多少数量
3. 返回列表，点击「分配拣货员」，选择 Picker - Wang Qiang

---

## 第六步：拣货员 · 执行拣货

> 新开一个浏览器标签页，模拟拣货员视角。

**用这个链接进入拣货员界面：**

👉 [进入拣货员界面](https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=picker&id=picker_001&name=Picker+-+Wang+Qiang&path=/picker)

`https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=picker&id=picker_001&name=Picker+-+Wang+Qiang&path=/picker`

**操作：**
1. 看到分配给自己的波次，点击「开始拣货」
2. 按商品区域逐项点击「✓ 完成」确认已拣到货
3. 所有商品都确认后，点击「完成拣货」

---

## 第七步：分货员 · 按餐馆分货

> 新开一个浏览器标签页，模拟分货员视角。

**用这个链接进入分货员界面：**

👉 [进入分货员界面](https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=sorter&id=sorter_001&name=Sorter+-+Chen+Fang&path=/sorter)

`https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=sorter&id=sorter_001&name=Sorter+-+Chen+Fang&path=/sorter`

**操作：**
1. 看到已完成拣货的波次，点击「开始分货」
2. 按商品逐项确认分给哪些餐馆、各几份
3. 全部确认后，点击「完成分货」

---

## 第八步：运营人员 · 创建配送行程

**回到运营人员界面，点击顶部「配送行程」，或用链接：**

👉 [进入配送行程](https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=operator&id=op_001&name=Operator+-+Li+Mei&path=/operator/trips)

`https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=operator&id=op_001&name=Operator+-+Li+Mei&path=/operator/trips`

**操作：**
1. 点击「创建行程」
2. 选择刚完成分货的波次
3. 选择司机（Driver - Zhang Wei）
4. 设置出发时间，点击「创建行程」

---

## 第九步：司机 · 配送并确认签收

> 新开一个浏览器标签页，模拟司机视角。

**用这个链接进入司机界面：**

👉 [进入司机界面](https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=driver&id=driver_001&name=Driver+-+Zhang+Wei&path=/driver)

`https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=driver&id=driver_001&name=Driver+-+Zhang+Wei&path=/driver`

**操作：**
1. 看到今日行程，点击「开始配送」
2. 按配送顺序逐个餐馆操作：
   - 点击餐馆名称展开
   - 确认货物无误，点击「核货完成」
   - 输入实收货款金额
   - 点击「拍照签收」（演示模式下点击即模拟上传）
   - 点击「确认送达」
3. 所有餐馆都送完后，点击「行程完成」

---

## 全流程完成 ✅

回到运营人员界面查看订单管理，可以看到所有订单状态已变为「已完成」。

---

## 快速体验（跳过中间环节）

如果时间有限，只想看下单 → 送达的完整状态变化：

1. [餐馆下单](https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=restaurant&id=rest_001&name=Golden+Wok&path=/restaurant) → 加入购物车 → 提交订单
2. [运营查看订单](https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=operator&id=op_001&name=Operator+-+Li+Mei&path=/operator/orders) → 勾选 → 生成波次
3. [拣货员完成拣货](https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=picker&id=picker_001&name=Picker+-+Wang+Qiang&path=/picker)
4. [分货员完成分货](https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=sorter&id=sorter_001&name=Sorter+-+Chen+Fang&path=/sorter)
5. [运营创建行程](https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=operator&id=op_001&name=Operator+-+Li+Mei&path=/operator/trips)
6. [司机完成配送](https://veggie-demo-dfd7b2qpra-de.a.run.app/enter?role=driver&id=driver_001&name=Driver+-+Zhang+Wei&path=/driver)

---

## 注意事项

- 所有数据保存在浏览器本地，**刷新不丢失**，关闭浏览器后数据清空
- 如果想重新开始，按 `F12` 打开开发者工具 → Application → Local Storage → 清除即可
- 不同角色建议在**不同浏览器标签页**里操作，互不干扰
- 本系统为纯前端演示，无真实数据库，所有操作均安全

---

*演示系统 · 仅供产品体验使用*
