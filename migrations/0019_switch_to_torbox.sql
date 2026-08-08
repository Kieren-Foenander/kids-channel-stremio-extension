ALTER TABLE households ADD COLUMN torbox_token_ciphertext TEXT;
ALTER TABLE households ADD COLUMN torbox_token_iv TEXT;
ALTER TABLE households ADD COLUMN torbox_token_updated_at TEXT;

-- Real-Debrid selections cannot be resolved through TorBox. They must be rebuilt.
DELETE FROM stream_selections;
DELETE FROM stream_candidate_failures;

UPDATE tv_preparation_runs
SET status = 'failed',
    failure_reason = 'Preparation stopped because the Household streaming provider changed to TorBox.',
    completed_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE status IN ('queued', 'running');
