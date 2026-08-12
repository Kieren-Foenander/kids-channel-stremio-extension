import { approveProgramme, approvedLibrary, approvedProgrammeDetail, hasApprovedProgramme } from "./approved-library";
import { CinemetaClient, type ContentType } from "./cinemeta";
import {
  authenticatePin,
  createHousehold,
  deleteHousehold,
  findHousehold,
  type Household,
  rotatePin,
  validPin,
} from "./households";
import {
  movieChannelProgramme,
  parentMovieChannelState,
  parseSignOffId,
  reconcileMovieChannel,
  requestMovieSignOff,
  resetMovieRotation,
} from "./movie-channel";
import { householdOverview } from "./overview";
import {
  clearTorBoxCredential,
  loadTorBoxCredential,
  torBoxCredentialStatus,
  storeTorBoxCredential,
  validateTorBoxApiToken,
  validTorBoxToken,
} from "./torbox-credentials";
import {
  issueParentToken,
  issueStreamToken,
  parentTokenSecondsRemaining,
  verifyParentToken,
  verifyStreamToken,
} from "./secrets";
import { movieSignOff, programmeUnavailable } from "./sign-off-media";
import { catalogFor, manifestFor, movieChannelMetadata, tvChannelMetadata } from "./stremio";
import {
  discardStreamSelection,
  invalidateStreamSelection,
  TorBoxResolutionError,
  resolveCachedStream,
  type StreamIdentity,
  streamSelectionContext,
  StreamSelectionGoneError,
} from "./stream-resolution";
import { selectCachedStream, type StreamContentType } from "./stream-selection";
import {
  ensureAutomaticTvPreparation,
  ensureAutomaticTvPreparationForAll,
  restartAutomaticTvPreparation,
  stopAutomaticTvPreparation,
  tvPreparationRun,
  tvPreparationRunForChannel,
  TvSchedulePreparationWorkflow,
  type TvPreparationWorkflowParams,
} from "./tv-preparation";
import {
  clearUnavailableTvProgramme,
  deferUnavailableTvProgramme,
  parentTvChannelState,
  refreshTvChannelSchedule,
  requestTvProgramme,
  setShowProgress,
  tvChannelSchedule,
  undoLatestTvAdvancement,
} from "./tv-channel";
import { pruneObsoleteChannelState } from "./channel-retention";
import {
  channelTypeForContent,
  channelDeletionImpact,
  channelsForHousehold,
  createChannel,
  findChannel,
  legacyChannel,
  renameChannel,
  validChannelName,
  type Channel,
} from "./channels";
import { channelIdFromStremioId } from "./stremio";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  CONFIG_SECRET?: string;
  CINEMETA_ORIGIN?: string;
  TV_SCHEDULE_SEED?: string;
  MOVIE_ROTATION_SEED?: string;
  TORBOX_ORIGIN?: string;
  ZILEAN_ORIGIN?: string;
  KNABEN_ORIGIN?: string;
  AUTOMATIC_TV_PREPARATION_DISABLED?: string;
  TV_PREPARATION: Workflow<TvPreparationWorkflowParams>;
}

export { TvSchedulePreparationWorkflow };

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
};

const MAX_RESOLUTION_ATTEMPTS = 3;

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...jsonHeaders, ...headers },
  });
}

function addonJson(value: unknown, status = 200, headers?: HeadersInit): Response {
  return json(value, status, { "access-control-allow-origin": "*", ...headers });
}

/** Stremio Web fetches inline playback URLs from the browser, so they need the same
 * cross-origin allowance as the manifest, catalog, metadata, and resolve routes. */
function playbackResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "access-control-allow-origin": "*", "cache-control": "no-store" },
  });
}

function playbackRedirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function queueAutomaticTvPreparation(env: Env, ctx: ExecutionContext, householdId: string): void {
  ctx.waitUntil(ensureAutomaticTvPreparation(env, householdId).catch((error) => {
    console.error(JSON.stringify({
      message: "automatic TV preparation trigger failed",
      householdId,
      reason: error instanceof Error ? error.message : "unknown error",
    }));
  }));
}

/** A programme only ever belongs to Channels compatible with its type, so an assignment
 * change can leave every other Channel in the Household untouched. */
async function reconcileAssignedChannels(
  env: Env,
  householdId: string,
  channelIds: Iterable<string>,
  type: ContentType,
): Promise<void> {
  for (const channelId of new Set(channelIds)) {
    if (channelTypeForContent(type) === "tv") {
      await refreshTvChannelSchedule(env.DB, householdId, channelId, false, env.TV_SCHEDULE_SEED);
    } else {
      await reconcileMovieChannel(env.DB, householdId, channelId, env.MOVIE_ROTATION_SEED);
    }
  }
}

async function assignedChannelIds(env: Env, programmeId: string): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT channel_id FROM channel_assignments WHERE programme_id = ?")
    .bind(programmeId).all<{ channel_id: string }>();
  return rows.results.map((row) => row.channel_id);
}

async function playChannelProgramme(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  household: Household,
  channel: Channel,
  contentType: StreamContentType,
  videoId: string,
): Promise<Response> {
  const belongsToChannel = contentType === "series"
    ? (await tvChannelSchedule(env.DB, household.id, channel.id, env.TV_SCHEDULE_SEED))
      .some((programme) => programme.episode.id === videoId)
    : (await movieChannelProgramme(env.DB, household.id, channel.id, env.MOVIE_ROTATION_SEED))?.imdbId === videoId;
  if (!belongsToChannel) return playbackResponse("Programme not found in this Channel.", 404);
  if (!env.CONFIG_SECRET) return playbackResponse("Playback is temporarily unavailable.", 503);
  try {
    const torBoxToken = await loadTorBoxCredential(env.DB, household.id, env.CONFIG_SECRET);
    if (!torBoxToken) {
      if (contentType === "series") {
        await requestTvProgramme(env.DB, household.id, channel.id, videoId, env.TV_SCHEDULE_SEED);
        queueAutomaticTvPreparation(env, ctx, household.id);
        return programmeUnavailable(request);
      }
      return playbackResponse("TorBox is not configured for this Household.", 503);
    }
    const selection = await selectCachedStream(
      env.DB,
      household.id,
      contentType,
      videoId,
      torBoxToken,
      env,
    );
    if (!selection) {
      if (contentType !== "series") return playbackResponse("Movie stream is unavailable.", 404);
      await requestTvProgramme(env.DB, household.id, channel.id, videoId, env.TV_SCHEDULE_SEED);
      queueAutomaticTvPreparation(env, ctx, household.id);
      await deferUnavailableTvProgramme(env.DB, household.id, channel.id, videoId, env.TV_SCHEDULE_SEED);
      return programmeUnavailable(request);
    }
    if (contentType === "series") {
      await clearUnavailableTvProgramme(env.DB, household.id, videoId);
      await requestTvProgramme(env.DB, household.id, channel.id, videoId, env.TV_SCHEDULE_SEED);
      queueAutomaticTvPreparation(env, ctx, household.id);
    }
    const resolveToken = await issueStreamToken(
      household.id,
      selection.torrentId,
      selection.fileId,
      Date.parse(selection.staleAt),
      env.CONFIG_SECRET,
    );
    return playbackRedirect(
      `${new URL(request.url).origin}/addons/${household.secret}/resolve/${resolveToken}`,
    );
  } catch (error) {
    console.error(JSON.stringify({
      message: "Channel playback failed",
      householdId: household.id,
      channelId: channel.id,
      contentType,
      reason: error instanceof Error ? error.message : "unknown error",
    }));
    return contentType === "series"
      ? programmeUnavailable(request)
      : playbackResponse("Movie playback is temporarily unavailable.", 502);
  }
}

