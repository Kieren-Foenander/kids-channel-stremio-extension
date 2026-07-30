const REAL_DEBRID_ORIGIN = "https://api.real-debrid.com/rest/1.0";
const ZILEAN_ORIGIN = "https://zilean.elfhosted.com";
const KNABEN_ORIGIN = "https://api.knaben.org";
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_CHECK_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;

interface ProbeEnv {
  REAL_DEBRID_ORIGIN?: string;
  ZILEAN_ORIGIN?: string;
  KNABEN_ORIGIN?: string;
}

interface ProbeInput {
  magnet: string;
  query: string;
  imdbId?: string;
  season?: number;
  episode?: number;
}

interface RealDebridTorrentInfo {
  status: string;
  files: Array<{ id: number; path: string; bytes: number }>;
  links: string[];
}

interface RealDebridResult {
  directLink: string;
  timings: {
    addMagnetMs: number;
    filesReadyMs: number;
    cacheCheckMs: number;
    unrestrictMs: number;
    totalMs: number;
  };
}

interface DiscoveryResult {
  status: number | null;
  durationMs: number;
  reachable: boolean;
}

export interface FirstPartyProviderProbeReport {
  success: boolean;
  realDebrid: {
    reachable: boolean;
    cached: boolean;
    redirectReady: boolean;
    timings: RealDebridResult["timings"] | null;
    error?: string;
  };
  discovery: {
    zilean: DiscoveryResult;
    knaben: DiscoveryResult;
  };
}

class ProbeError extends Error {}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

function formBody(values: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) body.set(key, value);
  return body;
}

function realDebridHeaders(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

async function realDebridJson(
  origin: string,
  token: string,
  path: string,
  operation: string,
  init?: RequestInit,
): Promise<unknown> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new ProbeError(`Real-Debrid rejected ${operation} with HTTP ${response.status}.`);
  return response.status === 204 ? null : response.json();
}

function addedTorrentId(value: unknown): string {
  if (
    typeof value === "object"
    && value !== null
    && "id" in value
    && typeof value.id === "string"
    && value.id.length > 0
  ) return value.id;
  throw new ProbeError("Real-Debrid returned an invalid addMagnet response.");
}

