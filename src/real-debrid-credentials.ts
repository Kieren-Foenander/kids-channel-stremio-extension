const encoder = new TextEncoder();
const REAL_DEBRID_ORIGIN = "https://api.real-debrid.com/rest/1.0";
const TOKEN_VALIDATION_TIMEOUT_MS = 10_000;

export interface RealDebridCredentialStatus {
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
    encoder.encode(`kids-channels:real-debrid-credential:${configurationSecret}`),
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function validRealDebridToken(token: unknown): token is string {
  return typeof token === "string"
    && token.length >= 1
    && token.length <= 512
    && token === token.trim();
}

export async function validateRealDebridToken(token: string, origin = REAL_DEBRID_ORIGIN): Promise<"valid" | "invalid" | "unavailable"> {
  try {
    const response = await fetch(`${origin.replace(/\/$/, "")}/user`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TOKEN_VALIDATION_TIMEOUT_MS),
    });
    if (response.ok) return "valid";
    if (response.status === 401 || response.status === 403) return "invalid";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function realDebridCredentialStatus(
  db: D1Database,
  householdId: string,
): Promise<RealDebridCredentialStatus> {
  const row = await db.prepare(`SELECT real_debrid_token_ciphertext, real_debrid_token_updated_at
    FROM households WHERE id = ?`).bind(householdId).first<{
      real_debrid_token_ciphertext: string | null;
      real_debrid_token_updated_at: string | null;
    }>();
  return {
    configured: Boolean(row?.real_debrid_token_ciphertext),
    updatedAt: row?.real_debrid_token_updated_at ?? null,
  };
}

export async function storeRealDebridCredential(
  db: D1Database,
  householdId: string,
  token: string,
  configurationSecret: string,
  now = new Date().toISOString(),
): Promise<RealDebridCredentialStatus> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(householdId), tagLength: 128 },
    await encryptionKey(configurationSecret),
    encoder.encode(token),
  );
  await db.prepare(`UPDATE households
    SET real_debrid_token_ciphertext = ?, real_debrid_token_iv = ?, real_debrid_token_updated_at = ?
    WHERE id = ?`)
    .bind(bytesToBase64(ciphertext), bytesToBase64(iv), now, householdId)
    .run();
  return { configured: true, updatedAt: now };
}

export async function loadRealDebridCredential(
  db: D1Database,
  householdId: string,
  configurationSecret: string,
): Promise<string | null> {
  const row = await db.prepare(`SELECT real_debrid_token_ciphertext, real_debrid_token_iv
    FROM households WHERE id = ?`).bind(householdId).first<{
      real_debrid_token_ciphertext: string | null;
      real_debrid_token_iv: string | null;
    }>();
  if (!row?.real_debrid_token_ciphertext || !row.real_debrid_token_iv) return null;
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(row.real_debrid_token_iv),
      additionalData: encoder.encode(householdId),
      tagLength: 128,
    },
    await encryptionKey(configurationSecret),
    base64ToBytes(row.real_debrid_token_ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export async function clearRealDebridCredential(db: D1Database, householdId: string): Promise<void> {
  await db.prepare(`UPDATE households
    SET real_debrid_token_ciphertext = NULL, real_debrid_token_iv = NULL, real_debrid_token_updated_at = NULL
    WHERE id = ?`).bind(householdId).run();
}