async function householdNotFoundResponse(request: Request, assets?: Fetcher): Promise<Response> {
  let stylesheetLinks = "";
  if (assets) {
    // Reuse the application's generated design-system stylesheet without executing the SPA
    // or embedding presentation in this privacy-preserving error document.
    const shellUrl = new URL("/_shell", request.url);
    const shellBody = await (await assets.fetch(new Request(shellUrl))).text();
    stylesheetLinks = [...shellBody.matchAll(/<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\bhref=["'](\/assets\/[^"'<>]+)["'])[^>]*>/gi)]
      .map((match) => `<link rel="stylesheet" href="${match[1]}">`)
      .join("");
  }
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f4f2ed">
  <title>Household not found — Kids Channels</title>
  ${stylesheetLinks}
</head>
<body>
  <main id="main" class="page-shell deleted-shell">
    <p class="eyebrow">Kids Channels</p>
    <h1>Household not found</h1>
    <p>This private Household URL is unavailable. Check the complete URL, or create a new Household.</p>
    <a class="button" href="/">Create a new Household</a>
  </main>
</body>
</html>`;
  return new Response(body, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; img-src 'self' https: data:; font-src 'self'; style-src 'self'; script-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "cache-control": "no-store",
    },
  });
}

const PARENT_SESSION_COOKIE = "kids_parent_session";
const PARENT_SESSION_SECONDS = 60 * 60;

function parentSessionCookie(token: string): string {
  return `${PARENT_SESSION_COOKIE}=${token}; Path=/; Max-Age=${PARENT_SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function clearParentSessionCookie(): string {
  return `${PARENT_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

async function spaResponse(request: Request, assets: Fetcher): Promise<Response> {
  // Cloudflare's asset binding canonicalises the generated HTML asset to this extensionless path.
  const response = await assets.fetch(new Request(new URL("/_shell", request.url)));
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", "default-src 'none'; connect-src 'self'; img-src 'self' https: data:; font-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function installDetails(origin: string, secret: string) {
  const manifestUrl = `${origin}/addons/${secret}/manifest.json`;
  return {
    manifestUrl,
    installUrl: `stremio://${manifestUrl.replace(/^https?:\/\//, "")}`,
    parentUrl: `${origin}/households/${secret}`,
  };
}

