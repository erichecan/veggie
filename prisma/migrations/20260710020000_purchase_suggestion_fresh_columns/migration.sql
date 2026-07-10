-- PurchaseSuggestion：生鲜次日备货清单要在前端拆分展示"日均出货/已确认订单/在途采购/单位"，
-- 之前这四个值只在 generate-fresh 的一次性响应体里算出来，没有持久化，GET 列表接口拿不到。
-- 全部可空，不回填历史数据；只有之后新生成的生鲜建议才会写入。
ALTER TABLE "PurchaseSuggestion" ADD COLUMN IF NOT EXISTS "dailyAvgOutbound" DECIMAL(14,3);
ALTER TABLE "PurchaseSuggestion" ADD COLUMN IF NOT EXISTS "futureDemand" DECIMAL(14,3);
ALTER TABLE "PurchaseSuggestion" ADD COLUMN IF NOT EXISTS "inTransitQty" DECIMAL(14,3);
ALTER TABLE "PurchaseSuggestion" ADD COLUMN IF NOT EXISTS "uomName" TEXT;
