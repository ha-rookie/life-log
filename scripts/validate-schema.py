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
# Auth migrations remain additive and preserve the preexisting personal records.
conn.executescript((ROOT / "migrations/0002_owner_auth.sql").read_text(encoding="utf-8"))
conn.executescript((ROOT / "migrations/0003_owner_passkey.sql").read_text(encoding="utf-8"))
# Regression: a legacy 1-cup drink must survive the additive migration exactly.
conn.execute("""INSERT INTO drink_entries
  (id,owner_id,observed_at,drink_kind,alcohol,cups,source_id,source_row_key)
  VALUES('old-highball','owner','2026-01-02T19:00:00+09:00','highball',1,1,'manual:drink','legacy')""")
conn.executescript((ROOT / "migrations/0004_drink_details.sql").read_text(encoding="utf-8"))
old_drink=conn.execute("""SELECT drink_kind,cups,volume_ml,abv_pct,drink_variant,size_label
  FROM drink_entries WHERE id='old-highball'""").fetchone()
assert old_drink == ("highball",1,None,None,None,None), old_drink
cols={row[1] for row in conn.execute("PRAGMA table_info(drink_entries)")}
assert {"drink_variant","size_label","volume_ml","abv_pct","cups"} <= cols
assert conn.execute("SELECT count(*) FROM drink_entries").fetchone()[0] == 1
rejects("INSERT INTO drink_entries(id,owner_id,observed_at,drink_kind,alcohol,cups,source_id,source_row_key,drink_variant) VALUES ('bad-beer','owner','2026-01-02T07:00:00+09:00','other_alcohol',1,1,'manual:drink','bad','wine')")
rejects("INSERT INTO drink_entries(id,owner_id,observed_at,drink_kind,alcohol,cups,source_id,source_row_key,size_label) VALUES ('bad-size','owner','2026-01-02T07:00:00+09:00','highball',1,1,'manual:drink','bad-size','impossible')")
assert conn.execute("SELECT count(*) FROM body_measurements").fetchone()[0] == 2
assert conn.execute("SELECT count(*) FROM activity_daily").fetchone()[0] == 1
tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
assert len(tables) == 16, tables
assert {"owner_credentials", "owner_sessions", "owner_passkey_credentials",
        "owner_passkey_challenges", "owner_passkey_sessions"} <= tables
conn.execute("INSERT INTO owner_sessions(token_hash,owner_id,expires_at,created_at) VALUES('passkey','owner',9999999999,0)")
conn.execute("INSERT INTO owner_passkey_sessions(token_hash) VALUES('passkey')")
conn.execute("INSERT INTO owner_sessions(token_hash,owner_id,expires_at,created_at) VALUES('password','owner',9999999999,0)")
conn.execute("DELETE FROM owner_sessions WHERE token_hash NOT IN (SELECT token_hash FROM owner_passkey_sessions)")
assert conn.execute("SELECT token_hash FROM owner_sessions").fetchall() == [('passkey',)]
print("PASS synthetic SQLite schema: 16 tables, Owner passkey auth and session retirement, legacy records preserved")

