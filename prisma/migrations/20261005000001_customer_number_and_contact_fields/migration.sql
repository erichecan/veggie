ALTER TABLE "Customer" ADD COLUMN "customerNo" SERIAL NOT NULL;
CREATE UNIQUE INDEX "Customer_customerNo_key" ON "Customer"("customerNo");
ALTER TABLE "Customer" ADD COLUMN "individualOrCompany" TEXT NOT NULL DEFAULT 'company';
ALTER TABLE "Customer" ADD COLUMN "mobile" TEXT NOT NULL DEFAULT '';
