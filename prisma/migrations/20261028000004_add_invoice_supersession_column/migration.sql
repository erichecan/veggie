-- 退换货补全 M8：发票换开新发票（Invoice supersede）
-- 新票通过 supersedesInvoiceId 指回被取代的旧票；@unique 保证一张旧票只会被换开一次。
ALTER TABLE "Invoice" ADD COLUMN "supersedesInvoiceId" TEXT;
CREATE UNIQUE INDEX "Invoice_supersedesInvoiceId_key" ON "Invoice"("supersedesInvoiceId");
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_supersedesInvoiceId_fkey"
  FOREIGN KEY ("supersedesInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
