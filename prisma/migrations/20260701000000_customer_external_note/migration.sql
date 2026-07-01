-- Add customer-level external note (printed on quotations/delivery notes; distinct from internal notes)
ALTER TABLE "Customer" ADD COLUMN "externalNote" TEXT;
