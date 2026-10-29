-- 客户门户可见性开关（20261028，客户需求「屏蔽有些产品不能出现在顾客 portal 里，也不能下单」）
-- false = 客户门户（含匿名 /shop 目录）里不出现、门户下单被拒；内部下单 / 报价单不受影响。
-- 默认 true：上线时所有现有商品保持可见，不会有任何商品突然从门户消失。
ALTER TABLE "Product" ADD COLUMN "showInPortal" BOOLEAN NOT NULL DEFAULT true;
