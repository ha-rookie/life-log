-- Owner password credentials and revocable sessions. No plaintext secrets.
CREATE TABLE IF NOT EXISTS owner_credentials (
  owner_id TEXT PRIMARY KEY REFERENCES owners(id),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  iterations INTEGER NOT NULL CHECK(iterations >= 100000),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_sessions_expiry ON owner_sessions(expires_at);
