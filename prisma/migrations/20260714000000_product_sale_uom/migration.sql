-- CreateTable
CREATE TABLE "ProductSaleUom" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "uomId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "priceOverride" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductSaleUom_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductSaleUom_productId_idx" ON "ProductSaleUom"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSaleUom_productId_uomId_key" ON "ProductSaleUom"("productId", "uomId");

-- AddForeignKey
ALTER TABLE "ProductSaleUom" ADD CONSTRAINT "ProductSaleUom_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductSaleUom" ADD CONSTRAINT "ProductSaleUom_uomId_fkey" FOREIGN KEY ("uomId") REFERENCES "Uom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
