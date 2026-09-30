-- AlterTable
-- 新增用户友好的自增编号，纯内部展示/搜索用。cuid `id` 仍是唯一主键和所有外键目标，不受影响。
-- SERIAL 会为已有行按插入顺序自动回填连续编号，新行继续自增，无需额外 UPDATE。
ALTER TABLE "Product" ADD COLUMN "productNo" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Product_productNo_key" ON "Product"("productNo");
