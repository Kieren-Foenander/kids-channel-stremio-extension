const DEFAULT_TORBOX_ORIGIN = "https://api.torbox.app/v1/api";
const REQUEST_TIMEOUT_MS = 10_000;

export interface TorBoxEnv {
  TORBOX_ORIGIN?: string;
}

export interface TorBoxFile {
  id: number;
  path: string;
  bytes: number;
}

export interface TorBoxTorrent {
  id: string;
  infoHash: string;
  status: string;
  files: TorBoxFile[];
  progress: number;
  speed: number;
  seeders: number;
  ready: boolean;
}

export class TorBoxRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly retryAfter: string | null = null,
  ) {
    super(message);
    this.name = "TorBoxRequestError";
  }
}

function origin(env: TorBoxEnv): string {
  return (env.TORBOX_ORIGIN || DEFAULT_TORBOX_ORIGIN).replace(/\/$/, "");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function numeric(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function responseMessage(value: unknown, fallback: string): { code: string | null; message: string } {
  const body = record(value);
  const error = typeof body?.error === "string" ? body.error : null;
  const detail = typeof body?.detail === "string" ? body.detail : null;
  return { code: error, message: detail || error || fallback };
}

async function torBoxJson(
  token: string,
  env: TorBoxEnv,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${origin(env)}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let body: unknown = null;
  try { body = await response.json(); } catch { /* an empty error response is handled below */ }
  const envelope = record(body);
  if (!response.ok || envelope?.success === false) {
    const failure = responseMessage(body, `TorBox returned HTTP ${response.status}`);
    throw new TorBoxRequestError(response.status, failure.code, failure.message, response.headers.get("retry-after"));
  }
  return envelope && "data" in envelope ? envelope.data : body;
}

export async function validateTorBoxApiToken(
  token: string,
  env: TorBoxEnv = {},
): Promise<"valid" | "invalid" | "unavailable"> {
  try {
    await torBoxJson(token, env, "/user/me");
    return "valid";
  } catch (error) {
    return error instanceof TorBoxRequestError && (error.status === 401 || error.status === 403)
      ? "invalid"
      : "unavailable";
  }
}

function createdTorrentId(value: unknown): string {
  const data = record(value);
  const id = data?.torrent_id;
  if ((typeof id === "number" && Number.isInteger(id)) || (typeof id === "string" && /^\d+$/.test(id))) {
    return String(id);
  }
  if (data?.queued_id !== undefined) {
    throw new TorBoxRequestError(409, "DOWNLOAD_QUEUED", "TorBox queued the torrent because every active slot is occupied");
  }
  throw new TorBoxRequestError(502, "INVALID_RESPONSE", "TorBox returned an invalid torrent identifier");
}

export async function createTorBoxTorrent(
  token: string,
  env: TorBoxEnv,
  magnet: string,
  cachedOnly: boolean,
): Promise<string> {
  const body = new FormData();
  body.set("magnet", magnet);
  body.set("seed", "3");
  body.set("allow_zip", "false");
  body.set("as_queued", "false");
  body.set("add_only_if_cached", cachedOnly ? "true" : "false");
  return createdTorrentId(await torBoxJson(token, env, "/torrents/createtorrent", {
    method: "POST",
    body,
  }));
}

function torrentFile(value: unknown): TorBoxFile | null {
  const file = record(value);
  const id = file?.id;
  const path = typeof file?.name === "string"
    ? file.name
    : typeof file?.short_name === "string"
      ? file.short_name
      : null;
  const bytes = numeric(file?.size);
  return typeof id === "number" && Number.isInteger(id) && path
    ? { id, path, bytes }
    : null;
}

function torrentData(value: unknown): Record<string, unknown> {
  const candidate = Array.isArray(value) ? value[0] : value;
  const data = record(candidate);
  if (!data) throw new TorBoxRequestError(502, "INVALID_RESPONSE", "TorBox returned invalid torrent information");
  return data;
}

export async function getTorBoxTorrent(
  token: string,
  env: TorBoxEnv,
  torrentId: string,
  fresh = false,
): Promise<TorBoxTorrent> {
  const query = new URLSearchParams({ id: torrentId });
  if (fresh) query.set("bypass_cache", "true");
  const data = torrentData(await torBoxJson(token, env, `/torrents/mylist?${query}`));
  const id = data.id;
  if (!((typeof id === "number" && Number.isInteger(id)) || (typeof id === "string" && /^\d+$/.test(id)))) {
    throw new TorBoxRequestError(502, "INVALID_RESPONSE", "TorBox returned invalid torrent information");
  }
  const files = Array.isArray(data.files)
    ? data.files.flatMap((value) => {
      const file = torrentFile(value);
      return file ? [file] : [];
    })
    : [];
  const status = typeof data.download_state === "string" ? data.download_state : "unknown";
  return {
    id: String(id),
    infoHash: typeof data.hash === "string" ? data.hash.toLowerCase() : "",
    status,
    files,
    progress: numeric(data.progress),
    speed: numeric(data.download_speed),
    seeders: numeric(data.seeds),
    ready: data.download_present === true || data.download_finished === true || status === "cached",
  };
}

export function torBoxTorrentIsTerminal(torrent: TorBoxTorrent): boolean {
  const status = torrent.status.toLowerCase();
  return status.includes("error")
    || status.includes("missing")
    || status === "stalled (no seeds)";
}

export async function deleteTorBoxTorrent(
  token: string,
  env: TorBoxEnv,
  torrentId: string,
): Promise<void> {
  try {
    await torBoxJson(token, env, "/torrents/controltorrent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "delete", torrent_id: Number(torrentId) }),
    });
  } catch (error) {
    if (error instanceof TorBoxRequestError && error.status === 404) return;
    throw error;
  }
}

export async function requestTorBoxDownload(
  token: string,
  env: TorBoxEnv,
  torrentId: string,
  fileId: number,
  userIp?: string,
): Promise<string> {
  const query = new URLSearchParams({
    token,
    torrent_id: torrentId,
    file_id: String(fileId),
    redirect: "false",
  });
  if (userIp) query.set("user_ip", userIp);
  const value = await torBoxJson(token, env, `/torrents/requestdl?${query}`);
  if (typeof value !== "string") {
    throw new TorBoxRequestError(502, "INVALID_RESPONSE", "TorBox returned an invalid download link");
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("download link must use HTTPS");
    return url.toString();
  } catch {
    throw new TorBoxRequestError(502, "INVALID_RESPONSE", "TorBox returned an invalid download link");
  }
}
