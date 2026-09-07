# DEV-REPORT：商品可售单位装货顺序（UoM Sequence）

对应 `DEV-PLAN.md`。小改（12 个文件，2 张迁移），未走独立任务台账。

## 做了什么

给可售单位（`ProductSaleUom`，基础单位 + 每个额外单位各一行）加了一个"装货顺序"数字字段，仓库配货/司机卸货用：数字越小越先装/放最下（重、耐压），越大越后装/放最上（怕压），语义和校验逐字照抄现有的 `Product.sequence`——可空、不做防重复校验，允许大量商品共用同一个数字（这是客户明确要的行为，不是遗漏）。拣货单/托盘明细据此排序。

⚠️ **本次开发中途推翻过一次设计**：第一版按"避免重复维护成本"的建议做成了三档枚举（BOTTOM/NORMAL/TOP 下拉框），已实现验证。客户随后明确表态要的是跟 `Product.sequence` 一样的纯数字，只是要求可售单位级别也各自有值。已按新方案重做：删掉枚举字段和相关代码，改成 `ProductSaleUom.sequence Int?`，UI 从下拉框换成数字输入框。两版都各有一张迁移文件（`20260907000001` 加枚举字段 → `20260907000002` 撤掉重建为数字字段），没有改写已应用的历史迁移。

## 页面/接口清单

| 文件 | 改动 |
|---|---|
| `prisma/schema.prisma` + 迁移 `20260907000001`（分层，已撤）+ `20260907000002`（改成数字，最终生效） | `ProductSaleUom` 加 `sequence Int?` |
| `lib/sale-uom.ts` | 类型定义（`SaleUomItemInput.sequence` / `SaleUomOption.sequence`） |
| `app/api/products/[id]/sale-uoms/route.ts` | GET/PUT 透传 `sequence`（空/非法回落 null） |
| `app/[locale]/classic/operator/products/[id]/page.tsx` | 可售单位表格每行加「装货顺序」数字输入框（跟页头 Product Sequence 同款 `NumericInput`），含基础单位 |
| `lib/print/uom-sequence.ts`（新建，替代已删的 `pack-tier.ts`） | 两套查询：按 productId+uomId 精确取（打印用）；按 productId+uomName 反查（网页拣货单/托盘用，快照里只有单位名字符串） |
| `lib/print/line-sort.ts` | 新增 `sortLinesByUomSequence`：先按装货顺序（没有排最后），同值/都没有再按原有的商品 sequence→商品名排 |
| `lib/print/trip-common.ts` / `dispatch-loader.ts` / `trip-loader.ts` / `trip-picking-template.ts` | 司机/调度拣货打印单据接入排序；同一商品多个单位混装时取数字更大的那个（更保守） |
| `app/api/waves/[id]/pick-sheet/route.ts` / `app/api/waves/[id]/pallets/route.ts` | 网页拣货单、托盘明细按装货顺序排序；待分盘池按餐馆/商品名排序不变（那是"找货"用途，跟装车顺序是两回事） |

## 验证结果

本地起了 dev server，两版设计都各自走了一遍真实浏览器 + 脚本验证；下表是最终数字版的验证结果：

| 验证项 | 方式 | 结果 |
|---|---|---|
| 迁移应用 | `prisma migrate resolve --applied` + `db push`（先应用分层版，再应用数字版撤换） | ✅ 本地库 `ProductSaleUom.sequence` 列已建，类型 Int 可空 |
| 商品编辑页录入 | Playwright 登录 boss 账号，打开一个双单位商品，把 CASE(基础单位) 填 5、PKT 填 50，点保存 | ✅ 界面即时反映；回查数据库两行分别是 `5`/`50`，证明同商品不同单位互不影响 |
| 网页拣货单 `GET /api/waves/[id]/pick-sheet` | 对生产库真实波次(`cmqxt79hs001k...`)发请求 | ✅ 200，正常返回；这批商品大多没配过可售单位，全部按"没有值排最后"兜底，未出错 |
| 托盘明细 `GET /api/waves/[id]/pallets` | 同上 | ✅ 200，正常返回 |
| 按名字反查单位（`resolveUomSequenceByName`） | 脚本混合"已配置 5/50 的真实商品"+"从未配置的商品" | ✅ 排序结果 5 → 50 → null(排最后)，顺序正确 |
| 打印拣货单模板 `generateTripPickingHtml` | 脚本构造 3 行(sequence=5/90/null)模拟数据直接调用 | ✅ 生成的 HTML 里三行顺序是 5 → 90 → null，与预期一致 |
| `npm run build` | 全量构建 | ✅ 无报错 |
| `tsc --noEmit` / `eslint` | 全仓库 | ✅ 无新增类型错误；无新增 lint 错误 |
| 服务器日志 | dev server 全程 | ✅ 无 error/warning |

## 已知不可用 / 未覆盖的部分

- `dispatch-summary-pdf` 等其它打印路由本轮未接入排序（DEV-PLAN 里已注明范围），如果后续发现这些单据也需要按装货顺序排，复用 `lib/print/uom-sequence.ts` 现成的函数即可，不算大改。
- 网页拣货单/托盘按 `productId+uomName`(字符串) 反查顺序，理论上同商品下单位重名会撞车，业务上目前不会发生，按 DEV-PLAN 风险点 3 处理，未改 `Pallet.items` 的数据结构。
- 不做防重复校验是客户明确要的行为（等同 `Product.sequence` 现状），如果大量商品的装货顺序都填成一样的数字，排序会退化成"没排"——这是已知权衡，不是 bug，需要客户自己维护数据质量。
- 测试账号密码已改动：本地开发库种子账号 `boss(at)demo.local` / `test123`，用于本次浏览器验证，非生产环境、非真实客户数据。
