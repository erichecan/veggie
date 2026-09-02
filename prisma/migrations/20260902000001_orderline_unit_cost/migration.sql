-- OrderLine 成本快照（20260902）
--
-- 下单/改价保存那一刻，把 Product.standardPrice（收货时按加权平均从采购单回写，
-- 见 lib/purchase/receive-purchase-order.ts）乘以该行可售单位的换算系数，落库成
-- unitCost。此后订单/报价单详情页与"历史成交价"弹窗显示的成本，都是这个字段，
-- 不再是打开页面那一刻用商品"今天"的成本现算。
--
-- 只对本次上线之后新建/改价的行生效，历史行没有这个字段——标准做法（对齐
-- priceSourceType 当年上线时的处理）：不臆造历史成本，页面按 "—" 展示，不回填。
ALTER TABLE "OrderLine" ADD COLUMN "unitCost" DECIMAL(12,4);
