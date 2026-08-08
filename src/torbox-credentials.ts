import { validateTorBoxApiToken } from "./torbox";

const encoder = new TextEncoder();

export interface TorBoxCredentialStatus {
  configured: boolean;
  updatedAt: string | null;
}

function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function encryptionKey(configurationSecret: string): Promise<CryptoKey> {
  if (configurationSecret.length < 32) throw new Error("CONFIG_SECRET must contain at least 32 characters");
  const material = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`kids-channels:torbox-credential:${configurationSecret}`),
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function validTorBoxToken(token: unknown): token is string {
  return typeof token === "string"
    && token.length >= 1
    && token.length <= 512
    && token === token.trim();
}

export { validateTorBoxApiToken };

export async function torBoxCredentialStatus(
  db: D1Database,
  householdId: string,
): Promise<TorBoxCredentialStatus> {
  const row = await db.prepare(`SELECT torbox_token_ciphertext, torbox_token_updated_at
    FROM households WHERE id = ?`).bind(householdId).first<{
      torbox_token_ciphertext: string | null;
      torbox_token_updated_at: string | null;
    }>();
  return {
    configured: Boolean(row?.torbox_token_ciphertext),
    updatedAt: row?.torbox_token_updated_at ?? null,
  };
}

export async function storeTorBoxCredential(
  db: D1Database,
  householdId: string,
  token: string,
  configurationSecret: string,
  now = new Date().toISOString(),
): Promise<TorBoxCredentialStatus> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(householdId), tagLength: 128 },
    await encryptionKey(configurationSecret),
    encoder.encode(token),
  );
  await db.batch([
    db.prepare(`UPDATE households
      SET torbox_token_ciphertext = ?, torbox_token_iv = ?, torbox_token_updated_at = ?
      WHERE id = ?`).bind(bytesToBase64(ciphertext), bytesToBase64(iv), now, householdId),
    db.prepare("DELETE FROM stream_selections WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM stream_candidate_failures WHERE household_id = ?").bind(householdId),
  ]);
  return { configured: true, updatedAt: now };
}

export async function loadTorBoxCredential(
  db: D1Database,
  householdId: string,
  configurationSecret: string,
): Promise<string | null> {
  const row = await db.prepare(`SELECT torbox_token_ciphertext, torbox_token_iv
    FROM households WHERE id = ?`).bind(householdId).first<{
      torbox_token_ciphertext: string | null;
      torbox_token_iv: string | null;
    }>();
  if (!row?.torbox_token_ciphertext || !row.torbox_token_iv) return null;
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(row.torbox_token_iv),
      additionalData: encoder.encode(householdId),
      tagLength: 128,
    },
    await encryptionKey(configurationSecret),
    base64ToBytes(row.torbox_token_ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export async function clearTorBoxCredential(db: D1Database, householdId: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE households
      SET torbox_token_ciphertext = NULL, torbox_token_iv = NULL, torbox_token_updated_at = NULL
      WHERE id = ?`).bind(householdId),
    db.prepare("DELETE FROM stream_selections WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM stream_candidate_failures WHERE household_id = ?").bind(householdId),
  ]);
}
