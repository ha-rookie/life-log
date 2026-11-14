-- Issue #211: additive v3 per-destination audit only; never touch existing user tables or rows.
-- No backfill, UPDATE, DELETE, DROP, ALTER, REPLACE, or data-dependent SELECT.
CREATE TABLE IF NOT EXISTS import_job_target_manifest (
  import_job_id TEXT PRIMARY KEY REFERENCES import_jobs(id),
  expected_source_rows INTEGER NOT NULL CHECK(expected_source_rows BETWEEN 1 AND 100),
  expected_target_rows INTEGER NOT NULL CHECK(
    expected_target_rows >= expected_source_rows AND
    expected_target_rows <= expected_source_rows * 2
  ),
  contract_version TEXT NOT NULL CHECK(contract_version='v3')
);
CREATE TABLE IF NOT EXISTS import_target_audit (
  id TEXT PRIMARY KEY,
  import_job_id TEXT NOT NULL REFERENCES import_jobs(id),
  source_row_number INTEGER NOT NULL CHECK(source_row_number >= 2),
  target_type TEXT NOT NULL CHECK(target_type IN ('lifestyle','weight_day')),
  result TEXT NOT NULL CHECK(result IN ('inserted','skipped','conflict')),
  error_code TEXT,
  UNIQUE(import_job_id,source_row_number,target_type)
);
CREATE INDEX IF NOT EXISTS idx_import_target_audit_job_row
  ON import_target_audit(import_job_id,source_row_number);
