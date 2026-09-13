PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS serial_bindings (
  serial_hash TEXT PRIMARY KEY,
  serial_value TEXT NOT NULL,
  owner_user_id INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  created_by INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  telegram_user_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_joins (
  telegram_user_id INTEGER PRIMARY KEY,
  user_chat_id INTEGER NOT NULL,
  requested_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_bindings (
  telegram_user_id INTEGER PRIMARY KEY,
  workflow_key TEXT NOT NULL,
  bound_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL,
  serial_hash TEXT NOT NULL,
  workflow_file TEXT NOT NULL,
  inputs TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS build_jobs (
  request_id TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL,
  active_user_id INTEGER UNIQUE,
  chat_id INTEGER NOT NULL,
  workflow_file TEXT NOT NULL,
  inputs TEXT NOT NULL,
  github_run_id INTEGER,
  status TEXT NOT NULL,
  succeeded_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_build_jobs_status ON build_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_build_jobs_quota ON build_jobs(telegram_user_id, created_at, succeeded_at);

CREATE TABLE IF NOT EXISTS quota_resets (
  telegram_user_id INTEGER PRIMARY KEY,
  reset_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
