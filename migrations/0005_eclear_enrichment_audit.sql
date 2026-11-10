-- ECLEAR v2 enrichment only; additive, existing import_jobs/import_row_audit untouched.
-- Apply to synthetic Wrangler LOCAL D1 only. Remote D1 migration is NOT approved.
CREATE TABLE IF NOT EXISTS eclear_enrichment_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  contract_version TEXT NOT NULL CHECK(contract_version = 'eclear-enrichment-v2'),
  file_sha256 TEXT NOT NULL CHECK(length(file_sha256)=64),
  snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64),
  inserted_measurements INTEGER NOT NULL CHECK(inserted_measurements>=0),
  enriched_measurements INTEGER NOT NULL CHECK(enriched_measurements>=0),
  enriched_cells INTEGER NOT NULL CHECK(enriched_cells>=0),
  created_at TEXT NOT NULL,
  UNIQUE(owner_id,contract_version,file_sha256,snapshot_sha256)
);
CREATE INDEX IF NOT EXISTS idx_eclear_jobs_owner_time
  ON eclear_enrichment_jobs(owner_id,created_at DESC);

CREATE TABLE IF NOT EXISTS eclear_enrichment_row_audit (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES eclear_enrichment_jobs(id),
  source_row_number INTEGER NOT NULL CHECK(source_row_number>=2),
  measurement_id TEXT NOT NULL REFERENCES body_measurements(id),
  result TEXT NOT NULL CHECK(result IN ('inserted','enriched')),
  changed_cells INTEGER NOT NULL CHECK(changed_cells>0 AND changed_cells<=7),
  UNIQUE(job_id,source_row_number)
);

CREATE TABLE IF NOT EXISTS eclear_enrichment_cell_audit (
  owner_id TEXT NOT NULL REFERENCES owners(id),
  measurement_id TEXT NOT NULL REFERENCES body_measurements(id),
  field_name TEXT NOT NULL CHECK(field_name IN (
    'weight_kg','body_fat_pct','skeletal_muscle_pct','bmi',
    'visceral_fat_level','bone_mass_kg','basal_metabolism_kcal'
  )),
  job_id TEXT NOT NULL REFERENCES eclear_enrichment_jobs(id),
  old_value REAL CHECK(old_value IS NULL),
  new_value REAL NOT NULL,
  PRIMARY KEY(owner_id,measurement_id,field_name)
);
CREATE INDEX IF NOT EXISTS idx_eclear_cells_job
  ON eclear_enrichment_cell_audit(job_id);

-- Temporary constraint assertions inside a single transactional D1.batch.
-- All rows are deleted by the final statement, which must be in that batch.
-- A stale row/snapshot generates CHECK failure and rolls back ALL statements.
CREATE TABLE IF NOT EXISTS eclear_enrichment_asserts (
  passed INTEGER NOT NULL CHECK(passed = 1)
);
