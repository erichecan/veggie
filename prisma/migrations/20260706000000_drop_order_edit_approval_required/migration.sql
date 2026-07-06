-- Drop Order.editApprovalRequired now that the P1-6 "CONFIRMED 后编辑需老板审批" flow
-- has been removed end-to-end: the front-end approve/reject buttons on the sales-order
-- edit page, the PUT /api/orders/[id] auto-flagging logic, and the now-unreachable
-- PUT /api/orders/[id]/approve-edit route were all deleted first. This column had no
-- remaining reader or writer in the codebase.

ALTER TABLE "Order" DROP COLUMN IF EXISTS "editApprovalRequired";
