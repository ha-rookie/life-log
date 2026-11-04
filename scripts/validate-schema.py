"""Offline synthetic assertions for SQLite-compatible local D1 migration.
Never uses Wrangler --remote or accesses a Cloudflare account.
"""
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[1]
conn = sqlite3.connect(":memory:")
conn.execute("PRAGMA foreign_keys=ON")
conn.executescript((ROOT / "migrations/0001_initial.sql").read_text(encoding="utf-8"))
fixture = (ROOT / "tests/fixtures/synthetic.sql").read_text(encoding="utf-8")
conn.executescript(fixture)
conn.executescript(fixture)  # retry must not double-count rows
assert conn.execute("SELECT count(*) FROM body_measurements").fetchone()[0] == 2, "cross-file fingerprint dedup"
assert conn.execute("SELECT count(*) FROM import_jobs").fetchone()[0] == 1, "file retry dedup"
assert conn.execute("SELECT count(*) FROM lifestyle_days").fetchone()[0] == 3
assert conn.execute("SELECT count(*) FROM activity_daily").fetchone()[0] == 1
assert conn.execute("SELECT count(*) FROM body_measurements WHERE measured_at LIKE '2026-01-02%'").fetchone()[0] == 2, "retain distinct same-day observations"
state = conn.execute("SELECT drinking_presence,drink_cups,steps FROM lifestyle_days WHERE local_day='2026-01-02'").fetchone()
assert state == (1,None,None), f"past drinking presence must not imply cups: {state!r}"
assert conn.execute("SELECT drinking_presence,drink_cups,steps FROM lifestyle_days WHERE local_day='2026-01-03'").fetchone() == (0,0,0)
assert conn.execute("SELECT drinking_presence,drink_cups,steps FROM lifestyle_days WHERE local_day='2026-01-04'").fetchone() == (None,None,None)
assert conn.execute("SELECT steps FROM activity_daily WHERE local_day='2026-01-03'").fetchone() == (0,)

def rejects(sql, params=()):
    try:
        conn.execute(sql, params)
    except sqlite3.IntegrityError:
        return
    raise AssertionError("Expected constraint violation")

rejects("INSERT INTO lifestyle_days(owner_id,local_day,source_id,source_row_key,drinking_presence,drink_cups) VALUES ('owner','2026-01-06','test','bad',1,0)")
rejects("INSERT INTO lifestyle_days(owner_id,local_day,source_id,source_row_key,drinking_presence,drink_cups) VALUES ('owner','2026-01-07','test','bad2',NULL,0)")
rejects("INSERT INTO body_measurements(id,owner_id,measured_at,source_id,source_row_key,source_kind,reliable_fingerprint) VALUES ('dup','owner','2026-01-02T07:00:00+09:00','eclear','line-1','measured','x')")
rejects("INSERT INTO body_measurements(id,owner_id,measured_at,source_id,source_row_key,source_kind,reliable_fingerprint) VALUES ('dup2','owner','2026-01-02T07:00:00+09:00','other','line-99','measured','fingerprint-1')")
rejects("INSERT INTO body_measurements(id,owner_id,measured_at,source_id,source_row_key,source_kind) VALUES ('outside','other','2026-01-01','x','x','measured')")
assert len(conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()) == 11
print("PASS synthetic SQLite schema: 11 tables, idempotence, cross-source dedup, missing-vs-zero, foreign keys")
