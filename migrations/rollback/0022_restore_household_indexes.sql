DROP INDEX households_automatic_preparation_idx;

CREATE INDEX households_secret_idx
  ON households (secret);

PRAGMA optimize;
