"""Synthetic-only local SQLite transaction and import-key regression.
No Cloudflare or remote D1 connections. Run after base schema test.
"""
import sqlite3
from pathlib import Path

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
db.executescript((Path(__file__).resolve().parents[1] / "migrations" / "0001_initial.sql").read_text())
with db:
    db.execute("INSERT INTO owners(id,created_at) VALUES('owner','2026-01-01')")
    db.execute("INSERT INTO import_jobs(id,owner_id,source_type,source_id,file_sha256,status,started_at) VALUES(?,?,?,?,?,?,?)", ("j1","owner","lifestyle","lifestyle","a"*64,"confirmed","2026-01-01"))
    db.execute("INSERT INTO lifestyle_days(owner_id,local_day,drinking_presence,drink_cups,steps,source_id,source_row_key,import_job_id) VALUES (?,?,?,?,?,?,?,?)", ("owner","2026-01-02",1,None,None,"lifestyle","2026-01-02","j1"))
    db.execute("INSERT INTO body_measurements(id,owner_id,measured_at,weight_kg,source_id,source_row_key,source_kind,import_job_id) VALUES (?,?,?,?,?,?,?,?)", ("m1","owner","2026-01-02",72.4,"lifestyle","2026-01-02","reported","j1"))
    db.execute("INSERT INTO import_row_audit(id,import_job_id,source_row_number,source_row_key,result) VALUES('a1','j1',2,'2026-01-02','inserted')")
base_counts = tuple(db.execute("SELECT count(*) FROM " + t).fetchone()[0] for t in ("import_jobs","lifestyle_days","body_measurements","import_row_audit"))
assert base_counts == (1,1,1,1)
assert db.execute("SELECT drink_cups,steps FROM lifestyle_days").fetchone() == (None,None)
try:
    with db:
        db.execute("INSERT INTO import_jobs(id,owner_id,source_type,source_id,file_sha256,status,started_at) VALUES(?,?,?,?,?,?,?)", ("j2","owner","lifestyle","lifestyle","b"*64,"confirmed","2026-01-03"))
        db.execute("INSERT INTO lifestyle_days(owner_id,local_day,drinking_presence,drink_cups,steps,source_id,source_row_key,import_job_id) VALUES (?,?,?,?,?,?,?,?)", ("owner","2026-01-04",0,0,0,"lifestyle","2026-01-04","j2"))
        # Collision after earlier statements must roll back the entire transaction.
        db.execute("INSERT INTO lifestyle_days(owner_id,local_day,drinking_presence,drink_cups,steps,source_id,source_row_key,import_job_id) VALUES (?,?,?,?,?,?,?,?)", ("owner","2026-01-02",1,None,None,"lifestyle","2026-01-02","j2"))
    raise AssertionError("expected transaction failure")
except sqlite3.IntegrityError:
    pass
assert tuple(db.execute("SELECT count(*) FROM " + t).fetchone()[0] for t in ("import_jobs","lifestyle_days","body_measurements","import_row_audit")) == base_counts

with db:
    db.execute("INSERT INTO import_jobs(id,owner_id,source_type,source_id,file_sha256,status,started_at) VALUES(?,?,?,?,?,?,?)", ("j3","owner","eclear","eclear","c"*64,"confirmed","2026-01-04"))
    for i,tm in enumerate(("08:00:00","20:00:00")):
        measured_at="2026-01-02T"+tm+"+09:00"
        db.execute("INSERT INTO body_measurements(id,owner_id,measured_at,weight_kg,source_id,source_row_key,reliable_fingerprint,source_kind,import_job_id) VALUES(?,?,?,?,?,?,?,?,?)", (f"ec{i}","owner",measured_at,71.8+i,"eclear",measured_at,"eclear:"+measured_at,"measured","j3"))
assert db.execute("SELECT count(*) FROM body_measurements").fetchone()[0] == 3, "same-day distinct timestamp preserved"
try:
    with db:
        db.execute("INSERT INTO body_measurements(id,owner_id,measured_at,weight_kg,source_id,source_row_key,reliable_fingerprint,source_kind) VALUES(?,?,?,?,?,?,?,?)", ("dupec","owner","2026-01-02T08:00:00+09:00",71.8,"eclear","2026-01-02T08:00:00+09:00","eclear:2026-01-02T08:00:00+09:00","measured"))
    raise AssertionError("overlap must be blocked")
except sqlite3.IntegrityError:
    pass
assert db.execute("SELECT count(*) FROM body_measurements").fetchone()[0] == 3
print("PASS synthetic import SQL: null vs zero, source keys, cross-file timestamp dedup, transaction rollback")