function channelPoster(kind: "tv" | "movie"): Response {
  const label = kind === "tv" ? "TV" : "MOVIE";
  const accent = kind === "tv" ? "#65d6ad" : "#ffbf69";
  const icon = kind === "tv" ? "▶" : "◆";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><rect width="600" height="600" rx="48" fill="#1b2140"/><circle cx="300" cy="255" r="145" fill="${accent}"/><text x="300" y="300" text-anchor="middle" font-family="sans-serif" font-size="130" fill="#101426">${icon}</text><text x="300" y="490" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="72" fill="#fff">${label} CHANNEL</text></svg>`;
  return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
}

async function parsePin(request: Request): Promise<unknown> {
  try {
    const body = (await request.json()) as { pin?: unknown };
    return body.pin;
  } catch {
    return undefined;
  }
}

async function authorizedParent(request: Request, household: Household, deploymentSecret: string): Promise<boolean> {
  const token = cookieValue(request, PARENT_SESSION_COOKIE);
  return token ? verifyParentToken(token, household.id, household.auth_version, deploymentSecret) : false;
}

function pinRequestOrigin(request: Request): string {
  return request.headers.get("cf-connecting-ip") || "unknown-origin";
}

function rateLimitedPin(retryAfter: number): Response {
  return json(
    { error: `Too many incorrect PIN attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.` },
    429,
    { "retry-after": String(retryAfter), "cache-control": "no-store" },
  );
}

function decodedPathSegment(value: string): string | null {
  try { return decodeURIComponent(value); } catch { return null; }
}

function isStateChangingParentRequest(request: Request, path: string): boolean {
  return path.startsWith("/api/households") && !["GET", "HEAD", "OPTIONS"].includes(request.method);
}

function hasSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      if (path.startsWith("/addons/")) {
        return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, HEAD, OPTIONS" } });
      }
      return new Response(null, { status: 204 });
    }

    if (isStateChangingParentRequest(request, path) && !hasSameOrigin(request)) {
      return json({ error: "This request must come from the Parent Page." }, 403, { "cache-control": "no-store" });
    }

    if (request.method === "GET" && path === "/") {
      return env.ASSETS
        ? spaResponse(request, env.ASSETS)
        : json({ error: "The Parent Page application is unavailable." }, 503, { "cache-control": "no-store" });
    }
    const spaHouseholdMatch = path.match(/^\/households\/([A-Za-z0-9_-]+)(?:\/.*)?$/);
    if (request.method === "GET" && spaHouseholdMatch) {
      if (!(await findHousehold(env.DB, spaHouseholdMatch[1]))) return householdNotFoundResponse(request, env.ASSETS);
      return env.ASSETS
        ? spaResponse(request, env.ASSETS)
        : json({ error: "The Parent Page application is unavailable." }, 503, { "cache-control": "no-store" });
    }
    if (request.method === "GET" && path === "/assets/tv-channel.svg") return channelPoster("tv");
    if (request.method === "GET" && path === "/assets/movie-channel.svg") return channelPoster("movie");
    if ((request.method === "GET" || request.method === "HEAD") && path === "/assets/movie-sign-off.mp4") return movieSignOff(request);
    if ((request.method === "GET" || request.method === "HEAD") && path === "/assets/programme-unavailable-v2.mp4") {
      return programmeUnavailable(request, env.ASSETS);
    }

    if (request.method === "POST" && path === "/api/households") {
      const pin = await parsePin(request);
      if (!validPin(pin)) return json({ error: "PIN must contain exactly six digits." }, 400);
      if (!env.CONFIG_SECRET) return json({ error: "Household creation is temporarily unavailable." }, 503);
      const household = await createHousehold(env.DB, pin);
      const token = await issueParentToken(household.id, household.auth_version, env.CONFIG_SECRET);
      return json(
        { householdId: household.id, ...installDetails(url.origin, household.secret) },
        201,
        { "cache-control": "no-store", "set-cookie": parentSessionCookie(token) },
      );
    }

    const sessionMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/session$/);
    if (request.method === "GET" && sessionMatch) {
      const household = await findHousehold(env.DB, sessionMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401, { "cache-control": "no-store" });
      }
      const token = cookieValue(request, PARENT_SESSION_COOKIE)!;
      return json({ authenticated: true, expiresIn: parentTokenSecondsRemaining(token) }, 200, { "cache-control": "no-store" });
    }

    const unlockMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/unlock$/);
    if (request.method === "POST" && unlockMatch) {
      const pin = await parsePin(request);
      if (!validPin(pin)) return json({ error: "PIN must contain exactly six digits." }, 400);
      const authentication = await authenticatePin(env.DB, unlockMatch[1], pin, pinRequestOrigin(request));
      if (authentication.status === "rate_limited") return rateLimitedPin(authentication.retryAfter);
      if (authentication.status === "invalid") return json({ error: "Household or PIN is incorrect." }, 401);
      if (!env.CONFIG_SECRET) return json({ error: "Parent access is temporarily unavailable." }, 503);
      const token = await issueParentToken(authentication.household.id, authentication.household.auth_version, env.CONFIG_SECRET);
      return json(
        installDetails(url.origin, unlockMatch[1]),
        200,
        { "cache-control": "no-store", "set-cookie": parentSessionCookie(token) },
      );
    }

    const lockMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/lock$/);
    if (request.method === "POST" && lockMatch) {
      return json(
        { message: "Parent Page locked." },
        200,
        { "cache-control": "no-store", "set-cookie": clearParentSessionCookie() },
      );
    }

    const pinMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/pin$/);
    if (request.method === "PUT" && pinMatch) {
      const household = await findHousehold(env.DB, pinMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      let input: { currentPin?: unknown; newPin?: unknown } = {};
      try { input = await request.json() as typeof input; } catch { /* handled below */ }
      if (!validPin(input.currentPin) || !validPin(input.newPin)) {
        return json({ error: "Current and new PINs must each contain exactly six digits." }, 400);
      }
      if (input.currentPin === input.newPin) return json({ error: "Choose a new PIN that differs from the current PIN." }, 400);
      const authentication = await authenticatePin(env.DB, household.secret, input.currentPin, pinRequestOrigin(request));
      if (authentication.status === "rate_limited") return rateLimitedPin(authentication.retryAfter);
      if (authentication.status === "invalid") return json({ error: "Current PIN is incorrect." }, 401);
      const authVersion = await rotatePin(env.DB, household.id, input.newPin);
      const token = await issueParentToken(household.id, authVersion, env.CONFIG_SECRET);
      return json(
        { message: "Parent PIN changed. Previous Parent sessions have been signed out." },
        200,
        { "cache-control": "no-store", "set-cookie": parentSessionCookie(token) },
      );
    }

    const torBoxMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/torbox$/);
    if (torBoxMatch && ["GET", "PUT", "DELETE"].includes(request.method)) {
      const household = await findHousehold(env.DB, torBoxMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401, { "cache-control": "no-store" });
      }
      if (request.method === "GET") {
        return json(await torBoxCredentialStatus(env.DB, household.id), 200, { "cache-control": "no-store" });
      }
      if (request.method === "DELETE") {
        await stopAutomaticTvPreparation(env, household.id, "Stopped because TorBox was disconnected");
        await clearTorBoxCredential(env.DB, household.id);
        return json(
          { configured: false, updatedAt: null, message: "TorBox disconnected. Channel playback is unavailable until another token is saved." },
          200,
          { "cache-control": "no-store" },
        );
      }
      let input: { token?: unknown } = {};
      try { input = await request.json() as typeof input; } catch { /* handled below */ }
      if (!validTorBoxToken(input.token)) {
        return json({ error: "Enter a TorBox API token without leading or trailing spaces." }, 400, { "cache-control": "no-store" });
      }
      const validation = await validateTorBoxApiToken(input.token, env);
      if (validation === "invalid") {
        return json({ error: "TorBox rejected this token. Check it and try again." }, 400, { "cache-control": "no-store" });
      }
      if (validation === "unavailable") {
        return json({ error: "TorBox could not validate this token right now. Nothing was saved." }, 502, { "cache-control": "no-store" });
      }
      const status = await storeTorBoxCredential(env.DB, household.id, input.token, env.CONFIG_SECRET);
      ctx.waitUntil(restartAutomaticTvPreparation(env, household.id).catch((error) => {
        console.error(JSON.stringify({
          message: "automatic TV preparation could not restart after TorBox connection changed",
          householdId: household.id,
          reason: error instanceof Error ? error.message : "unknown error",
        }));
      }));
      return json(
        { ...status, message: "TorBox connected. The token is stored encrypted for this Household." },
        200,
        { "cache-control": "no-store" },
      );
    }

    const deleteMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)$/);
    if (request.method === "DELETE" && deleteMatch) {
      const household = await findHousehold(env.DB, deleteMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      let input: { currentPin?: unknown; confirmation?: unknown } = {};
      try { input = await request.json() as typeof input; } catch { /* handled below */ }
      if (input.confirmation !== "DELETE") return json({ error: "Type DELETE exactly to confirm permanent deletion." }, 400);
      if (!validPin(input.currentPin)) return json({ error: "Enter the current six-digit PIN." }, 400);
      const authentication = await authenticatePin(env.DB, household.secret, input.currentPin, pinRequestOrigin(request));
      if (authentication.status === "rate_limited") return rateLimitedPin(authentication.retryAfter);
      if (authentication.status === "invalid") return json({ error: "Current PIN is incorrect." }, 401);
      await deleteHousehold(env.DB, household.id);
      return json(
        { message: "Household permanently deleted." },
        200,
        { "cache-control": "no-store", "set-cookie": clearParentSessionCookie() },
      );
    }

    const channelsMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/channels$/);
    if (channelsMatch && (request.method === "GET" || request.method === "POST")) {
      const household = await findHousehold(env.DB, channelsMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401, { "cache-control": "no-store" });
      }
      if (request.method === "GET") {
        return json({ channels: await channelsForHousehold(env.DB, household.id) }, 200, { "cache-control": "no-store" });
      }
      let input: { type?: unknown; name?: unknown } = {};
      try { input = await request.json() as typeof input; } catch { /* handled below */ }
      if ((input.type !== "tv" && input.type !== "movie") || !validChannelName(input.name)) {
        return json({ error: "Choose TV or Movie and enter a name between 1 and 40 characters." }, 400);
      }
      try {
        const channel = await createChannel(env.DB, household.id, input.type, input.name);
        return json({ channel }, 201);
      } catch (error) {
        if (error instanceof Error && error.message === "channel type limit reached") {
          return json({ error: `This Household already has five ${input.type === "tv" ? "TV" : "Movie"} Channels.` }, 409);
        }
        throw error;
      }
    }

    const channelMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/channels\/([A-Za-z0-9-]+)$/);
    if (channelMatch && (request.method === "GET" || request.method === "PATCH" || request.method === "DELETE")) {
      const household = await findHousehold(env.DB, channelMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401, { "cache-control": "no-store" });
      }
      const channel = await findChannel(env.DB, household.id, channelMatch[2]);
      if (!channel) return json({ error: "Channel was not found." }, 404);
      if (request.method === "GET") {
        return json({
          channel,
          deletionImpact: await channelDeletionImpact(env.DB, household.id, channel.id),
        }, 200, { "cache-control": "no-store" });
      }
      if (request.method === "PATCH") {
        let input: { name?: unknown } = {};
        try { input = await request.json() as typeof input; } catch { /* handled below */ }
        if (!validChannelName(input.name)) return json({ error: "Enter a name between 1 and 40 characters." }, 400);
        const renamed = await renameChannel(env.DB, household.id, channel.id, input.name);
        return json({ channel: renamed, message: "Channel renamed. Restart Stremio to refresh its tile." });
      }
      const deletionImpact = await channelDeletionImpact(env.DB, household.id, channel.id);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM channels WHERE id = ? AND household_id = ?").bind(channel.id, household.id),
        ...deletionImpact.programmesLeavingHousehold.map((programme) => env.DB.prepare(
          "DELETE FROM approved_programmes WHERE id = ? AND household_id = ?",
        ).bind(programme.programmeId, household.id)),
      ]);
      queueAutomaticTvPreparation(env, ctx, household.id);
      return json({
        message: "Channel deleted. Restart Stremio to refresh the Channel rows.",
        removedProgrammes: deletionImpact.programmesLeavingHousehold.length,
      });
    }

    const searchMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/cinemeta\/search$/);
    if (request.method === "GET" && searchMatch) {
      const household = await findHousehold(env.DB, searchMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      const query = url.searchParams.get("q")?.trim();
      if (!query || query.length < 2 || query.length > 100) return json({ error: "Search must contain between 2 and 100 characters." }, 400);
      try {
        return json({ results: await new CinemetaClient(env.CINEMETA_ORIGIN).search(query) });
      } catch {
        return json({ error: "Cinemeta search is temporarily unavailable." }, 502);
      }
    }

    const titleMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/cinemeta\/title\/(show|movie)\/(tt\d+)$/);
    if (request.method === "GET" && titleMatch) {
      const household = await findHousehold(env.DB, titleMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      try {
        const title = await new CinemetaClient(env.CINEMETA_ORIGIN).title(titleMatch[2] as ContentType, titleMatch[3]);
        if (!title) return json({ error: "Programme was not found in Cinemeta." }, 404);
        return json({ title });
      } catch {
        return json({ error: "Cinemeta metadata is temporarily unavailable." }, 502);
      }
    }

    const libraryMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/library$/);
    if (libraryMatch && (request.method === "GET" || request.method === "POST")) {
      const household = await findHousehold(env.DB, libraryMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      if (request.method === "GET") return json({ programmes: await approvedLibrary(env.DB, household.id) });
      let input: {
        type?: unknown;
        imdbId?: unknown;
        startingEpisodeId?: unknown;
        startingEpisodeIds?: unknown;
        channelIds?: unknown;
      } = {};
      try { input = await request.json() as typeof input; } catch { /* handled below */ }
      if ((input.type !== "show" && input.type !== "movie") || typeof input.imdbId !== "string" || !/^tt\d+$/.test(input.imdbId)) {
        return json({ error: "Choose a valid Cinemeta show or movie." }, 400);
      }
      if (input.startingEpisodeId !== undefined && (typeof input.startingEpisodeId !== "string" || input.startingEpisodeId.length === 0)) {
        return json({ error: "Choose a valid regular released starting episode." }, 400);
      }
      if (input.startingEpisodeIds !== undefined && (!input.startingEpisodeIds
        || typeof input.startingEpisodeIds !== "object" || Array.isArray(input.startingEpisodeIds)
        || Object.values(input.startingEpisodeIds).some((videoId) => typeof videoId !== "string" || videoId.length === 0))) {
        return json({ error: "Choose a valid regular released starting episode for each TV Channel." }, 400);
      }
      if (input.channelIds !== undefined && (!Array.isArray(input.channelIds)
        || input.channelIds.some((channelId) => typeof channelId !== "string"))) {
        return json({ error: "Choose one or more compatible Channels." }, 400);
      }
      if (await hasApprovedProgramme(env.DB, household.id, input.type, input.imdbId)) {
        return json({ error: "This programme is already in the Approved Library." }, 409);
      }
      try {
        const title = await new CinemetaClient(env.CINEMETA_ORIGIN).title(input.type, input.imdbId);
        if (!title) return json({ error: "Programme was not found in Cinemeta." }, 404);
        const programme = await approveProgramme(
          env.DB,
          household.id,
          title,
          input.startingEpisodeId,
          input.channelIds as string[] | undefined,
          input.startingEpisodeIds as Record<string, string> | undefined,
        );
        await reconcileAssignedChannels(
          env,
          household.id,
          programme.assignments.map((assignment) => assignment.channelId),
          programme.type,
        );
        if (programme.type === "show") queueAutomaticTvPreparation(env, ctx, household.id);
        return json({ programme }, 201);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "starting episode is invalid") return json({ error: "Choose a valid regular released starting episode." }, 400);
        if (message === "show has no regular released episodes") return json({ error: "This show has no regular released episodes to approve." }, 400);
        if (message === "compatible channel is required") return json({ error: "Create a compatible Channel before approving this programme." }, 409);
        if (message === "channel selection is required") return json({ error: "Choose at least one compatible Channel." }, 400);
        if (message === "channel selection is invalid") return json({ error: "Choose only compatible Channels from this Household." }, 400);
        if (message.includes("UNIQUE")) return json({ error: "This programme is already in the Approved Library." }, 409);
        console.error(JSON.stringify({
          message: "programme approval failed",
          householdId: household.id,
          reason: message || "unknown error",
        }));
        return json({ error: "Cinemeta metadata is temporarily unavailable." }, 502);
      }
    }

    const libraryProgrammeMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/library\/([A-Za-z0-9-]+)$/);
    if (libraryProgrammeMatch && request.method === "GET") {
      const household = await findHousehold(env.DB, libraryProgrammeMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401, { "cache-control": "no-store" });
      }
      const programme = await approvedProgrammeDetail(env.DB, household.id, libraryProgrammeMatch[2]);
      if (!programme) return json({ error: "Programme was not found in the Approved Library." }, 404, { "cache-control": "no-store" });
      return json({ programme }, 200, { "cache-control": "no-store" });
    }

    const assignmentsMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/library\/([A-Za-z0-9-]+)\/assignments$/);
    if (assignmentsMatch && request.method === "PUT") {
      const household = await findHousehold(env.DB, assignmentsMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      const programme = await env.DB.prepare(`SELECT id, content_type FROM approved_programmes
        WHERE id = ? AND household_id = ?`).bind(assignmentsMatch[2], household.id)
        .first<{ id: string; content_type: ContentType }>();
      if (!programme) return json({ error: "Programme was not found in the Approved Library." }, 404);
      let input: { channelIds?: unknown; startingEpisodeId?: unknown; startingEpisodeIds?: unknown } = {};
      try { input = await request.json() as typeof input; } catch { /* handled below */ }
      if (!Array.isArray(input.channelIds)
        || input.channelIds.some((channelId) => typeof channelId !== "string")) {
        return json({ error: "Choose compatible Channels for this programme." }, 400);
      }
      if (input.startingEpisodeIds !== undefined && (!input.startingEpisodeIds
        || typeof input.startingEpisodeIds !== "object" || Array.isArray(input.startingEpisodeIds)
        || Object.values(input.startingEpisodeIds).some((videoId) => typeof videoId !== "string" || videoId.length === 0))) {
        return json({ error: "Choose a valid regular released starting episode for each new TV Channel Assignment." }, 400);
      }
      const desiredIds = [...new Set(input.channelIds as string[])];
      const compatible = await channelsForHousehold(env.DB, household.id, channelTypeForContent(programme.content_type));
      const compatibleIds = new Set(compatible.map((channel) => channel.id));
      if (desiredIds.some((channelId) => !compatibleIds.has(channelId))) {
        return json({ error: "Choose only compatible Channels from this Household." }, 400);
      }
      const existingIds = new Set(await assignedChannelIds(env, programme.id));
      if (desiredIds.length === 0) {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM current_programmes WHERE household_id = ? AND programme_id = ?")
            .bind(household.id, programme.id),
          env.DB.prepare("DELETE FROM channel_schedule WHERE household_id = ? AND programme_id = ?")
            .bind(household.id, programme.id),
          env.DB.prepare("DELETE FROM movie_rotation WHERE household_id = ? AND programme_id = ?")
            .bind(household.id, programme.id),
          env.DB.prepare("DELETE FROM channel_assignments WHERE programme_id = ?").bind(programme.id),
          env.DB.prepare("DELETE FROM approved_programmes WHERE id = ? AND household_id = ?")
            .bind(programme.id, household.id),
        ]);
        await reconcileAssignedChannels(env, household.id, existingIds, programme.content_type);
        if (programme.content_type === "show") queueAutomaticTvPreparation(env, ctx, household.id);
        return json({ programme: null, message: "Final Channel Assignment removed; the programme left the Approved Library. Restart Stremio to refresh the Channels." });
      }
      const additions = desiredIds.filter((channelId) => !existingIds.has(channelId));
      const removals = [...existingIds].filter((channelId) => !desiredIds.includes(channelId));
      const startingEpisodeIds = new Map<string, string>();
      if (programme.content_type === "show" && additions.length > 0) {
        const requestedStartingEpisodeIds = input.startingEpisodeIds as Record<string, string> | undefined;
        if (requestedStartingEpisodeIds
          && Object.keys(requestedStartingEpisodeIds).some((channelId) => !additions.includes(channelId))) {
          return json({ error: "Choose starting Show Progress only for new TV Channel Assignments." }, 400);
        }
        const episodes = await env.DB.prepare(`SELECT video_id, season, episode FROM show_episodes
          WHERE programme_id = ? ORDER BY season, episode`).bind(programme.id)
          .all<{ video_id: string; season: number; episode: number }>();
        const defaultEpisodeId = episodes.results.find((episode) => episode.season === 1 && episode.episode === 1)?.video_id;
        for (const channelId of additions) {
          const startingEpisodeId = requestedStartingEpisodeIds?.[channelId]
            ?? (typeof input.startingEpisodeId === "string" ? input.startingEpisodeId : defaultEpisodeId);
          if (!startingEpisodeId || !episodes.results.some((episode) => episode.video_id === startingEpisodeId)) {
            return json({ error: "Choose a valid regular released starting episode for each new TV Channel Assignment." }, 400);
          }
          startingEpisodeIds.set(channelId, startingEpisodeId);
        }
      }
      const now = new Date().toISOString();
      const statements: D1PreparedStatement[] = [];
      for (const channelId of removals) {
        statements.push(
          env.DB.prepare("DELETE FROM current_programmes WHERE channel_id = ? AND programme_id = ?")
            .bind(channelId, programme.id),
          env.DB.prepare("DELETE FROM channel_schedule WHERE channel_id = ? AND programme_id = ?")
            .bind(channelId, programme.id),
          env.DB.prepare("DELETE FROM movie_rotation WHERE channel_id = ? AND programme_id = ?")
            .bind(channelId, programme.id),
          env.DB.prepare("DELETE FROM channel_assignments WHERE channel_id = ? AND programme_id = ?")
            .bind(channelId, programme.id),
        );
      }
      for (const channelId of additions) {
        statements.push(env.DB.prepare(`INSERT INTO channel_assignments
          (channel_id, programme_id, next_video_id, created_at) VALUES (?, ?, ?, ?)`)
          .bind(channelId, programme.id, startingEpisodeIds.get(channelId) ?? null, now));
      }
      if (statements.length > 0) await env.DB.batch(statements);
      await reconcileAssignedChannels(env, household.id, [...additions, ...removals], programme.content_type);
      if (programme.content_type === "show") queueAutomaticTvPreparation(env, ctx, household.id);
      return json({
        programme: await approvedProgrammeDetail(env.DB, household.id, programme.id),
        message: "Channel Assignments updated. Restart Stremio to refresh the Channels.",
      });
    }

    if (libraryProgrammeMatch && (request.method === "PATCH" || request.method === "DELETE")) {
      const household = await findHousehold(env.DB, libraryProgrammeMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      const programme = await env.DB.prepare(`SELECT id, content_type FROM approved_programmes
        WHERE id = ? AND household_id = ?`).bind(libraryProgrammeMatch[2], household.id)
        .first<{ id: string; content_type: ContentType }>();
      if (!programme) return json({ error: "Programme was not found in the Approved Library." }, 404);

      if (request.method === "PATCH") {
        let input: { paused?: unknown; channelId?: unknown } = {};
        try { input = await request.json() as typeof input; } catch { /* handled below */ }
        if (programme.content_type !== "show" || typeof input.paused !== "boolean") {
          return json({ error: "Choose whether to pause or resume an approved show." }, 400);
        }
        const channel = typeof input.channelId === "string"
          ? await findChannel(env.DB, household.id, input.channelId, "tv")
          : await legacyChannel(env.DB, household.id, "tv");
        if (!channel) return json({ error: "TV Channel was not found." }, 404);
        const pausedAt = input.paused ? new Date().toISOString() : null;
        const updated = await env.DB.prepare(`UPDATE channel_assignments SET paused_at = ?
          WHERE channel_id = ? AND programme_id = ?`).bind(pausedAt, channel.id, programme.id).run();
        if (updated.meta.changes === 0) return json({ error: "Show is not assigned to this TV Channel." }, 404);
        await refreshTvChannelSchedule(env.DB, household.id, channel.id, false, env.TV_SCHEDULE_SEED);
        queueAutomaticTvPreparation(env, ctx, household.id);
        return json({ message: `${input.paused ? "Show paused without changing Show Progress." : "Show resumed."} Restart Stremio to refresh the Channel.` });
      }

      const affectedChannelIds = await assignedChannelIds(env, programme.id);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM current_programmes WHERE household_id = ? AND programme_id = ?")
          .bind(household.id, programme.id),
        env.DB.prepare("DELETE FROM channel_schedule WHERE household_id = ? AND programme_id = ?")
          .bind(household.id, programme.id),
        env.DB.prepare("DELETE FROM movie_rotation WHERE household_id = ? AND programme_id = ?")
          .bind(household.id, programme.id),
        env.DB.prepare("DELETE FROM channel_assignments WHERE programme_id = ?")
          .bind(programme.id),
        env.DB.prepare("DELETE FROM approved_programmes WHERE id = ? AND household_id = ?")
          .bind(programme.id, household.id),
      ]);
      await reconcileAssignedChannels(env, household.id, affectedChannelIds, programme.content_type);
      if (programme.content_type === "show") queueAutomaticTvPreparation(env, ctx, household.id);
      return json({ message: `${programme.content_type === "show" ? "Show" : "Movie"} removed from future Channel selections. Restart Stremio to refresh the Channel.` });
    }

    const overviewMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/overview$/);
    if (request.method === "GET" && overviewMatch) {
      const household = await findHousehold(env.DB, overviewMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401, { "cache-control": "no-store" });
      }
      return json(
        await householdOverview(env.DB, household.id, env.TV_SCHEDULE_SEED, env.MOVIE_ROTATION_SEED),
        200,
        { "cache-control": "no-store" },
      );
    }

    const channelStateMatch = path.match(
      /^\/api\/households\/([A-Za-z0-9_-]+)\/channels\/([A-Za-z0-9-]+)\/(tv-state|movie-state|tv-preparation)$/,
    );
    if (request.method === "GET" && channelStateMatch) {
      const household = await findHousehold(env.DB, channelStateMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401, { "cache-control": "no-store" });
      }
      const channel = await findChannel(env.DB, household.id, channelStateMatch[2]);
      if (!channel) return json({ error: "Channel was not found." }, 404);
      if (channelStateMatch[3] === "tv-state") {
        if (channel.type !== "tv") return json({ error: "Choose a TV Channel." }, 400);
        return json(await parentTvChannelState(env.DB, household.id, channel.id, env.TV_SCHEDULE_SEED));
      }
      if (channelStateMatch[3] === "movie-state") {
        if (channel.type !== "movie") return json({ error: "Choose a Movie Channel." }, 400);
        return json(await parentMovieChannelState(env.DB, household.id, channel.id, env.MOVIE_ROTATION_SEED));
      }
      if (channel.type !== "tv") return json({ error: "Choose a TV Channel." }, 400);
      const run = await tvPreparationRun(env.DB, household.id);
      return json({
        run: run ? tvPreparationRunForChannel(run, channel.id) : null,
      }, 200, { "cache-control": "no-store" });
    }

    const channelActionMatch = path.match(
      /^\/api\/households\/([A-Za-z0-9_-]+)\/channels\/([A-Za-z0-9-]+)\/(movie-rotation\/reset|tv-schedule\/undo|tv-schedule\/regenerate)$/,
    );
    if (request.method === "POST" && channelActionMatch) {
      const household = await findHousehold(env.DB, channelActionMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      const channel = await findChannel(env.DB, household.id, channelActionMatch[2]);
      if (!channel) return json({ error: "Channel was not found." }, 404);
      const action = channelActionMatch[3];
      if (action === "movie-rotation/reset") {
        if (channel.type !== "movie") return json({ error: "Choose a Movie Channel." }, 400);
        await resetMovieRotation(env.DB, household.id, channel.id, env.MOVIE_ROTATION_SEED);
        return json({ message: "Movie rotation reset without interrupting the Current Programme. Restart Stremio to refresh the Channel." });
      }
      if (channel.type !== "tv") return json({ error: "Choose a TV Channel." }, 400);
      if (action === "tv-schedule/undo") {
        const undone = await undoLatestTvAdvancement(env.DB, household.id, channel.id, env.TV_SCHEDULE_SEED);
        if (!undone) return json({ error: "There is no latest TV advancement to undo." }, 409);
        queueAutomaticTvPreparation(env, ctx, household.id);
        return json({ message: "Most recent advancement undone. Restart Stremio to refresh the Channel." });
      }
      await refreshTvChannelSchedule(env.DB, household.id, channel.id, true, env.TV_SCHEDULE_SEED);
      queueAutomaticTvPreparation(env, ctx, household.id);
      return json({ message: "Upcoming TV selections regenerated. Restart Stremio to refresh the Channel." });
    }

    const tvStateMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/tv-state$/);
    if (request.method === "GET" && tvStateMatch) {
      const household = await findHousehold(env.DB, tvStateMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      const channel = await legacyChannel(env.DB, household.id, "tv");
      if (!channel) return json({ error: "Default TV Channel was deleted." }, 404);
      return json(await parentTvChannelState(env.DB, household.id, channel.id, env.TV_SCHEDULE_SEED));
    }

    const preparationMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/tv-preparation$/);
    if (preparationMatch && request.method === "GET") {
      const household = await findHousehold(env.DB, preparationMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401, { "cache-control": "no-store" });
      }
      return json({ run: await tvPreparationRun(env.DB, household.id) }, 200, { "cache-control": "no-store" });
    }

    const movieStateMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/movie-state$/);
    if (request.method === "GET" && movieStateMatch) {
      const household = await findHousehold(env.DB, movieStateMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      const channel = await legacyChannel(env.DB, household.id, "movie");
      if (!channel) return json({ error: "Default Movie Channel was deleted." }, 404);
      return json(await parentMovieChannelState(env.DB, household.id, channel.id, env.MOVIE_ROTATION_SEED));
    }

    const resetMoviesMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/movie-rotation\/reset$/);
    if (request.method === "POST" && resetMoviesMatch) {
      const household = await findHousehold(env.DB, resetMoviesMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      const channel = await legacyChannel(env.DB, household.id, "movie");
      if (!channel) return json({ error: "Default Movie Channel was deleted." }, 404);
      await resetMovieRotation(env.DB, household.id, channel.id, env.MOVIE_ROTATION_SEED);
      return json({ message: "Movie rotation reset without interrupting the Current Programme. Restart Stremio to refresh the Channel." });
    }

    const progressMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/library\/([A-Za-z0-9-]+)\/progress$/);
    if (request.method === "PATCH" && progressMatch) {
      const household = await findHousehold(env.DB, progressMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      let input: { videoId?: unknown; channelId?: unknown } = {};
      try { input = await request.json() as typeof input; } catch { /* handled below */ }
      if (typeof input.videoId !== "string") return json({ error: "Choose a valid regular released episode." }, 400);
      const channel = typeof input.channelId === "string"
        ? await findChannel(env.DB, household.id, input.channelId, "tv")
        : await legacyChannel(env.DB, household.id, "tv");
      if (!channel) return json({ error: "TV Channel was not found." }, 404);
      try {
        await setShowProgress(env.DB, household.id, channel.id, progressMatch[2], input.videoId, env.TV_SCHEDULE_SEED);
      } catch (error) {
        if (error instanceof Error && error.message === "episode is invalid") {
          return json({ error: "Choose a valid regular released episode for this show." }, 400);
        }
        throw error;
      }
      queueAutomaticTvPreparation(env, ctx, household.id);
      return json({ message: "Show Progress corrected and incompatible future selections repaired. The active stream was not interrupted. Restart Stremio to refresh the Channel." });
    }

    const undoMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/tv-schedule\/undo$/);
    if (request.method === "POST" && undoMatch) {
      const household = await findHousehold(env.DB, undoMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      const channel = await legacyChannel(env.DB, household.id, "tv");
      if (!channel) return json({ error: "Default TV Channel was deleted." }, 404);
      const undone = await undoLatestTvAdvancement(env.DB, household.id, channel.id, env.TV_SCHEDULE_SEED);
      if (!undone) return json({ error: "There is no latest TV advancement to undo." }, 409);
      queueAutomaticTvPreparation(env, ctx, household.id);
      return json({ message: "Most recent advancement undone without changing later corrections to other shows. The active stream was not interrupted. Restart Stremio to refresh the Channel." });
    }

    const regenerateMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/tv-schedule\/regenerate$/);
    if (request.method === "POST" && regenerateMatch) {
      const household = await findHousehold(env.DB, regenerateMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      const channel = await legacyChannel(env.DB, household.id, "tv");
      if (!channel) return json({ error: "Default TV Channel was deleted." }, 404);
      await refreshTvChannelSchedule(env.DB, household.id, channel.id, true, env.TV_SCHEDULE_SEED);
      queueAutomaticTvPreparation(env, ctx, household.id);
      return json({ message: "Upcoming TV selections regenerated without changing the Current Programme or Show Progress. Restart Stremio to refresh the Channel." });
    }

    const manifestMatch = path.match(/^\/addons\/([A-Za-z0-9_-]+)\/manifest\.json$/);
    if (request.method === "GET" && manifestMatch) {
      const household = await findHousehold(env.DB, manifestMatch[1]);
      if (!household) return addonJson({ error: "Household not found." }, 404);
      return addonJson(manifestFor(household));
    }

    const configureMatch = path.match(/^\/addons\/([A-Za-z0-9_-]+)\/configure$/);
    if (request.method === "GET" && configureMatch) {
      if (!(await findHousehold(env.DB, configureMatch[1]))) return addonJson({ error: "Household not found." }, 404);
      return Response.redirect(`${url.origin}/households/${configureMatch[1]}`, 302);
    }

    const catalogMatch = path.match(/^\/addons\/([A-Za-z0-9_-]+)\/catalog\/([^/]+)\/([^/]+)\.json$/);
    if (request.method === "GET" && catalogMatch) {
      const household = await findHousehold(env.DB, catalogMatch[1]);
      if (!household) return addonJson({ error: "Household not found." }, 404);
      const catalog = catalogFor(
        catalogMatch[2],
        catalogMatch[3],
        url.origin,
        await channelsForHousehold(env.DB, household.id),
      );
      return catalog ? addonJson(catalog) : addonJson({ metas: [] });
    }

    const metaMatch = path.match(/^\/addons\/([A-Za-z0-9_-]+)\/meta\/series\/([^/]+)\.json$/);
    if (request.method === "GET" && metaMatch) {
      const household = await findHousehold(env.DB, metaMatch[1]);
      if (!household) return addonJson({ error: "Household not found." }, 404);
      const channels = await channelsForHousehold(env.DB, household.id, "tv");
      const channelId = channelIdFromStremioId(channels, decodedPathSegment(metaMatch[2]) ?? "");
      const channel = channelId ? channels.find((candidate) => candidate.id === channelId) : undefined;
      if (!channel) return addonJson({ meta: null });
      const schedule = await tvChannelSchedule(env.DB, household.id, channel.id, env.TV_SCHEDULE_SEED);
      return addonJson(
        tvChannelMetadata(channel, schedule, url.origin, household.secret),
        200,
        { "cache-control": "no-store" },
      );
    }

    const movieMetaMatch = path.match(/^\/addons\/([A-Za-z0-9_-]+)\/meta\/movie\/([^/]+)\.json$/);
    if (request.method === "GET" && movieMetaMatch) {
      const household = await findHousehold(env.DB, movieMetaMatch[1]);
      if (!household) return addonJson({ error: "Household not found." }, 404);
      const channels = await channelsForHousehold(env.DB, household.id, "movie");
      const channelId = channelIdFromStremioId(channels, decodedPathSegment(movieMetaMatch[2]) ?? "");
      const channel = channelId ? channels.find((candidate) => candidate.id === channelId) : undefined;
      if (!channel) return addonJson({ meta: null });
      const programme = await movieChannelProgramme(env.DB, household.id, channel.id, env.MOVIE_ROTATION_SEED);
      return addonJson(
        movieChannelMetadata(channel, programme, url.origin, household.secret),
        200,
        { "cache-control": "no-store" },
      );
    }

    const movieSignOffMatch = path.match(
      /^\/addons\/([A-Za-z0-9_-]+)\/media\/movie-sign-off\/([A-Za-z0-9-]+)\/(\d+)\/(\d+)\.mp4$/,
    );
    if ((request.method === "GET" || request.method === "HEAD") && movieSignOffMatch) {
      const household = await findHousehold(env.DB, movieSignOffMatch[1]);
      if (!household) return addonJson({ error: "Household not found." }, 404);
      const channel = await findChannel(env.DB, household.id, movieSignOffMatch[2], "movie");
      if (!channel) return addonJson({ error: "Movie Channel not found." }, 404);
      await requestMovieSignOff(
        env.DB,
        household.id,
        channel.id,
        Number(movieSignOffMatch[3]),
        Number(movieSignOffMatch[4]),
      );
      return movieSignOff(request);
    }

    const playMatch = path.match(
      /^\/addons\/([A-Za-z0-9_-]+)\/play\/(series|movie)\/([A-Za-z0-9-]+)\/([^/]+)$/,
    );
    if ((request.method === "GET" || request.method === "HEAD") && playMatch) {
      const household = await findHousehold(env.DB, playMatch[1]);
      if (!household) return playbackResponse("Household not found.", 404);
      const channelType = playMatch[2] === "series" ? "tv" : "movie";
      const channel = await findChannel(env.DB, household.id, playMatch[3], channelType);
      if (!channel) return playbackResponse("Channel not found.", 404);
      const videoId = decodedPathSegment(playMatch[4]);
      if (!videoId) return playbackResponse("Programme not found.", 404);
      return playChannelProgramme(request, env, ctx, household, channel, playMatch[2] as StreamContentType, videoId);
    }

    const resolveMatch = path.match(/^\/addons\/([A-Za-z0-9_-]+)\/resolve\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
    if (request.method === "GET" && resolveMatch) {
      const household = await findHousehold(env.DB, resolveMatch[1]);
      if (!household) return addonJson({ error: "Household not found." }, 404, { "cache-control": "no-store" });
      if (!env.CONFIG_SECRET) {
        return addonJson({ error: "Stream resolution is temporarily unavailable." }, 503, { "cache-control": "no-store" });
      }
      const identity = await verifyStreamToken(resolveMatch[2], household.id, env.CONFIG_SECRET);
      if (!identity) {
        return addonJson({ error: "Stream authorization is invalid or expired." }, 403, { "cache-control": "no-store" });
      }
      try {
        const torBoxToken = await loadTorBoxCredential(env.DB, household.id, env.CONFIG_SECRET);
        if (!torBoxToken) {
          return addonJson({ error: "TorBox is not configured for this Household." }, 503, { "cache-control": "no-store" });
        }
        let currentIdentity: StreamIdentity = identity;
        let context = await streamSelectionContext(env.DB, household.id, currentIdentity);
        const excludedInfoHashes = new Set<string>();
        for (let attempt = 0; attempt < MAX_RESOLUTION_ATTEMPTS; attempt += 1) {
          try {
            const directLink = await resolveCachedStream(
              env.DB,
              household.id,
              currentIdentity,
              torBoxToken,
              env,
              Date.now(),
              request.headers.get("cf-connecting-ip") ?? undefined,
            );
            return new Response(null, {
              status: 302,
              headers: {
                location: directLink,
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
                "x-content-type-options": "nosniff",
                "access-control-allow-origin": "*",
              },
            });
          } catch (error) {
            if (!(error instanceof StreamSelectionGoneError) || !context) throw error;
            await discardStreamSelection(
              env.DB,
              household.id,
              currentIdentity,
              torBoxToken,
              env,
            );
            excludedInfoHashes.add(context.infoHash);
            if (attempt === MAX_RESOLUTION_ATTEMPTS - 1) throw error;
            const alternative = await selectCachedStream(
              env.DB,
              household.id,
              context.contentType,
              context.videoId,
              torBoxToken,
              env,
              new Date(),
              excludedInfoHashes,
            );
            if (!alternative) throw error;
            currentIdentity = { torrentId: alternative.torrentId, fileId: alternative.fileId };
            context = {
              contentType: alternative.contentType,
              videoId: alternative.videoId,
              infoHash: alternative.infoHash,
            };
          }
        }
        throw new StreamSelectionGoneError("no alternate stream remains");
      } catch (error) {
        if (error instanceof StreamSelectionGoneError) {
          await invalidateStreamSelection(env.DB, household.id, identity);
          return addonJson(
            { error: "This stream selection is no longer available. Request the stream again." },
            410,
            { "cache-control": "no-store" },
          );
        }
        if (error instanceof TorBoxResolutionError) {
          const retryAfter = error.retryAfter ? { "retry-after": error.retryAfter } : undefined;
          return addonJson(
            { error: "TorBox could not resolve this stream. Try again." },
            error.status === 429 ? 503 : 502,
            { "cache-control": "no-store", ...retryAfter },
          );
        }
        return addonJson(
          { error: "Stream resolution is temporarily unavailable." },
          502,
          { "cache-control": "no-store" },
        );
      }
    }

    const streamMatch = path.match(/^\/addons\/([A-Za-z0-9_-]+)\/stream\/(series|movie)\/([^/]+)\.json$/);
    if (request.method === "GET" && streamMatch) {
      const household = await findHousehold(env.DB, streamMatch[1]);
      if (!household) return addonJson({ error: "Household not found." }, 404);
      const videoId = decodedPathSegment(streamMatch[3]);
      const streamChannel = streamMatch[2] === "series"
        ? await legacyChannel(env.DB, household.id, "tv")
        : null;
      if (streamMatch[2] === "movie") {
        const signOff = videoId ? parseSignOffId(videoId) : null;
        if (signOff) {
          const signOffChannel = signOff.channelId
            ? await findChannel(env.DB, household.id, signOff.channelId, "movie")
            : await legacyChannel(env.DB, household.id, "movie");
          if (!signOffChannel) return addonJson({ streams: [] }, 200, { "cache-control": "no-store" });
          await requestMovieSignOff(env.DB, household.id, signOffChannel.id, signOff.cycle, signOff.position);
          return addonJson({ streams: [{
            name: "Kids Channels",
            description: "Five-second sign-off",
            url: `${url.origin}/assets/movie-sign-off.mp4`,
            behaviorHints: {
              bingeGroup: "kids-channels-movie-sign-off",
              filename: "kids-channels-sign-off.mp4",
            },
          }] }, 200, { "cache-control": "no-store" });
        }
      }

      if (!videoId || !env.CONFIG_SECRET) {
        return addonJson({ streams: [] }, 200, { "cache-control": "no-store" });
      }
      try {
        const torBoxToken = await loadTorBoxCredential(env.DB, household.id, env.CONFIG_SECRET);
        if (!torBoxToken) {
          if (streamMatch[2] === "series" && streamChannel) {
            await requestTvProgramme(env.DB, household.id, streamChannel.id, videoId, env.TV_SCHEDULE_SEED);
            queueAutomaticTvPreparation(env, ctx, household.id);
          }
          return addonJson({ streams: [] }, 200, { "cache-control": "no-store" });
        }
        const selection = await selectCachedStream(
          env.DB,
          household.id,
          streamMatch[2] as StreamContentType,
          videoId,
          torBoxToken,
          env,
        );
        if (!selection) {
          if (streamMatch[2] !== "series") {
            return addonJson({ streams: [] }, 200, { "cache-control": "no-store" });
          }
          if (!streamChannel) return addonJson({ streams: [] }, 200, { "cache-control": "no-store" });
          await requestTvProgramme(env.DB, household.id, streamChannel.id, videoId, env.TV_SCHEDULE_SEED);
          queueAutomaticTvPreparation(env, ctx, household.id);
          const deferred = await deferUnavailableTvProgramme(
            env.DB,
            household.id,
            streamChannel.id,
            videoId,
            env.TV_SCHEDULE_SEED,
          );
          return addonJson({ streams: [{
            name: "Kids Channels",
            description: deferred.terminal
              ? "Programme unavailable • Try again later"
              : "Programme unavailable • Trying next show",
            url: `${url.origin}/assets/programme-unavailable-v2.mp4`,
            behaviorHints: {
              ...(deferred.terminal ? {} : { bingeGroup: "kids-channels-tv" }),
              filename: "kids-channels-programme-unavailable.mp4",
            },
          }] }, 200, { "cache-control": "no-store" });
        }
        if (streamMatch[2] === "series") {
          if (!streamChannel) return addonJson({ streams: [] }, 200, { "cache-control": "no-store" });
          await clearUnavailableTvProgramme(env.DB, household.id, videoId);
          await requestTvProgramme(env.DB, household.id, streamChannel.id, videoId, env.TV_SCHEDULE_SEED);
          queueAutomaticTvPreparation(env, ctx, household.id);
        }
        const resolveToken = await issueStreamToken(
          household.id,
          selection.torrentId,
          selection.fileId,
          Date.parse(selection.staleAt),
          env.CONFIG_SECRET,
        );
        return addonJson({ streams: [{
          name: "Kids Channels",
          description: `${selection.quality} • TorBox ready`,
          url: `${url.origin}/addons/${household.secret}/resolve/${resolveToken}`,
          behaviorHints: {
            bingeGroup: streamMatch[2] === "series"
              ? "kids-channels-tv"
              : `kids-channels-${selection.quality.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`,
            filename: selection.filename,
          },
        }] }, 200, { "cache-control": "no-store" });
      } catch {
        return addonJson({ streams: [] }, 200, { "cache-control": "no-store" });
      }
    }

    return json({ error: "Not found." }, 404);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(ensureAutomaticTvPreparationForAll(env).catch((error) => {
      console.error(JSON.stringify({
        message: "automatic TV preparation sweep failed",
        reason: error instanceof Error ? error.message : "unknown error",
      }));
    }));
    ctx.waitUntil(pruneObsoleteChannelState(env.DB).then((result) => {
      const totalDeleted = Object.values(result.deleted).reduce((total, count) => total + count, 0);
      if (totalDeleted > 0) console.log(JSON.stringify({ message: "obsolete Channel state pruned", ...result }));
    }).catch((error) => {
      console.error(JSON.stringify({
        message: "obsolete Channel state cleanup failed",
        reason: error instanceof Error ? error.message : "unknown error",
      }));
    }));
  },
} satisfies ExportedHandler<Env>;
