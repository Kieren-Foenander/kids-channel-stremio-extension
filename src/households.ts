export interface Household {
  id: string;
  secret: string;
  created_at: string;
}

const encoder = new TextEncoder();
const PIN_ITERATIONS = 100_000;

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function derivePin(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PIN_ITERATIONS },
    key,
    256,
  );
  return bytesToBase64(hash);
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function validPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{6}$/.test(pin);
}

export async function createHousehold(db: D1Database, pin: string): Promise<Household> {
  const id = crypto.randomUUID();
  const secret = randomBase64Url(32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const pinHash = await derivePin(pin, salt);
  const createdAt = new Date().toISOString();

  await db
    .prepare(
      "INSERT INTO households (id, secret, pin_salt, pin_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, secret, bytesToBase64(salt), pinHash, createdAt)
    .run();

  return { id, secret, created_at: createdAt };
}

export async function findHousehold(db: D1Database, secret: string): Promise<Household | null> {
  return db
    .prepare("SELECT id, secret, created_at FROM households WHERE secret = ?")
    .bind(secret)
    .first<Household>();
}

export async function verifyPin(db: D1Database, secret: string, pin: string): Promise<boolean> {
  const record = await db
    .prepare("SELECT pin_salt, pin_hash FROM households WHERE secret = ?")
    .bind(secret)
    .first<{ pin_salt: string; pin_hash: string }>();

  if (!record) return false;

  const decodedSalt = atob(record.pin_salt);
  const salt = new Uint8Array(decodedSalt.length);
  for (let index = 0; index < decodedSalt.length; index += 1) salt[index] = decodedSalt.charCodeAt(index);
  const suppliedHash = await derivePin(pin, salt);
  return constantTimeEqual(record.pin_hash, suppliedHash);
}
