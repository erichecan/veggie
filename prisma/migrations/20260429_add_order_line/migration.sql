-- Add OrderLine table for Ordered / Delivered / Invoiced quantity tracking
CREATE TABLE "OrderLine" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "productName" TEXT NOT NULL,
  "spec" TEXT,
  "uomId" TEXT,
  "uomName" TEXT,
  "unitPrice" DECIMAL(12,2) NOT NULL,
  "taxRate" DECIMAL(6,4),
  "orderedQty" DECIMAL(14,3) NOT NULL,
  "deliveredQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "invoicedQty" DECIMAL(14,3) NOT NULL DEFAULT 0,
  "subtotal" DECIMAL(12,2) NOT NULL,
  "sequence" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderLine_orderId_idx" ON "OrderLine"("orderId");
CREATE INDEX "OrderLine_productId_idx" ON "OrderLine"("productId");

ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
