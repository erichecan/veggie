\set ON_ERROR_STOP on

BEGIN;

GRANT SELECT ON TABLE
  public.product_dedup_backup_20260905,
  public.product_dedup_dropped_supplier_info_20260905,
  public.product_dedup_dropped_sale_uom_20260905
TO veggie;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND CASE
        WHEN relation.relkind IN ('r', 'p', 'v', 'm', 'f')
          THEN NOT has_table_privilege('veggie', relation.oid, 'SELECT')
        WHEN relation.relkind = 'S'
          THEN NOT has_sequence_privilege('veggie', relation.oid, 'SELECT')
        ELSE false
      END
  ) THEN
    RAISE EXCEPTION 'Backup role still lacks read permissions on public relations';
  END IF;
END
$$;

COMMIT;
