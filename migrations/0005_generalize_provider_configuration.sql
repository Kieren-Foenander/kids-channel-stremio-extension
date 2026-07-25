ALTER TABLE households RENAME COLUMN torrentio_ciphertext TO provider_ciphertext;
ALTER TABLE households RENAME COLUMN torrentio_nonce TO provider_nonce;
ALTER TABLE households RENAME COLUMN torrentio_validation_status TO provider_validation_status;
ALTER TABLE households RENAME COLUMN torrentio_configured_at TO provider_configured_at;
