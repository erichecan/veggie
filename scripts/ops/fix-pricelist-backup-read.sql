-- The existing application role needs SELECT for a complete pg_dump, including this archive.
-- No writes, ownership changes, broad grants, or customer records are modified.
\set ON_ERROR_STOP on
BEGIN;
GRANT SELECT ON TABLE public.pricelist_invalid_items_backup_20261008 TO veggie;
SELECT has_table_privilege('veggie', 'public.pricelist_invalid_items_backup_20261008', 'SELECT') AS archive_read_allowed;
COMMIT;
