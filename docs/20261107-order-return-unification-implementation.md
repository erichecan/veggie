# Shared order return records — implementation and isolated verification

Baseline: GitHub `main` at `20cf6e5811cf39bd147062038ae4ad46f909ad54`.

## Implemented behavior

- Driver reports and manual Return Registration now create the same `OrderReturn` record and both link to the exact originating `OrderLine`.
- Driver-created records additionally retain their source trip, photo, late-report note, source, and the order-line unit price snapshot.
- Active returns reserve quantity. New reports lock the source order, validate that the line belongs to it, and reject quantities above the remaining delivered quantity. If no delivered quantity has yet been recorded, only a driver report tied to its trip may use ordered quantity as a temporary ceiling; manual registration cannot assume delivery.
- Rejected returns release the reservation. Review, warehouse verification, inventory movement, return-based credit-note generation, and trip projections read/write the canonical record. Existing `Trip` JSON returns remain readable for historical records; new reports do not write there.
- New schema fields and relations are in `prisma/schema.prisma` and the associated migration.

## Isolated database verification

Ran `scripts/audit/order-return-unification.ts` against local PostgreSQL at `127.0.0.1:55439/confirmation_audit`, using synthetic user, product, order, order line, and trip records. Docker was unavailable; a local PostgreSQL service was used. No production database was queried or changed.

The audit passed checks that:

- Manual and driver submissions create records in the same table.
- Both submissions link to the exact original order line.
- Driver source trip, photo, late-report data, and line-price snapshot persist.
- Active quantities across manual and driver reports cannot exceed delivered quantity.
- Rejection releases reserved quantity.
- Both API handlers call the shared writer.

`npm run typecheck` and `git diff --check` passed in this worktree. The audit exercises the shared write path with PostgreSQL and checks handler wiring; it does not cover browser flows or production historical-data quality.

## Scope

This is an uncommitted, undeployed implementation branch. Historical `Trip` JSON remains a read-compatibility source; this change does not migrate old JSON entries into `OrderReturn`. No production data was changed.
