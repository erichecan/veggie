-- 退换货补全 M8：发票换开新发票（Invoice supersede）
-- ⚠️ ALTER TYPE ... ADD VALUE 不能跟其他语句放在同一事务块里一起跑，
-- 这个文件只放这一句，字段改动放进下一个迁移文件。
ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'SUPERSEDED';
