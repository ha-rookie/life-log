-- Owner-only Android UAT WebAuthn. Additive; no changes to weight or steps data.
CREATE TABLE IF NOT EXISTS owner_passkey_credentials (
  credential_id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0 CHECK(sign_count >= 0),
  transports TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS owner_passkey_challenges (
  id TEXT PRIMARY KEY,
  challenge_hash TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('register','login')),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_owner_passkey_challenges_expiry ON owner_passkey_challenges(expires_at);
-- Distinguish passkey sessions from temporary password sessions. Existing
-- owner_sessions and password login remain compatible with migration 0002.
CREATE TABLE IF NOT EXISTS owner_passkey_sessions (
  token_hash TEXT PRIMARY KEY REFERENCES owner_sessions(token_hash) ON DELETE CASCADE
);
