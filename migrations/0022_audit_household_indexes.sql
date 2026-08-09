-- UNIQUE(secret) already maintains sqlite_autoindex_households_2 for authentication lookups.
DROP INDEX households_secret_idx;

-- Automatic Preparation Run reconciliation only considers Households with TorBox configured.
-- Keep unconfigured Households out of this index and cover both its ordering and result.
CREATE INDEX households_automatic_preparation_idx
  ON households (created_at, id)
  WHERE torbox_token_ciphertext IS NOT NULL;

PRAGMA optimize;
