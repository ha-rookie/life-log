-- Synthetic-only data: no person/email/actual health records.
INSERT OR IGNORE INTO owners(id, created_at) VALUES ('owner', '2026-01-01T00:00:00+09:00');
INSERT OR IGNORE INTO import_jobs(id, owner_id, source_type, source_id, file_sha256, status, started_at)
 VALUES ('demo-import','owner','eclear','synthetic-csv','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','confirmed','2026-01-01T10:00:00+09:00');
INSERT OR IGNORE INTO body_measurements(id, owner_id, measured_at, weight_kg, source_id, source_row_key, reliable_fingerprint, source_kind, import_job_id)
 VALUES ('w1','owner','2026-01-02T07:00:00+09:00',72.2,'eclear','line-1','fingerprint-1','measured','demo-import');
INSERT OR IGNORE INTO body_measurements(id, owner_id, measured_at, weight_kg, source_id, source_row_key, reliable_fingerprint, source_kind, import_job_id)
 VALUES ('w2','owner','2026-01-02T20:00:00+09:00',72.6,'eclear','line-2','fingerprint-2','measured','demo-import');
INSERT OR IGNORE INTO body_measurements(id, owner_id, measured_at, weight_kg, source_id, source_row_key, reliable_fingerprint, source_kind)
 VALUES ('duplicate-from-other-source','owner','2026-01-02T07:00:00+09:00',72.2,'legacy-txt','line-99','fingerprint-1','measured');
INSERT OR IGNORE INTO lifestyle_days(owner_id, local_day, drinking_presence, drink_cups, steps, source_id, source_row_key)
 VALUES ('owner','2026-01-02',1,NULL,NULL,'synthetic-lifestyle','l1');
INSERT OR IGNORE INTO lifestyle_days(owner_id, local_day, drinking_presence, drink_cups, steps, source_id, source_row_key)
 VALUES ('owner','2026-01-03',0,0,0,'synthetic-lifestyle','l2');
INSERT OR IGNORE INTO lifestyle_days(owner_id, local_day, drinking_presence, drink_cups, steps, source_id, source_row_key)
 VALUES ('owner','2026-01-04',NULL,NULL,NULL,'synthetic-lifestyle','l3');
INSERT OR IGNORE INTO activity_daily(id, owner_id, local_day, steps, source_id, source_row_key)
 VALUES ('steps1','owner','2026-01-03',0,'fit-synthetic','d1');
