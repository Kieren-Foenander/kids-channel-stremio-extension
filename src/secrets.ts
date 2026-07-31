const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function keyMaterial(secret: string): Promise<ArrayBuffer> {
  if (secret.length < 32) throw new Error("CONFIG_SECRET must contain at least 32 characters");
  return crypto.subtle.digest("SHA-256", encoder.encode(secret));
}

async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await keyMaterial(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

export async function issueParentToken(householdId: string, authVersion: number, secret: string, now = Date.now()): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify({ expiresAt: now + 60 * 60 * 1000, authVersion })));
  const key = await hmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${householdId}.${payload}`));
  return `${payload}.${toBase64Url(signature)}`;
}

export function parentTokenSecondsRemaining(token: string, now = Date.now()): number {
  try {
    const [payload] = token.split(".");
    const parsed = JSON.parse(decoder.decode(fromBase64Url(payload))) as { expiresAt?: unknown };
    return typeof parsed.expiresAt === "number" ? Math.max(0, Math.ceil((parsed.expiresAt - now) / 1000)) : 0;
  } catch {
    return 0;
  }
}

export async function verifyParentToken(token: string, householdId: string, authVersion: number, secret: string, now = Date.now()): Promise<boolean> {
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return false;
    const key = await hmacKey(secret, ["verify"]);
    const valid = await crypto.subtle.verify("HMAC", key, fromBase64Url(signature), encoder.encode(`${householdId}.${payload}`));
    if (!valid) return false;
    const parsed = JSON.parse(decoder.decode(fromBase64Url(payload))) as { expiresAt?: unknown; authVersion?: unknown };
    return typeof parsed.expiresAt === "number" && parsed.expiresAt > now && parsed.authVersion === authVersion;
  } catch {
    return false;
  }
}

export async function issueStreamToken(
  householdId: string,
  torrentId: string,
  fileId: number,
  expiresAt: number,
  secret: string,
): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify({ expiresAt, torrentId, fileId })));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, ["sign"]),
    encoder.encode(`stream.${householdId}.${payload}`),
  );
  return `${payload}.${toBase64Url(signature)}`;
}

export interface StreamTokenPayload {
  expiresAt: number;
  torrentId: string;
  fileId: number;
}

function validStreamTokenPayload(value: unknown, now: number): value is StreamTokenPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  return Number.isSafeInteger(payload.expiresAt)
    && Number(payload.expiresAt) > now
    && typeof payload.torrentId === "string"
    && payload.torrentId.length >= 1
    && payload.torrentId.length <= 128
    && payload.torrentId === payload.torrentId.trim()
    && !/[\u0000-\u001f\u007f]/.test(payload.torrentId)
    && Number.isSafeInteger(payload.fileId)
    && Number(payload.fileId) >= 0;
}

export async function verifyStreamToken(
  token: string,
  householdId: string,
  secret: string,
  now = Date.now(),
): Promise<StreamTokenPayload | null> {
  try {
    if (token.length > 2048) return null;
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) {
      return null;
    }
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret, ["verify"]),
      fromBase64Url(signature),
      encoder.encode(`stream.${householdId}.${payload}`),
    );
    if (!valid) return null;
    const parsed: unknown = JSON.parse(decoder.decode(fromBase64Url(payload)));
    return validStreamTokenPayload(parsed, now) ? parsed : null;
  } catch {
    return null;
  }
}
