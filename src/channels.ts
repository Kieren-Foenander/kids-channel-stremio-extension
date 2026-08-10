import type { ContentType } from "./cinemeta";

export type ChannelType = "tv" | "movie";

export interface Channel {
  id: string;
  householdId: string;
  type: ChannelType;
  name: string;
  legacyKey?: ChannelType;
  createdAt: string;
}

interface ChannelRow {
  id: string;
  household_id: string;
  channel_type: ChannelType;
  name: string;
  legacy_key: ChannelType | null;
  created_at: string;
}

export const CHANNEL_LIMIT_PER_TYPE = 5;

function fromRow(row: ChannelRow): Channel {
  return {
    id: row.id,
    householdId: row.household_id,
    type: row.channel_type,
    name: row.name,
    legacyKey: row.legacy_key ?? undefined,
    createdAt: row.created_at,
  };
}

export function channelTypeForContent(type: ContentType): ChannelType {
  return type === "show" ? "tv" : "movie";
}

export function validChannelName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 40;
}

export async function channelsForHousehold(
  db: D1Database,
  householdId: string,
  type?: ChannelType,
): Promise<Channel[]> {
  const query = type
    ? db.prepare(`SELECT * FROM channels WHERE household_id = ? AND channel_type = ?
        ORDER BY created_at, id`).bind(householdId, type)
    : db.prepare(`SELECT * FROM channels WHERE household_id = ?
        ORDER BY CASE channel_type WHEN 'tv' THEN 0 ELSE 1 END, created_at, id`).bind(householdId);
  const rows = await query.all<ChannelRow>();
  return rows.results.map(fromRow);
}

export async function findChannel(
  db: D1Database,
  householdId: string,
  channelId: string,
  type?: ChannelType,
): Promise<Channel | null> {
  const row = type
    ? await db.prepare(`SELECT * FROM channels
        WHERE id = ? AND household_id = ? AND channel_type = ?`).bind(channelId, householdId, type).first<ChannelRow>()
    : await db.prepare("SELECT * FROM channels WHERE id = ? AND household_id = ?")
      .bind(channelId, householdId).first<ChannelRow>();
  return row ? fromRow(row) : null;
}

export async function legacyChannel(
  db: D1Database,
  householdId: string,
  type: ChannelType,
): Promise<Channel | null> {
  const row = await db.prepare(`SELECT * FROM channels
    WHERE household_id = ? AND legacy_key = ?`).bind(householdId, type).first<ChannelRow>();
  return row ? fromRow(row) : null;
}

export async function soleChannel(
  db: D1Database,
  householdId: string,
  type: ChannelType,
): Promise<Channel | null> {
  const channels = await channelsForHousehold(db, householdId, type);
  return channels.length === 1 ? channels[0] : null;
}

export async function createChannel(
  db: D1Database,
  householdId: string,
  type: ChannelType,
  name: string,
  now = new Date(),
): Promise<Channel> {
  if (!validChannelName(name)) throw new Error("channel name is invalid");
  const id = crypto.randomUUID();
  const createdAt = now.toISOString();
  try {
    await db.prepare(`INSERT INTO channels
      (id, household_id, channel_type, name, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(id, householdId, type, name.trim(), createdAt).run();
  } catch (error) {
    if (error instanceof Error && /channel type limit reached/i.test(error.message)) {
      throw new Error("channel type limit reached");
    }
    throw error;
  }
  return { id, householdId, type, name: name.trim(), createdAt };
}

export async function renameChannel(
  db: D1Database,
  householdId: string,
  channelId: string,
  name: string,
): Promise<Channel | null> {
  if (!validChannelName(name)) throw new Error("channel name is invalid");
  const result = await db.prepare("UPDATE channels SET name = ? WHERE id = ? AND household_id = ?")
    .bind(name.trim(), channelId, householdId).run();
  if (result.meta.changes === 0) return null;
  return findChannel(db, householdId, channelId);
}

export async function channelIdsForProgramme(
  db: D1Database,
  householdId: string,
  programmeId: string,
): Promise<string[]> {
  const rows = await db.prepare(`SELECT assignment.channel_id FROM channel_assignments assignment
    JOIN channels channel ON channel.id = assignment.channel_id
    WHERE assignment.programme_id = ? AND channel.household_id = ?
    ORDER BY channel.created_at, channel.id`).bind(programmeId, householdId).all<{ channel_id: string }>();
  return rows.results.map((row) => row.channel_id);
}
