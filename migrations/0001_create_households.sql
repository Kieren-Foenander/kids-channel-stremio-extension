CREATE TABLE households (
  id TEXT PRIMARY KEY NOT NULL,
  secret TEXT UNIQUE NOT NULL,
  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX households_secret_idx ON households (secret);
