-- 分面搜索走的是 ILIKE '%关键词%'（lib/facet-sql.ts / lib/orders-query.ts 的 contains +
-- mode:'insensitive'），前后都有通配符，B-tree 索引完全用不上，只能全表扫描。
-- pg_trgm 的 GIN 索引专治这种子串匹配。
--
-- 生产库实测（EXPLAIN ANALYZE，2026-08-02）：
--   OrderLine.productName ~[BSB]   1.33M 行   2587.8 ms → 265.8 ms   (~10x)
--   Order.restaurantName  ~Fuji     149K 行    502.4 ms →   8.7 ms   (~58x)
--   Order.code            ~D088389  149K 行    715.9 ms →   0.15 ms  (~4800x)
--   ProductTemplate.name  ~salt     5.5K 行     30.2 ms →   0.14 ms  (~210x)
--
-- Customer.name 未建索引：1605 行、0.5 ms，本就够快，不值得付 GIN 的写入开销。
--
-- 注意：生产库上这四个索引是用 CREATE INDEX CONCURRENTLY 手工建的（1.33M 行的那个
-- 耗时 19s，非并发建会锁住 OrderLine 写入即阻塞下单），随后用 prisma migrate resolve
-- --applied 标记本迁移已应用。这里写非并发版本是给全新环境用的（空表无锁表风险，
-- 且 CREATE INDEX CONCURRENTLY 不能在 Prisma 迁移的事务里执行）。

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_orderline_productname_trgm
  ON "OrderLine" USING gin ("productName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_order_restaurantname_trgm
  ON "Order" USING gin ("restaurantName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_order_code_trgm
  ON "Order" USING gin (code gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_producttemplate_name_trgm
  ON "ProductTemplate" USING gin (name gin_trgm_ops);
