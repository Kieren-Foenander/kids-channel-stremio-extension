import { approveProgramme, approvedLibrary, approvedProgrammeDetail, hasApprovedProgramme } from "./approved-library";
import { CinemetaClient, type ContentType } from "./cinemeta";
import { firstPartyProviderProbeResponse } from "./first-party-provider-probe";
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
  MOVIE_CHANNEL_ID,
  parentMovieChannelState,
  parseSignOffId,
  reconcileMovieChannel,
  removeApprovedMovie,
  requestMovieSignOff,
  resetMovieRotation,
} from "./movie-channel";
import { householdOverview } from "./overview";
import {
  clearRealDebridCredential,
  loadRealDebridCredential,
  realDebridCredentialStatus,
  storeRealDebridCredential,
  validateRealDebridToken,
  validRealDebridToken,
} from "./real-debrid-credentials";
import {
  issueParentToken,
  issueStreamToken,
  parentTokenSecondsRemaining,
  verifyParentToken,
  verifyStreamToken,
} from "./secrets";
import { movieSignOff, programmeUnavailable } from "./sign-off-media";
import { catalogFor, manifestFor, movieChannelMetadata, TV_CHANNEL_ID, tvChannelMetadata } from "./stremio";
import {
  discardStreamSelection,
  invalidateStreamSelection,
  RealDebridResolutionError,
  resolveCachedStream,
  type StreamIdentity,
  streamSelectionContext,
  StreamSelectionGoneError,
} from "./stream-resolution";
import { selectCachedStream, type StreamContentType } from "./stream-selection";
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

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  CONFIG_SECRET?: string;
  CINEMETA_ORIGIN?: string;
  TV_SCHEDULE_SEED?: string;
  MOVIE_ROTATION_SEED?: string;
  REAL_DEBRID_ORIGIN?: string;
  ZILEAN_ORIGIN?: string;
  KNABEN_ORIGIN?: string;
}

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
  async fetch(request: Request, env: Env): Promise<Response> {
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

    const realDebridMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/real-debrid$/);
    if (realDebridMatch && ["GET", "PUT", "DELETE"].includes(request.method)) {
      const household = await findHousehold(env.DB, realDebridMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401, { "cache-control": "no-store" });
      }
      if (request.method === "GET") {
        return json(await realDebridCredentialStatus(env.DB, household.id), 200, { "cache-control": "no-store" });
      }
      if (request.method === "DELETE") {
        await clearRealDebridCredential(env.DB, household.id);
        return json(
          { configured: false, updatedAt: null, message: "Real-Debrid disconnected. Channel playback is unavailable until another token is saved." },
          200,
          { "cache-control": "no-store" },
        );
      }
      let input: { token?: unknown } = {};
      try { input = await request.json() as typeof input; } catch { /* handled below */ }
      if (!validRealDebridToken(input.token)) {
        return json({ error: "Enter a Real-Debrid API token without leading or trailing spaces." }, 400, { "cache-control": "no-store" });
      }
      const validation = await validateRealDebridToken(input.token, env.REAL_DEBRID_ORIGIN);
      if (validation === "invalid") {
        return json({ error: "Real-Debrid rejected this token. Check it and try again." }, 400, { "cache-control": "no-store" });
      }
      if (validation === "unavailable") {
        return json({ error: "Real-Debrid could not validate this token right now. Nothing was saved." }, 502, { "cache-control": "no-store" });
      }
      const status = await storeRealDebridCredential(env.DB, household.id, input.token, env.CONFIG_SECRET);
      return json(
        { ...status, message: "Real-Debrid connected. The token is stored encrypted for this Household." },
        200,
        { "cache-control": "no-store" },
      );
    }

    const providerProbeMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/provider-probe(?:\/(redirect))?$/);
    if (request.method === "POST" && providerProbeMatch) {
      const household = await findHousehold(env.DB, providerProbeMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401, { "cache-control": "no-store" });
      }
      let token: string | null;
      try {
        token = await loadRealDebridCredential(env.DB, household.id, env.CONFIG_SECRET);
      } catch {
        return json({ error: "The Household Real-Debrid credential could not be decrypted. Save it again in Settings." }, 503, { "cache-control": "no-store" });
      }
      if (!token) {
        return json({ error: "Connect Real-Debrid in Parent Page Settings before running the provider probe." }, 409, { "cache-control": "no-store" });
      }
      return firstPartyProviderProbeResponse(request, env, token, Boolean(providerProbeMatch[2]));
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
      let input: { type?: unknown; imdbId?: unknown; startingEpisodeId?: unknown } = {};
      try { input = await request.json() as typeof input; } catch { /* handled below */ }
      if ((input.type !== "show" && input.type !== "movie") || typeof input.imdbId !== "string" || !/^tt\d+$/.test(input.imdbId)) {
        return json({ error: "Choose a valid Cinemeta show or movie." }, 400);
      }
      if (input.startingEpisodeId !== undefined && (typeof input.startingEpisodeId !== "string" || input.startingEpisodeId.length === 0)) {
        return json({ error: "Choose a valid regular released starting episode." }, 400);
      }
      if (await hasApprovedProgramme(env.DB, household.id, input.type, input.imdbId)) {
        return json({ error: "This programme is already in the Approved Library." }, 409);
      }
      try {
        const title = await new CinemetaClient(env.CINEMETA_ORIGIN).title(input.type, input.imdbId);
        if (!title) return json({ error: "Programme was not found in Cinemeta." }, 404);
        const programme = await approveProgramme(env.DB, household.id, title, input.startingEpisodeId);
        if (programme.type === "movie") await reconcileMovieChannel(env.DB, household.id, env.MOVIE_ROTATION_SEED);
        return json({ programme }, 201);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "starting episode is invalid") return json({ error: "Choose a valid regular released starting episode." }, 400);
        if (message === "show has no regular released episodes") return json({ error: "This show has no regular released episodes to approve." }, 400);
        if (message.includes("UNIQUE")) return json({ error: "This programme is already in the Approved Library." }, 409);
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
        let input: { paused?: unknown } = {};
        try { input = await request.json() as typeof input; } catch { /* handled below */ }
        if (programme.content_type !== "show" || typeof input.paused !== "boolean") {
          return json({ error: "Choose whether to pause or resume an approved show." }, 400);
        }
        const pausedAt = input.paused ? new Date().toISOString() : null;
        await env.DB.prepare("UPDATE approved_programmes SET paused_at = ? WHERE id = ? AND household_id = ?")
          .bind(pausedAt, programme.id, household.id).run();
        await refreshTvChannelSchedule(env.DB, household.id, false, env.TV_SCHEDULE_SEED);
        return json({ message: `${input.paused ? "Show paused without changing Show Progress." : "Show resumed."} Restart Stremio to refresh the Channel.` });
      }

      if (programme.content_type === "show") {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM channel_schedule WHERE household_id = ? AND programme_id = ?").bind(household.id, programme.id),
          env.DB.prepare("DELETE FROM current_programmes WHERE household_id = ? AND programme_id = ?").bind(household.id, programme.id),
          env.DB.prepare("DELETE FROM show_progress WHERE programme_id = ?").bind(programme.id),
          env.DB.prepare("DELETE FROM show_episodes WHERE programme_id = ?").bind(programme.id),
          env.DB.prepare("DELETE FROM approved_programmes WHERE id = ? AND household_id = ?").bind(programme.id, household.id),
        ]);
        await refreshTvChannelSchedule(env.DB, household.id, false, env.TV_SCHEDULE_SEED);
      } else {
        await removeApprovedMovie(env.DB, household.id, programme.id, env.MOVIE_ROTATION_SEED);
      }
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

    const tvStateMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/tv-state$/);
    if (request.method === "GET" && tvStateMatch) {
      const household = await findHousehold(env.DB, tvStateMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      return json(await parentTvChannelState(env.DB, household.id, env.TV_SCHEDULE_SEED));
    }

    const movieStateMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/movie-state$/);
    if (request.method === "GET" && movieStateMatch) {
      const household = await findHousehold(env.DB, movieStateMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      return json(await parentMovieChannelState(env.DB, household.id, env.MOVIE_ROTATION_SEED));
    }

    const resetMoviesMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/movie-rotation\/reset$/);
    if (request.method === "POST" && resetMoviesMatch) {
      const household = await findHousehold(env.DB, resetMoviesMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      await resetMovieRotation(env.DB, household.id, env.MOVIE_ROTATION_SEED);
      return json({ message: "Movie rotation reset without interrupting the Current Programme. Restart Stremio to refresh the Channel." });
    }

    const progressMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/library\/([A-Za-z0-9-]+)\/progress$/);
    if (request.method === "PATCH" && progressMatch) {
      const household = await findHousehold(env.DB, progressMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      let input: { videoId?: unknown } = {};
      try { input = await request.json() as typeof input; } catch { /* handled below */ }
      if (typeof input.videoId !== "string") return json({ error: "Choose a valid regular released episode." }, 400);
      try {
        await setShowProgress(env.DB, household.id, progressMatch[2], input.videoId, env.TV_SCHEDULE_SEED);
      } catch (error) {
        if (error instanceof Error && error.message === "episode is invalid") {
          return json({ error: "Choose a valid regular released episode for this show." }, 400);
        }
        throw error;
      }
      return json({ message: "Show Progress corrected and incompatible future selections repaired. The active stream was not interrupted. Restart Stremio to refresh the Channel." });
    }

    const undoMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/tv-schedule\/undo$/);
    if (request.method === "POST" && undoMatch) {
      const household = await findHousehold(env.DB, undoMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      const undone = await undoLatestTvAdvancement(env.DB, household.id, env.TV_SCHEDULE_SEED);
      if (!undone) return json({ error: "There is no latest TV advancement to undo." }, 409);
      return json({ message: "Most recent advancement undone without changing later corrections to other shows. The active stream was not interrupted. Restart Stremio to refresh the Channel." });
    }

    const regenerateMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/tv-schedule\/regenerate$/);
    if (request.method === "POST" && regenerateMatch) {
      const household = await findHousehold(env.DB, regenerateMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      await refreshTvChannelSchedule(env.DB, household.id, true, env.TV_SCHEDULE_SEED);
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
      if (!(await findHousehold(env.DB, catalogMatch[1]))) return addonJson({ error: "Household not found." }, 404);
      const catalog = catalogFor(catalogMatch[2], catalogMatch[3], url.origin);
      return catalog ? addonJson(catalog) : addonJson({ metas: [] });
    }

    const metaMatch = path.match(/^\/addons\/([A-Za-z0-9_-]+)\/meta\/series\/([^/]+)\.json$/);
    if (request.method === "GET" && metaMatch) {
      const household = await findHousehold(env.DB, metaMatch[1]);
      if (!household) return addonJson({ error: "Household not found." }, 404);
      if (decodedPathSegment(metaMatch[2]) !== TV_CHANNEL_ID) return addonJson({ meta: null });
      const schedule = await tvChannelSchedule(env.DB, household.id, env.TV_SCHEDULE_SEED);
      return addonJson(tvChannelMetadata(schedule, url.origin), 200, { "cache-control": "no-store" });
    }

    const movieMetaMatch = path.match(/^\/addons\/([A-Za-z0-9_-]+)\/meta\/movie\/([^/]+)\.json$/);
    if (request.method === "GET" && movieMetaMatch) {
      const household = await findHousehold(env.DB, movieMetaMatch[1]);
      if (!household) return addonJson({ error: "Household not found." }, 404);
      if (decodedPathSegment(movieMetaMatch[2]) !== MOVIE_CHANNEL_ID) return addonJson({ meta: null });
      const programme = await movieChannelProgramme(env.DB, household.id, env.MOVIE_ROTATION_SEED);
      return addonJson(movieChannelMetadata(programme, url.origin, household.secret), 200, { "cache-control": "no-store" });
    }

    const movieSignOffMatch = path.match(/^\/addons\/([A-Za-z0-9_-]+)\/media\/movie-sign-off\/(\d+)\/(\d+)\.mp4$/);
    if ((request.method === "GET" || request.method === "HEAD") && movieSignOffMatch) {
      const household = await findHousehold(env.DB, movieSignOffMatch[1]);
      if (!household) return addonJson({ error: "Household not found." }, 404);
      await requestMovieSignOff(env.DB, household.id, Number(movieSignOffMatch[2]), Number(movieSignOffMatch[3]));
      return movieSignOff(request);
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
        const realDebridToken = await loadRealDebridCredential(env.DB, household.id, env.CONFIG_SECRET);
        if (!realDebridToken) {
          return addonJson({ error: "Real-Debrid is not configured for this Household." }, 503, { "cache-control": "no-store" });
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
              realDebridToken,
              env,
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
              realDebridToken,
              env,
            );
            excludedInfoHashes.add(context.infoHash);
            if (attempt === MAX_RESOLUTION_ATTEMPTS - 1) throw error;
            const alternative = await selectCachedStream(
              env.DB,
              household.id,
              context.contentType,
              context.videoId,
              realDebridToken,
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
        if (error instanceof RealDebridResolutionError) {
          const retryAfter = error.retryAfter ? { "retry-after": error.retryAfter } : undefined;
          return addonJson(
            { error: "Real-Debrid could not resolve this stream. Try again." },
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
      if (streamMatch[2] === "movie") {
        const signOff = videoId ? parseSignOffId(videoId) : null;
        if (signOff) {
          await requestMovieSignOff(env.DB, household.id, signOff.cycle, signOff.position);
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
        const realDebridToken = await loadRealDebridCredential(env.DB, household.id, env.CONFIG_SECRET);
        if (!realDebridToken) {
          if (streamMatch[2] === "series") {
            await requestTvProgramme(env.DB, household.id, videoId, env.TV_SCHEDULE_SEED);
          }
          return addonJson({ streams: [] }, 200, { "cache-control": "no-store" });
        }
        const selection = await selectCachedStream(
          env.DB,
          household.id,
          streamMatch[2] as StreamContentType,
          videoId,
          realDebridToken,
          env,
        );
        if (!selection) {
          if (streamMatch[2] !== "series") {
            return addonJson({ streams: [] }, 200, { "cache-control": "no-store" });
          }
          await requestTvProgramme(env.DB, household.id, videoId, env.TV_SCHEDULE_SEED);
          const deferred = await deferUnavailableTvProgramme(
            env.DB,
            household.id,
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
          await clearUnavailableTvProgramme(env.DB, household.id, videoId);
          await requestTvProgramme(env.DB, household.id, videoId, env.TV_SCHEDULE_SEED);
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
          description: `${selection.quality} • Real-Debrid cached`,
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
} satisfies ExportedHandler<Env>;
