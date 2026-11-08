-- Additive drink details. Existing rows retain NULL variant/size and their original
-- cup count, volume and ABV; there is no backfill or assumed serving size.
-- `beer` is stored as existing `other_alcohol` + variant to preserve drink_kind CHECK.
ALTER TABLE drink_entries ADD COLUMN drink_variant TEXT
  CHECK(drink_variant IS NULL OR drink_variant='beer');
ALTER TABLE drink_entries ADD COLUMN size_label TEXT
  CHECK(size_label IS NULL OR size_label IN ('regular','large','mega','custom'));
