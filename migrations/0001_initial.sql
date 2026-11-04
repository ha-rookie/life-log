-- Life-log initial schema. Execute only with wrangler --local in this issue.
-- All timestamps are text; source_timezone stores the provenance and dates use Asia/Tokyo.
-- Do not put actual personal data in migrations or fixtures.
CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  file_sha256 TEXT NOT NULL CHECK(length(file_sha256) = 64),
  status TEXT NOT NULL CHECK(status IN ('preview','confirmed','partial','failed','reverted')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(owner_id, source_type, file_sha256)
);
CREATE TABLE IF NOT EXISTS body_measurements (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  measured_at TEXT NOT NULL,
  source_timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  weight_kg REAL CHECK(weight_kg IS NULL OR (weight_kg > 0 AND weight_kg < 500)),
  body_fat_pct REAL CHECK(body_fat_pct IS NULL OR (body_fat_pct >= 0 AND body_fat_pct <= 100)),
  skeletal_muscle_pct REAL CHECK(skeletal_muscle_pct IS NULL OR (skeletal_muscle_pct >= 0 AND skeletal_muscle_pct <= 100)),
  bmi REAL,
  visceral_fat_level REAL,
  bone_mass_kg REAL,
  basal_metabolism_kcal REAL,
  source_id TEXT NOT NULL,
  source_row_key TEXT NOT NULL,
  reliable_fingerprint TEXT,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('measured','reported','estimated')),
  anomaly_flag INTEGER NOT NULL DEFAULT 0 CHECK(anomaly_flag IN (0,1)),
  import_job_id TEXT REFERENCES import_jobs(id),
  UNIQUE(owner_id, source_id, source_row_key),
  UNIQUE(owner_id, reliable_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_body_owner_time ON body_measurements(owner_id, measured_at DESC);
CREATE TABLE IF NOT EXISTS lifestyle_days (
  owner_id TEXT NOT NULL REFERENCES owners(id),
  local_day TEXT NOT NULL CHECK(length(local_day)=10),
  drinking_presence INTEGER CHECK(drinking_presence IN (0,1)),
  drink_cups INTEGER CHECK(drink_cups IS NULL OR drink_cups >= 0),
  lunch_kind TEXT CHECK(lunch_kind IS NULL OR lunch_kind IN ('home','restaurant','takeout')),
  dinner_kind TEXT CHECK(dinner_kind IS NULL OR dinner_kind IN ('home','restaurant','takeout')),
  late_meal INTEGER CHECK(late_meal IS NULL OR late_meal IN (0,1)),
  steps INTEGER CHECK(steps IS NULL OR steps >= 0),
  source_id TEXT NOT NULL,
  source_row_key TEXT NOT NULL,
  import_job_id TEXT REFERENCES import_jobs(id),
  PRIMARY KEY(owner_id, local_day, source_id),
  UNIQUE(owner_id, source_id, source_row_key),
  CHECK(
    (drinking_presence IS NULL AND drink_cups IS NULL)
    OR (drinking_presence = 0 AND drink_cups = 0)
    OR (drinking_presence = 1 AND (drink_cups IS NULL OR drink_cups > 0))
  )
);
CREATE TABLE IF NOT EXISTS activity_daily (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  local_day TEXT NOT NULL CHECK(length(local_day)=10),
  steps INTEGER CHECK(steps IS NULL OR steps >= 0),
  distance_m REAL CHECK(distance_m IS NULL OR distance_m >= 0),
  source_id TEXT NOT NULL,
  source_row_key TEXT NOT NULL,
  import_job_id TEXT REFERENCES import_jobs(id),
  UNIQUE(owner_id, source_id, source_row_key)
);
CREATE INDEX IF NOT EXISTS idx_activity_owner_day ON activity_daily(owner_id, local_day);
CREATE TABLE IF NOT EXISTS outings (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  local_day TEXT NOT NULL CHECK(length(local_day)=10),
  category TEXT NOT NULL CHECK(category IN ('work','bar','other')),
  enjoyment INTEGER CHECK(enjoyment IS NULL OR enjoyment BETWEEN 1 AND 5),
  source_id TEXT NOT NULL,
  source_row_key TEXT NOT NULL,
  UNIQUE(owner_id, source_id, source_row_key)
);
CREATE TABLE IF NOT EXISTS drink_entries (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  outing_id TEXT REFERENCES outings(id),
  observed_at TEXT NOT NULL,
  drink_kind TEXT NOT NULL CHECK(drink_kind IN ('highball','green_tea_high','other_alcohol','non_alcohol')),
  alcohol INTEGER NOT NULL CHECK(alcohol IN (0,1)),
  cups INTEGER NOT NULL CHECK(cups > 0),
  volume_ml REAL CHECK(volume_ml IS NULL OR volume_ml > 0),
  abv_pct REAL CHECK(abv_pct IS NULL OR abv_pct BETWEEN 0 AND 100),
  source_id TEXT NOT NULL,
  source_row_key TEXT NOT NULL,
  UNIQUE(owner_id, source_id, source_row_key)
);
CREATE TABLE IF NOT EXISTS import_row_audit (
  id TEXT PRIMARY KEY,
  import_job_id TEXT NOT NULL REFERENCES import_jobs(id),
  source_row_number INTEGER NOT NULL CHECK(source_row_number > 0),
  source_row_key TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('inserted','skipped','conflict','invalid')),
  error_code TEXT,
  UNIQUE(import_job_id, source_row_number)
);
CREATE TABLE IF NOT EXISTS analysis_periods (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  method_version TEXT NOT NULL,
  coverage REAL CHECK(coverage IS NULL OR coverage BETWEEN 0 AND 1),
  summary_json TEXT,
  CHECK(starts_on <= ends_on)
);
CREATE TABLE IF NOT EXISTS behavior_hypotheses (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  statement TEXT NOT NULL,
  support_text TEXT,
  counterevidence_text TEXT,
  unknown_text TEXT,
  status TEXT NOT NULL CHECK(status IN ('draft','active','closed')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS behavior_experiments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  hypothesis_id TEXT NOT NULL REFERENCES behavior_hypotheses(id),
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  target_action TEXT NOT NULL,
  baseline_text TEXT,
  outcome_text TEXT,
  user_decision TEXT CHECK(user_decision IS NULL OR user_decision IN ('continue','revise','stop','unknown')),
  CHECK(starts_on <= ends_on)
);
