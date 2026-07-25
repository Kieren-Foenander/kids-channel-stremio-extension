import { approveProgramme, approvedLibrary, hasApprovedProgramme } from "./approved-library";
import { CinemetaClient, type ContentType } from "./cinemeta";
import { tvCurrentProgramme } from "./current-programme";
import { createHousehold, findHousehold, validPin, verifyPin } from "./households";
import { issueParentToken, verifyParentToken } from "./secrets";
import { catalogFor, manifestFor, TV_CHANNEL_ID, tvChannelMetadata } from "./stremio";

export interface Env {
  DB: D1Database;
  CONFIG_SECRET?: string;
  CINEMETA_ORIGIN?: string;
}

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: jsonHeaders });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'self'; img-src 'self' https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

function shell(content: string, title = "Kids Channels"): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #101426; color: #f7f8ff; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
    main { width: min(34rem, calc(100% - 2rem)); background: #1b2140; border: 1px solid #343c69; border-radius: 1rem; padding: clamp(1.25rem, 5vw, 2.5rem); box-shadow: 0 1.5rem 5rem #080a14; }
    h1 { margin-top: 0; } p { line-height: 1.55; color: #cbd0ea; }
    label { display: block; font-weight: 700; margin: 1.5rem 0 .5rem; }
    input, select, button, .button { box-sizing: border-box; width: 100%; min-height: 3rem; border-radius: .6rem; border: 1px solid #566098; padding: .7rem 1rem; font: inherit; }
    input, select { background: #0e1224; color: white; font-size: 1.1rem; }
    input[name="pin"] { letter-spacing: .2em; }
    button, .button { display: block; cursor: pointer; background: #725cff; border-color: #8c7aff; color: white; font-weight: 800; text-align: center; text-decoration: none; margin-top: 1rem; }
    .secondary { background: transparent; }
    .notice { border-left: .25rem solid #ffca5c; padding-left: 1rem; }
    .error { color: #ff9292; min-height: 1.5rem; }
    code { overflow-wrap: anywhere; color: #aeb8ff; }
    .programme { display: grid; grid-template-columns: 5rem 1fr; gap: 1rem; margin: 1rem 0; padding: 1rem; border: 1px solid #343c69; border-radius: .75rem; }
    .programme img { width: 5rem; min-height: 7rem; object-fit: cover; border-radius: .35rem; background: #0e1224; }
    .programme h3 { margin: 0; } .programme p { margin: .35rem 0; }
    .programme button { width: auto; min-height: 2.5rem; margin-top: .5rem; }
    .eyebrow { color: #65d6ad; font-size: .8rem; font-weight: 800; text-transform: uppercase; }
    [hidden] { display: none !important; }
  </style>
</head>
<body><main>${content}</main></body>
</html>`;
}

function installDetails(origin: string, secret: string) {
  const manifestUrl = `${origin}/addons/${secret}/manifest.json`;
  return {
    manifestUrl,
    installUrl: `stremio://${manifestUrl.replace(/^https?:\/\//, "")}`,
    parentUrl: `${origin}/households/${secret}`,
  };
}

function homePage(): string {
  return shell(`
    <h1>Kids Channels</h1>
    <p>Create an isolated Household with one TV Channel and one Movie Channel.</p>
    <form id="create-form">
      <label for="pin">Choose a six-digit Parent PIN</label>
      <input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="new-password" required>
      <p class="notice">There is no forgotten-PIN recovery. Store your PIN somewhere safe.</p>
      <button type="submit">Create Household</button>
      <p id="error" class="error" role="alert"></p>
    </form>
    <section id="result" hidden>
      <h2>Household created</h2>
      <p>Your private addon is ready. Install it on desktop while signed into the Stremio account used by your household devices.</p>
      <a id="install" class="button" href="#">Install in Stremio</a>
      <a id="parent" class="button secondary" href="#">Open Parent Page</a>
      <p>Manifest: <code id="manifest"></code></p>
    </section>
    <script>
      const form = document.querySelector('#create-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const error = document.querySelector('#error');
        error.textContent = '';
        const response = await fetch('/api/households', {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({pin: new FormData(form).get('pin')})
        });
        const result = await response.json();
        if (!response.ok) { error.textContent = result.error; return; }
        document.querySelector('#install').href = result.installUrl;
        document.querySelector('#parent').href = result.parentUrl;
        document.querySelector('#manifest').textContent = result.manifestUrl;
        form.hidden = true;
        document.querySelector('#result').hidden = false;
      });
    </script>`);
}

function parentPage(secret: string): string {
  return shell(`
    <h1>Parent Page</h1>
    <p>Enter your six-digit PIN to manage this Household.</p>
    <form id="unlock-form">
      <label for="pin">Parent PIN</label>
      <input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="current-password" required>
      <button type="submit">Unlock Household</button>
      <p id="error" class="error" role="alert"></p>
    </form>
    <section id="result" hidden>
      <h2>Household unlocked</h2>
      <a id="install" class="button" href="#">Install in Stremio</a>
      <p>Manifest: <code id="manifest"></code></p>
      <form id="search-form">
        <label for="search">Search Cinemeta for shows and movies</label>
        <input id="search" name="query" type="search" minlength="2" maxlength="100" placeholder="Bluey, Paddington…" required>
        <button type="submit">Search</button>
        <p id="search-status" role="status"></p>
      </form>
      <div id="search-results"></div>
      <h2>Approved Library</h2>
      <div id="library"><p>No programmes approved yet.</p></div>
      <p class="notice">Install and configure a stream addon such as Comet in Stremio. Kids Channels selects the programme; Stremio resolves streams on your device.</p>
    </section>
    <script>
      const form = document.querySelector('#unlock-form');
      const headers = () => ({authorization: 'Bearer ' + parentToken});
      let parentToken = '';
      function programmeCard(programme, approved) {
        const card = document.createElement('article'); card.className = 'programme';
        const image = document.createElement('img'); image.alt = ''; if (programme.poster) image.src = programme.poster;
        const details = document.createElement('div');
        const kind = document.createElement('div'); kind.className = 'eyebrow'; kind.textContent = programme.type === 'show' ? 'Show' : 'Movie';
        const heading = document.createElement('h3'); heading.textContent = programme.title;
        const metadata = document.createElement('p'); metadata.textContent = [programme.releaseInfo, (programme.genres || []).join(', '), programme.imdbRating ? 'IMDb ' + programme.imdbRating : ''].filter(Boolean).join(' · ');
        const description = document.createElement('p'); description.textContent = programme.description || 'No description available.';
        details.append(kind, heading, metadata, description);
        if (approved && programme.showProgress) {
          const progress = document.createElement('p'); progress.textContent = 'Starts at S' + String(programme.showProgress.season).padStart(2, '0') + 'E' + String(programme.showProgress.episode).padStart(2, '0') + ' — ' + programme.showProgress.title;
          details.append(progress);
        }
        card.append(image, details); return {card, details};
      }
      async function loadLibrary() {
        const response = await fetch('/api/households/${secret}/library', {headers: headers()});
        const result = await response.json(); const output = document.querySelector('#library'); output.replaceChildren();
        if (!result.programmes.length) { const empty = document.createElement('p'); empty.textContent = 'No programmes approved yet.'; output.append(empty); return; }
        result.programmes.forEach(programme => output.append(programmeCard(programme, true).card));
      }
      async function approve(programme, startingEpisodeId, button) {
        button.disabled = true;
        const response = await fetch('/api/households/${secret}/library', {
          method: 'POST', headers: {...headers(), 'content-type': 'application/json'},
          body: JSON.stringify({type: programme.type, imdbId: programme.id, startingEpisodeId})
        });
        const result = await response.json();
        if (!response.ok) { button.disabled = false; button.textContent = result.error; return; }
        button.textContent = 'Approved'; await loadLibrary();
      }
      function showSearchResult(programme) {
        const built = programmeCard(programme, false); const button = document.createElement('button');
        button.type = 'button'; button.textContent = programme.type === 'show' ? 'Choose starting episode' : 'Approve movie';
        button.addEventListener('click', async () => {
          if (programme.type === 'movie') return approve(programme, undefined, button);
          button.disabled = true; button.textContent = 'Loading episodes…';
          const response = await fetch('/api/households/${secret}/cinemeta/title/show/' + encodeURIComponent(programme.id), {headers: headers()});
          const result = await response.json();
          if (!response.ok) { button.disabled = false; button.textContent = result.error; return; }
          const select = document.createElement('select'); select.setAttribute('aria-label', 'Starting episode for ' + programme.title);
          result.title.episodes.forEach(episode => { const option = document.createElement('option'); option.value = episode.id; option.textContent = 'S' + String(episode.season).padStart(2, '0') + 'E' + String(episode.episode).padStart(2, '0') + ' — ' + episode.title; select.append(option); });
          button.disabled = false; button.textContent = 'Approve show'; button.replaceWith(select, button);
          button.addEventListener('click', () => approve(programme, select.value, button), {once: true});
        }, {once: programme.type === 'show'});
        built.details.append(button); return built.card;
      }
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const response = await fetch('/api/households/${secret}/unlock', {
          method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({pin: new FormData(form).get('pin')})
        });
        const result = await response.json();
        if (!response.ok) { document.querySelector('#error').textContent = result.error; return; }
        parentToken = result.parentToken; document.querySelector('#install').href = result.installUrl;
        document.querySelector('#manifest').textContent = result.manifestUrl;
        form.hidden = true; document.querySelector('#result').hidden = false; await loadLibrary();
      });
      document.querySelector('#search-form').addEventListener('submit', async (event) => {
        event.preventDefault(); const status = document.querySelector('#search-status'); status.textContent = 'Searching Cinemeta…';
        const query = new FormData(event.currentTarget).get('query');
        const response = await fetch('/api/households/${secret}/cinemeta/search?q=' + encodeURIComponent(query), {headers: headers()});
        const result = await response.json(); const output = document.querySelector('#search-results'); output.replaceChildren();
        if (!response.ok) { status.textContent = result.error; return; }
        status.textContent = result.results.length ? result.results.length + ' results' : 'No matching shows or movies.';
        result.results.forEach(programme => output.append(showSearchResult(programme)));
      });
    </script>`);
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

async function authorizedParent(request: Request, householdId: string, deploymentSecret: string): Promise<boolean> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  return verifyParentToken(authorization.slice(7), householdId, deploymentSecret);
}

function decodedPathSegment(value: string): string | null {
  try { return decodeURIComponent(value); } catch { return null; }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...jsonHeaders, "access-control-allow-methods": "GET, POST, PUT, OPTIONS", "access-control-allow-headers": "content-type, authorization" } });
    }

    if (request.method === "GET" && path === "/") return html(homePage());
    if (request.method === "GET" && path === "/assets/tv-channel.svg") return channelPoster("tv");
    if (request.method === "GET" && path === "/assets/movie-channel.svg") return channelPoster("movie");

    if (request.method === "POST" && path === "/api/households") {
      const pin = await parsePin(request);
      if (!validPin(pin)) return json({ error: "PIN must contain exactly six digits." }, 400);
      const household = await createHousehold(env.DB, pin);
      return json({ householdId: household.id, ...installDetails(url.origin, household.secret) }, 201);
    }

    const unlockMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/unlock$/);
    if (request.method === "POST" && unlockMatch) {
      const pin = await parsePin(request);
      if (!validPin(pin)) return json({ error: "PIN must contain exactly six digits." }, 400);
      if (!(await verifyPin(env.DB, unlockMatch[1], pin))) return json({ error: "Household or PIN is incorrect." }, 401);
      const household = await findHousehold(env.DB, unlockMatch[1]);
      if (!household) return json({ error: "Household or PIN is incorrect." }, 401);
      if (!env.CONFIG_SECRET) return json({ error: "Provider configuration is unavailable." }, 503);
      return json({
        ...installDetails(url.origin, unlockMatch[1]),
        parentToken: await issueParentToken(household.id, env.CONFIG_SECRET),
      });
    }

    const searchMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/cinemeta\/search$/);
    if (request.method === "GET" && searchMatch) {
      const household = await findHousehold(env.DB, searchMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household.id, env.CONFIG_SECRET))) {
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
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household.id, env.CONFIG_SECRET))) {
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
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household.id, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      if (request.method === "GET") return json({ programmes: await approvedLibrary(env.DB, household.id) });
      let input: { type?: unknown; imdbId?: unknown; startingEpisodeId?: unknown } = {};
      try { input = await request.json() as typeof input; } catch { /* handled below */ }
      if ((input.type !== "show" && input.type !== "movie") || typeof input.imdbId !== "string" || !/^tt\d+$/.test(input.imdbId)
        || (input.startingEpisodeId !== undefined && typeof input.startingEpisodeId !== "string")) {
        return json({ error: "Choose a valid Cinemeta show or movie." }, 400);
      }
      if (await hasApprovedProgramme(env.DB, household.id, input.type, input.imdbId)) {
        return json({ error: "This programme is already in the Approved Library." }, 409);
      }
      try {
        const title = await new CinemetaClient(env.CINEMETA_ORIGIN).title(input.type, input.imdbId);
        if (!title) return json({ error: "Programme was not found in Cinemeta." }, 404);
        const programme = await approveProgramme(env.DB, household.id, title, input.startingEpisodeId);
        return json({ programme }, 201);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "starting episode is invalid") return json({ error: "Choose a valid regular released starting episode." }, 400);
        if (message === "show has no regular released episodes") return json({ error: "This show has no regular released episodes to approve." }, 400);
        if (message.includes("UNIQUE")) return json({ error: "This programme is already in the Approved Library." }, 409);
        return json({ error: "Cinemeta metadata is temporarily unavailable." }, 502);
      }
    }

    const parentMatch = path.match(/^\/households\/([A-Za-z0-9_-]+)$/);
    if (request.method === "GET" && parentMatch) {
      if (!(await findHousehold(env.DB, parentMatch[1]))) return html(shell("<h1>Household not found</h1>"), 404);
      return html(parentPage(parentMatch[1]));
    }

    const manifestMatch = path.match(/^\/addons\/([A-Za-z0-9_-]+)\/manifest\.json$/);
    if (request.method === "GET" && manifestMatch) {
      const household = await findHousehold(env.DB, manifestMatch[1]);
      if (!household) return json({ error: "Household not found." }, 404);
      return json(manifestFor(household));
    }

    const configureMatch = path.match(/^\/addons\/([A-Za-z0-9_-]+)\/configure$/);
    if (request.method === "GET" && configureMatch) {
      if (!(await findHousehold(env.DB, configureMatch[1]))) return json({ error: "Household not found." }, 404);
      return Response.redirect(`${url.origin}/households/${configureMatch[1]}`, 302);
    }

    const catalogMatch = path.match(/^\/addons\/([A-Za-z0-9_-]+)\/catalog\/([^/]+)\/([^/]+)\.json$/);
    if (request.method === "GET" && catalogMatch) {
      if (!(await findHousehold(env.DB, catalogMatch[1]))) return json({ error: "Household not found." }, 404);
      const catalog = catalogFor(catalogMatch[2], catalogMatch[3], url.origin);
      return catalog ? json(catalog) : json({ metas: [] });
    }

    const metaMatch = path.match(/^\/addons\/([A-Za-z0-9_-]+)\/meta\/series\/([^/]+)\.json$/);
    if (request.method === "GET" && metaMatch) {
      const household = await findHousehold(env.DB, metaMatch[1]);
      if (!household) return json({ error: "Household not found." }, 404);
      if (decodedPathSegment(metaMatch[2]) !== TV_CHANNEL_ID) return json({ meta: null });
      return json(tvChannelMetadata(await tvCurrentProgramme(env.DB, household.id)));
    }


    return json({ error: "Not found." }, 404);
  },
} satisfies ExportedHandler<Env>;
