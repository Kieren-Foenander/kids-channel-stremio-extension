import { decryptCredential, encryptCredential } from "./secrets";
import type { ValidationResult, ValidationStatus } from "./stream-provider";

export interface ProviderConfiguration {
  configured: boolean;
  validation?: ValidationResult;
  updatedAt?: string;
}

interface StoredConfiguration {
  torrentio_ciphertext: string | null;
  torrentio_nonce: string | null;
  torrentio_validation_status: ValidationStatus | null;
  torrentio_configured_at: string | null;
}

const messages: Record<ValidationStatus, string> = {
  acceptable_cached: "Torrentio returned an acceptable cached 1080p direct stream.",
  no_cached_result: "Torrentio returned no cached direct stream for the validation title.",
  unsuitable_results: "Torrentio returned cached streams, but none were suitable 1080p results.",
  provider_failure: "Torrentio could not be validated. Check the endpoint and try again.",
};

export async function saveProviderConfiguration(
  db: D1Database,
  householdId: string,
  manifestUrl: string,
  deploymentSecret: string,
  validation: ValidationResult,
): Promise<ProviderConfiguration> {
  const encrypted = await encryptCredential(manifestUrl, deploymentSecret, householdId);
  const updatedAt = new Date().toISOString();
  await db.prepare(`UPDATE households
    SET torrentio_ciphertext = ?, torrentio_nonce = ?, torrentio_validation_status = ?, torrentio_configured_at = ?
    WHERE id = ?`)
    .bind(encrypted.ciphertext, encrypted.nonce, validation.status, updatedAt, householdId)
    .run();
  return { configured: true, validation, updatedAt };
}

export async function providerConfiguration(db: D1Database, householdId: string): Promise<ProviderConfiguration> {
  const stored = await db.prepare(`SELECT torrentio_ciphertext, torrentio_nonce,
    torrentio_validation_status, torrentio_configured_at FROM households WHERE id = ?`)
    .bind(householdId).first<StoredConfiguration>();
  if (!stored?.torrentio_ciphertext) return { configured: false };
  const status = stored.torrentio_validation_status ?? "provider_failure";
  return {
    configured: true,
    validation: { status, message: messages[status] },
    updatedAt: stored.torrentio_configured_at ?? undefined,
  };
}

export async function decryptedManifestUrl(db: D1Database, householdId: string, deploymentSecret: string): Promise<string | null> {
  const stored = await db.prepare("SELECT torrentio_ciphertext, torrentio_nonce FROM households WHERE id = ?")
    .bind(householdId).first<StoredConfiguration>();
  if (!stored?.torrentio_ciphertext || !stored.torrentio_nonce) return null;
  return decryptCredential(stored.torrentio_ciphertext, stored.torrentio_nonce, deploymentSecret, householdId);
}
