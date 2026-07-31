ALTER TABLE stream_selections
  ADD COLUMN download_pending INTEGER NOT NULL DEFAULT 0 CHECK (download_pending IN (0, 1));
