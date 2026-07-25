import { decryptCredential, encryptCredential } from "./secrets";
import type { ValidationResult, ValidationStatus } from "./stream-provider";

export interface ProviderConfiguration {
  configured: boolean;
  validation?: ValidationResult;
  updatedAt?: string;
}

interface StoredConfiguration {
  provider_ciphertext: string | null;
  provider_nonce: string | null;
  provider_validation_status: ValidationStatus | null;
  provider_configured_at: string | null;
}

const messages: Record<ValidationStatus, string> = {
  acceptable_cached: "The provider returned an acceptable cached 1080p Real-Debrid stream.",
  no_cached_result: "The provider returned no cached Real-Debrid stream for the validation title.",
  unsuitable_results: "The provider returned cached streams, but none were suitable 1080p results.",
  provider_failure: "The stream provider could not be validated. Check the endpoint and try again.",
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
    SET provider_ciphertext = ?, provider_nonce = ?, provider_validation_status = ?, provider_configured_at = ?
    WHERE id = ?`)
    .bind(encrypted.ciphertext, encrypted.nonce, validation.status, updatedAt, householdId)
    .run();
  return { configured: true, validation, updatedAt };
}

export async function providerConfiguration(db: D1Database, householdId: string): Promise<ProviderConfiguration> {
  const stored = await db.prepare(`SELECT provider_ciphertext, provider_nonce,
    provider_validation_status, provider_configured_at FROM households WHERE id = ?`)
    .bind(householdId).first<StoredConfiguration>();
  if (!stored?.provider_ciphertext) return { configured: false };
  const status = stored.provider_validation_status ?? "provider_failure";
  return {
    configured: true,
    validation: { status, message: messages[status] },
    updatedAt: stored.provider_configured_at ?? undefined,
  };
}

export async function decryptedManifestUrl(db: D1Database, householdId: string, deploymentSecret: string): Promise<string | null> {
  const stored = await db.prepare("SELECT provider_ciphertext, provider_nonce FROM households WHERE id = ?")
    .bind(householdId).first<StoredConfiguration>();
  if (!stored?.provider_ciphertext || !stored.provider_nonce) return null;
  return decryptCredential(stored.provider_ciphertext, stored.provider_nonce, deploymentSecret, householdId);
}
