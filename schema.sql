-- Already applied to the bluprint-golf D1 database. Kept here for reference or a fresh setup.
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, created TEXT NOT NULL, pw TEXT);
CREATE TABLE IF NOT EXISTS login_attempts(email TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_codes(email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent_count INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS docs(path TEXT PRIMARY KEY, parent TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, owner TEXT, updated TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS docs_parent ON docs(parent);
CREATE INDEX IF NOT EXISTS docs_owner ON docs(owner);
CREATE TABLE IF NOT EXISTS ai_usage(user_id TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, day));
