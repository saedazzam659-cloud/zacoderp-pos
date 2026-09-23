-- READ ONLY. Run once against development and once against production.
-- For each composite FK, this reports whether its exact ordered target columns
-- are backed by a PRIMARY/UNIQUE constraint in that same catalog.
WITH composite_fks AS (
  SELECT
    c.oid,
    c.conname,
    c.conrelid,
    c.confrelid,
    c.conkey,
    c.confkey,
    pg_get_constraintdef(c.oid) AS definition
  FROM pg_constraint c
  WHERE c.contype = 'f'
    AND array_length(c.conkey, 1) > 1
)
SELECT
  fk.conname,
  fk.conrelid::regclass::text AS source_table,
  array_to_string(array_agg(source_attr.attname ORDER BY paired.ord), ',') AS source_columns,
  fk.confrelid::regclass::text AS target_table,
  array_to_string(array_agg(target_attr.attname ORDER BY paired.ord), ',') AS target_columns,
  EXISTS (
    SELECT 1
    FROM pg_constraint target_key
    WHERE target_key.conrelid = fk.confrelid
      AND target_key.contype IN ('p', 'u')
      AND target_key.conkey = fk.confkey
  ) AS exact_target_key_present,
  fk.definition
FROM composite_fks fk
JOIN LATERAL unnest(fk.conkey, fk.confkey)
  WITH ORDINALITY paired(source_attnum, target_attnum, ord) ON true
JOIN pg_attribute source_attr
  ON source_attr.attrelid = fk.conrelid
 AND source_attr.attnum = paired.source_attnum
JOIN pg_attribute target_attr
  ON target_attr.attrelid = fk.confrelid
 AND target_attr.attnum = paired.target_attnum
GROUP BY
  fk.oid,
  fk.conname,
  fk.conrelid,
  fk.confrelid,
  fk.conkey,
  fk.confkey,
  fk.definition
ORDER BY fk.conname;