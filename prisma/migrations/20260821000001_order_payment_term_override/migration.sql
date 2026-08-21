-- 订单级付款条件覆盖（20260821）
--
-- 背景：Quotation/Sales Order 详情页的 "Payment Terms" 此前只读展示
-- customer.paymentTerm（客户默认设置），Order 上根本没有存储位——客户要求
-- "有的订单可能是 monthly 的，某天的订单需要 cod" 这种按单覆盖，之前无从改起。
--
-- 新增可空列，NULL = 沿用 Customer.paymentTerm 默认值，不影响任何历史订单的展示。
ALTER TABLE "Order" ADD COLUMN "paymentTerm" TEXT;
