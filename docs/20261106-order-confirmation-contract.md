# Order Confirmation Contract — Phase 1

Baseline: GitHub `main` at `20cf6e5811cf39bd147062038ae4ad46f909ad54`.

## Business contract

- Only a `PENDING` quotation can be newly confirmed. A repeated single-order request is idempotent and must not add another confirmation audit or duplicate linked records.
- Confirmation sets `status` and `confirmationDate`.
- A selected driver slot is an intent before confirmation. Confirmation must create or join the real date/driver/shift wave, place the order in the selected batch pallet, and advance the order to `WAVE_ASSIGNED`. Without a driver slot, the confirmed order remains unassigned in `CONFIRMED`.
- Inventory demand is derived from the confirmed order and its order lines. Confirmation does not reduce on-hand stock; physical stock moves when the wave departs.
- Exactly one delivery slip per order is required. A failure to create or synchronize it fails confirmation.
- The order audit event is part of the confirmation transaction. Notifications and general action logs remain post-commit side effects and cannot report a failed confirmation as successful.

## Batch semantics

Bulk confirmation is all-or-nothing, following the multi-record action-confirm contract: every selected order must exist and be `PENDING`; any invalid order, locked wave, invalid driver assignment, stock reconciliation failure, audit failure, or delivery-slip failure rolls the full batch back. The response identifies the blocking condition; it never reports a partially confirmed batch.

## Shared implementation

The single-order, bulk, and create-as-confirmed API paths call `confirmOrdersInTransaction`. Direct creation writes the order, lines, creation audit, and confirmation effects inside the same transaction. Batch confirmation invokes the same service for the full selected set in one transaction.

## Remaining validation

Test the three entrances against isolated PostgreSQL with synthetic data, including injected failures for wave/pallet writes, audit writes, and delivery-slip writes, plus repeats and concurrent confirmation. Production data is outside the scope of this implementation phase and must only be queried read-only after isolated validation.
