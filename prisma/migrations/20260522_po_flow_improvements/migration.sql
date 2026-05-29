-- P1-1: Add LOCKED status to PurchaseOrderStatus enum
ALTER TYPE "PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'LOCKED';

-- P2-2: Add TO_APPROVE status to PurchaseOrderStatus enum
ALTER TYPE "PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'TO_APPROVE';

-- P2-1: Add editApprovalRequired flag to PurchaseOrder
ALTER TABLE "PurchaseOrder" ADD COLUMN "editApprovalRequired" BOOLEAN NOT NULL DEFAULT false;

-- P1-1: Add lockedAt timestamp
ALTER TABLE "PurchaseOrder" ADD COLUMN "lockedAt" TIMESTAMP(3);
