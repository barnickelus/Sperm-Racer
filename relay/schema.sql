-- Race Wars progress. Run once against the D1 database:
--   wrangler d1 execute race-wars-progress --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- One row per player. Ghosts are not in here: a ghost can be large, and a D1
-- row is limited to about 2 MB, so each ghost is its own row in `ghosts`.
CREATE TABLE IF NOT EXISTS progress (
  user_id TEXT PRIMARY KEY,
  unlocks TEXT NOT NULL DEFAULT '[]',
  podiums INTEGER NOT NULL DEFAULT 0,
  cups TEXT NOT NULL DEFAULT '{}',
  cup_runs TEXT NOT NULL DEFAULT '{}',
  bests TEXT NOT NULL DEFAULT '{}',
  racer TEXT NOT NULL DEFAULT '',
  track TEXT NOT NULL DEFAULT '',
  diff TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ghosts (
  user_id TEXT NOT NULL,
  course TEXT NOT NULL,
  time REAL NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, course)
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