function torrentInfo(value: unknown): RealDebridTorrentInfo {
  if (typeof value !== "object" || value === null) {
    throw new ProbeError("Real-Debrid returned invalid torrent information.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.status !== "string"
    || !Array.isArray(record.files)
    || !Array.isArray(record.links)
  ) throw new ProbeError("Real-Debrid returned invalid torrent information.");

  const files = record.files.flatMap((file): RealDebridTorrentInfo["files"] => {
    if (typeof file !== "object" || file === null) return [];
    const candidate = file as Record<string, unknown>;
    return typeof candidate.id === "number"
      && typeof candidate.path === "string"
      && typeof candidate.bytes === "number"
      ? [{ id: candidate.id, path: candidate.path, bytes: candidate.bytes }]
      : [];
  });
  const links = record.links.filter((link): link is string => typeof link === "string");
  return { status: record.status, files, links };
}

function unrestrictedLink(value: unknown): string {
  if (
    typeof value === "object"
    && value !== null
    && "download" in value
    && typeof value.download === "string"
    && /^https:\/\//.test(value.download)
  ) return value.download;
  throw new ProbeError("Real-Debrid returned an invalid unrestricted link.");
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForTorrent(
  origin: string,
  token: string,
  torrentId: string,
  ready: (info: RealDebridTorrentInfo) => boolean,
  timeoutMs: number,
): Promise<RealDebridTorrentInfo> {
  const startedAt = performance.now();
  do {
    const info = torrentInfo(await realDebridJson(
      origin,
      token,
      `/torrents/info/${encodeURIComponent(torrentId)}`,
      "torrent info",
    ));
    if (ready(info)) return info;
    await pause(POLL_INTERVAL_MS);
  } while (performance.now() - startedAt < timeoutMs);
  throw new ProbeError("The torrent was not instantly available in Real-Debrid.");
}

function selectedFile(files: RealDebridTorrentInfo["files"]): RealDebridTorrentInfo["files"][number] {
  const videoExtensions = /\.(mkv|mp4|m4v|avi|webm|ts)$/i;
  const videos = files.filter((file) => videoExtensions.test(file.path));
  const candidates = videos.length > 0 ? videos : files;
  const file = [...candidates].sort((left, right) => right.bytes - left.bytes)[0];
  if (!file) throw new ProbeError("Real-Debrid returned no selectable torrent files.");
  return file;
}

async function deleteTorrent(origin: string, token: string, torrentId: string): Promise<void> {
  const response = await fetch(`${origin}/torrents/delete/${encodeURIComponent(torrentId)}`, {
    method: "DELETE",
    headers: realDebridHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok && response.status !== 404) {
    throw new ProbeError(`Real-Debrid rejected torrent cleanup with HTTP ${response.status}.`);
  }
}

async function probeRealDebrid(magnet: string, realDebridToken: string, env: ProbeEnv): Promise<RealDebridResult> {
  const origin = (env.REAL_DEBRID_ORIGIN || REAL_DEBRID_ORIGIN).replace(/\/$/, "");
  const token = realDebridToken;
  const totalStartedAt = performance.now();
  let torrentId: string | null = null;
  let result: RealDebridResult | null = null;
  let operationError: unknown;

  try {
    const addStartedAt = performance.now();
    torrentId = addedTorrentId(await realDebridJson(origin, token, "/torrents/addMagnet", "addMagnet", {
      method: "POST",
      body: formBody({ magnet }),
    }));
    const addMagnetMs = elapsed(addStartedAt);

    const filesStartedAt = performance.now();
    const beforeSelection = await waitForTorrent(
      origin,
      token,
      torrentId,
      (info) => info.files.length > 0,
      REQUEST_TIMEOUT_MS,
    );
    const filesReadyMs = elapsed(filesStartedAt);
    const file = selectedFile(beforeSelection.files);

    const cacheStartedAt = performance.now();
    await realDebridJson(origin, token, `/torrents/selectFiles/${encodeURIComponent(torrentId)}`, "selectFiles", {
      method: "POST",
      body: formBody({ files: String(file.id) }),
    });
    const ready = await waitForTorrent(
      origin,
      token,
      torrentId,
      (info) => info.status === "downloaded" && info.links.length > 0,
      CACHE_CHECK_TIMEOUT_MS,
    );
    const cacheCheckMs = elapsed(cacheStartedAt);

    const unrestrictStartedAt = performance.now();
    const directLink = unrestrictedLink(await realDebridJson(origin, token, "/unrestrict/link", "unrestrict/link", {
      method: "POST",
      body: formBody({ link: ready.links[0] }),
    }));
    const unrestrictMs = elapsed(unrestrictStartedAt);
    result = {
      directLink,
      timings: {
        addMagnetMs,
        filesReadyMs,
        cacheCheckMs,
        unrestrictMs,
        totalMs: elapsed(totalStartedAt),
      },
    };
  } catch (error) {
    operationError = error;
  }

  if (torrentId) {
    try {
      await deleteTorrent(origin, token, torrentId);
    } catch (cleanupError) {
      if (!operationError) operationError = cleanupError;
    }
  }
  if (operationError) throw operationError;
  if (!result) throw new ProbeError("The Real-Debrid probe did not complete.");
  result.timings.totalMs = elapsed(totalStartedAt);
  return result;
}

async function probeDiscovery(url: string, init?: RequestInit): Promise<DiscoveryResult> {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return { status: response.status, durationMs: elapsed(startedAt), reachable: response.ok };
  } catch {
    return { status: null, durationMs: elapsed(startedAt), reachable: false };
  }
}

async function probeDiscoveryProviders(input: ProbeInput, env: ProbeEnv): Promise<FirstPartyProviderProbeReport["discovery"]> {
  const zileanUrl = new URL("/dmm/filtered", env.ZILEAN_ORIGIN || ZILEAN_ORIGIN);
  if (input.imdbId) zileanUrl.searchParams.set("ImdbId", input.imdbId);
  else zileanUrl.searchParams.set("Query", input.query);
  if (input.season !== undefined) zileanUrl.searchParams.set("Season", String(input.season));
  if (input.episode !== undefined) zileanUrl.searchParams.set("Episode", String(input.episode));

  const knabenUrl = new URL("/v1", env.KNABEN_ORIGIN || KNABEN_ORIGIN);
  const knabenQuery = [
    input.query,
    input.season !== undefined && input.episode !== undefined
      ? `S${String(input.season).padStart(2, "0")}E${String(input.episode).padStart(2, "0")}`
      : "",
  ].filter(Boolean).join(" ");

  const [zilean, knaben] = await Promise.all([
    probeDiscovery(zileanUrl.toString()),
    probeDiscovery(knabenUrl.toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        search_type: "100%",
        search_field: "title",
        query: knabenQuery,
        order_by: "seeders",
        order_direction: "desc",
        size: 3,
        hide_unsafe: true,
        hide_xxx: true,
      }),
    }),
  ]);
  return { zilean, knaben };
}

