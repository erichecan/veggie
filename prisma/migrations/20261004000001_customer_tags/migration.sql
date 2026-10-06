-- AlterTable
-- 自由标签（Odoo res.partner.category 的简化版），逗号分隔文本框录入
ALTER TABLE "Customer" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
