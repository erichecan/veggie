# Order confirmation consistency — phase 1 implementation

Baseline: GitHub `main` at `20cf6e5811cf39bd147062038ae4ad46f909ad54`.

## Contract implemented

- Single-order confirmation, all-or-nothing bulk confirmation, and direct create-as-confirmed use the same transaction-bound confirmation service.
- New confirmation accepts only pending orders. Bulk is explicitly atomic: if any selected order or required side effect fails, the entire batch rolls back. It does not return a partial-success list.
- A selected driver/shift is saved as a real wave and pallet assignment at confirmation. Without a selected slot, the order becomes confirmed and remains unassigned.
- Confirmation creates or reconciles one delivery slip per order and writes the confirmation audit in the same database transaction.
- Confirmation updates order demand through the established inventory synchronization path. It does not deduct on-hand stock; departure remains the physical stock movement point.
- A repeat single-order request is idempotent for the confirmation audit, wave membership, pallet membership, and delivery slip. A previously confirmed order with missing links is reconciled without duplicating its confirmation audit.

## Isolated database verification

Ran `scripts/audit/order-confirmation-phase1.ts` against local PostgreSQL at `127.0.0.1:55439/confirmation_audit`. The database contains synthetic fixtures only. Docker was unavailable; the audit used the already available local PostgreSQL service. No production database was queried or changed.

Verified scenarios:

- Single confirm without a driver and with a preselected driver.
- Repeated single confirmation and reconciliation of a confirmed order with missing associations.
- Failure injection at audit, delivery-slip, wave, and pallet writes; all writes rolled back.
- Three-order batch with a failure in the middle; all orders and linked writes rolled back.
- Batch containing a non-pending order; rejected before writes.
- Direct create-as-confirmed with an injected audit failure; both creation and confirmation rolled back.
- Static wiring check that all three API entry points call the shared service.

The audit script calls the transaction-bound service directly and statically checks route wiring. It is not an HTTP/browser test and does not establish production behavior or every cross-process concurrency ordering.

`npm run typecheck` and `git diff --check` passed in this worktree.

## Scope and outstanding validation

This is an uncommitted, undeployed implementation branch. The previous local-only batch delivery-slip repair was rechecked and incorporated into the shared transaction path. Production data has not been inspected. Before any production work, validate migration/deployment procedure and run read-only diagnostics against production; do not use production as a failure-injection environment.
