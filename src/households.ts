export interface Household {
  id: string;
  secret: string;
  created_at: string;
  auth_version: number;
}

export type PinAuthentication =
  | { status: "valid"; household: Household }
  | { status: "invalid" }
  | { status: "rate_limited"; retryAfter: number };

const encoder = new TextEncoder();
const PIN_ITERATIONS = 100_000;
export const PIN_FAILURE_LIMIT = 5;
export const PIN_RATE_LIMIT_SECONDS = 15 * 60;

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

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
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

async function hashOrigin(origin: string): Promise<string> {
  return bytesToBase64(await crypto.subtle.digest("SHA-256", encoder.encode(origin)));
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
      "INSERT INTO households (id, secret, pin_salt, pin_hash, created_at, auth_version) VALUES (?, ?, ?, ?, ?, 1)",
    )
    .bind(id, secret, bytesToBase64(salt), pinHash, createdAt)
    .run();

  return { id, secret, created_at: createdAt, auth_version: 1 };
}

export async function findHousehold(db: D1Database, secret: string): Promise<Household | null> {
  return db
    .prepare("SELECT id, secret, created_at, auth_version FROM households WHERE secret = ?")
    .bind(secret)
    .first<Household>();
}

export async function authenticatePin(
  db: D1Database,
  secret: string,
  pin: string,
  origin: string,
  now = Date.now(),
): Promise<PinAuthentication> {
  const record = await db
    .prepare("SELECT id, secret, pin_salt, pin_hash, created_at, auth_version FROM households WHERE secret = ?")
    .bind(secret)
    .first<Household & { pin_salt: string; pin_hash: string }>();
  if (!record) return { status: "invalid" };

  const originHash = await hashOrigin(origin);
  const nowSeconds = Math.floor(now / 1000);
  const attempt = await db.prepare(`SELECT blocked_until FROM pin_attempts
    WHERE household_id = ? AND origin_hash = ?`).bind(record.id, originHash).first<{ blocked_until: number | null }>();
  if (attempt?.blocked_until && attempt.blocked_until > nowSeconds) {
    return { status: "rate_limited", retryAfter: attempt.blocked_until - nowSeconds };
  }

  const suppliedHash = await derivePin(pin, base64ToBytes(record.pin_salt));
  if (constantTimeEqual(record.pin_hash, suppliedHash)) {
    await db.prepare("DELETE FROM pin_attempts WHERE household_id = ? AND origin_hash = ?")
      .bind(record.id, originHash).run();
    return {
      status: "valid",
      household: { id: record.id, secret: record.secret, created_at: record.created_at, auth_version: record.auth_version },
    };
  }

  const windowStartBoundary = nowSeconds - PIN_RATE_LIMIT_SECONDS;
  await db.prepare(`INSERT INTO pin_attempts
      (household_id, origin_hash, failed_attempts, window_started_at, blocked_until)
    VALUES (?, ?, 1, ?, NULL)
    ON CONFLICT (household_id, origin_hash) DO UPDATE SET
      failed_attempts = CASE WHEN pin_attempts.window_started_at <= ? THEN 1 ELSE pin_attempts.failed_attempts + 1 END,
      window_started_at = CASE WHEN pin_attempts.window_started_at <= ? THEN excluded.window_started_at ELSE pin_attempts.window_started_at END,
      blocked_until = CASE
        WHEN pin_attempts.window_started_at <= ? THEN NULL
        WHEN pin_attempts.failed_attempts + 1 >= ? THEN ?
        ELSE pin_attempts.blocked_until
      END`)
    .bind(record.id, originHash, nowSeconds, windowStartBoundary, windowStartBoundary, windowStartBoundary,
      PIN_FAILURE_LIMIT, nowSeconds + PIN_RATE_LIMIT_SECONDS).run();
  const updated = await db.prepare(`SELECT blocked_until FROM pin_attempts
    WHERE household_id = ? AND origin_hash = ?`).bind(record.id, originHash).first<{ blocked_until: number | null }>();
  if (updated?.blocked_until && updated.blocked_until > nowSeconds) {
    return { status: "rate_limited", retryAfter: updated.blocked_until - nowSeconds };
  }
  return { status: "invalid" };
}

export async function rotatePin(db: D1Database, householdId: string, newPin: string): Promise<number> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const pinHash = await derivePin(newPin, salt);
  await db.batch([
    db.prepare(`UPDATE households SET pin_salt = ?, pin_hash = ?, auth_version = auth_version + 1
      WHERE id = ?`).bind(bytesToBase64(salt), pinHash, householdId),
    db.prepare("DELETE FROM pin_attempts WHERE household_id = ?").bind(householdId),
  ]);
  const household = await db.prepare("SELECT auth_version FROM households WHERE id = ?")
    .bind(householdId).first<{ auth_version: number }>();
  if (!household) throw new Error("household not found");
  return household.auth_version;
}

export async function deleteHousehold(db: D1Database, householdId: string): Promise<void> {
  const approved = "SELECT id FROM approved_programmes WHERE household_id = ?";
  await db.batch([
    db.prepare("DELETE FROM unavailable_episodes WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM movie_playback_history WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM movie_channel_mutations WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM movie_advancements WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM movie_rotation WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM movie_channel_state WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM tv_advancement_history WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM channel_advancements WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM channel_schedule WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM channel_state WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM current_programmes WHERE household_id = ?").bind(householdId),
    db.prepare(`DELETE FROM show_progress WHERE programme_id IN (${approved})`).bind(householdId),
    db.prepare(`DELETE FROM show_episodes WHERE programme_id IN (${approved})`).bind(householdId),
    db.prepare("DELETE FROM approved_programmes WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM pin_attempts WHERE household_id = ?").bind(householdId),
    db.prepare("DELETE FROM households WHERE id = ?").bind(householdId),
  ]);
}