function validInput(value: unknown): value is ProbeInput {
  if (typeof value !== "object" || value === null) return false;
  const input = value as Record<string, unknown>;
  return typeof input.magnet === "string"
    && input.magnet.startsWith("magnet:?xt=urn:btih:")
    && input.magnet.length <= 4096
    && typeof input.query === "string"
    && input.query.trim().length >= 2
    && input.query.length <= 200
    && (input.imdbId === undefined || (typeof input.imdbId === "string" && /^tt\d+$/.test(input.imdbId)))
    && (input.season === undefined || (Number.isInteger(input.season) && Number(input.season) >= 0))
    && (input.episode === undefined || (Number.isInteger(input.episode) && Number(input.episode) >= 0));
}

async function inputFrom(request: Request): Promise<ProbeInput | null> {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > 8192) return null;
  try {
    const value: unknown = await request.json();
    return validInput(value) ? value : null;
  } catch {
    return null;
  }
}

function safeError(error: unknown): string {
  return error instanceof ProbeError ? error.message : "The Real-Debrid probe failed.";
}

export async function firstPartyProviderProbeResponse(
  request: Request,
  env: ProbeEnv,
  realDebridToken: string,
  redirect: boolean,
): Promise<Response> {
  const input = await inputFrom(request);
  if (!input) {
    return Response.json(
      { error: "Supply a magnet link, a discovery query, and optional IMDb/episode coordinates." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  if (redirect) {
    try {
      const realDebrid = await probeRealDebrid(input.magnet, realDebridToken, env);
      return new Response(null, {
        status: 302,
        headers: {
          location: realDebrid.directLink,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "server-timing": `real-debrid;dur=${realDebrid.timings.totalMs}`,
        },
      });
    } catch (error) {
      return Response.json({ error: safeError(error) }, { status: 502, headers: { "cache-control": "no-store" } });
    }
  }

  const discoveryPromise = probeDiscoveryProviders(input, env);
  let realDebrid: FirstPartyProviderProbeReport["realDebrid"];
  try {
    const result = await probeRealDebrid(input.magnet, realDebridToken, env);
    realDebrid = {
      reachable: true,
      cached: true,
      redirectReady: true,
      timings: result.timings,
    };
  } catch (error) {
    realDebrid = {
      reachable: true,
      cached: false,
      redirectReady: false,
      timings: null,
      error: safeError(error),
    };
  }
  const discovery = await discoveryPromise;
  const discoveryReachable = discovery.zilean.reachable || discovery.knaben.reachable;
  const report: FirstPartyProviderProbeReport = {
    success: realDebrid.redirectReady && discoveryReachable,
    realDebrid,
    discovery,
  };
  return Response.json(report, { headers: { "cache-control": "no-store" } });
}
