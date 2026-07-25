import { approveProgramme, approvedLibrary, hasApprovedProgramme } from "./approved-library";
import { CinemetaClient, type ContentType } from "./cinemeta";
import { createHousehold, findHousehold, validPin, verifyPin } from "./households";
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
import { issueParentToken, verifyParentToken } from "./secrets";
import { movieSignOff } from "./sign-off-media";
import { catalogFor, manifestFor, movieChannelMetadata, TV_CHANNEL_ID, tvChannelMetadata } from "./stremio";
import {
  parentTvChannelState,
  refreshTvChannelSchedule,
  requestTvProgramme,
  setShowProgress,
  tvChannelSchedule,
  undoLatestTvAdvancement,
} from "./tv-channel";

export interface Env {
  DB: D1Database;
  CONFIG_SECRET?: string;
  CINEMETA_ORIGIN?: string;
  TV_SCHEDULE_SEED?: string;
  MOVIE_ROTATION_SEED?: string;
}

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
};

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...jsonHeaders, ...headers },
  });
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
    .channel-list { padding-left: 1.5rem; } .channel-list li { margin: .65rem 0; color: #cbd0ea; }
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
      <h2>TV Channel</h2>
      <p id="tv-current">No Current Programme.</p>
      <button id="undo-tv" type="button" class="secondary" hidden>Undo most recent advancement</button>
      <h3>Channel Schedule</h3>
      <ol id="tv-schedule" class="channel-list"><li>No programmes scheduled.</li></ol>
      <h3>Recently played</h3>
      <ol id="tv-history" class="channel-list"><li>No recent playback.</li></ol>
      <p id="tv-status" role="status"></p>
      <h2>Movie Channel</h2>
      <p id="movie-current">No Current Programme.</p>
      <h3>Remaining rotation</h3>
      <ol id="movie-rotation" class="channel-list"><li>No movies remaining.</li></ol>
      <h3>Recently played</h3>
      <ol id="movie-history" class="channel-list"><li>No recent playback.</li></ol>
      <button id="reset-movies" type="button" class="secondary">Reset movie rotation</button>
      <p id="movie-status" role="status"></p>
      <h2>Approved Library</h2>
      <p class="notice">Stremio keeps Channel details in memory. After changing the Approved Library or regenerating selections, fully close and reopen Stremio to load the updated Channel.</p>
      <button id="regenerate-tv" type="button" class="secondary">Regenerate upcoming TV selections</button>
      <p id="library-status" role="status"></p>
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
        if (approved && programme.type === 'show') {
          const progress = document.createElement('p');
          progress.textContent = programme.showProgress
            ? 'Show Progress: ' + episodeLabel(programme.showProgress)
            : 'Finished';
          const episode = document.createElement('select'); episode.setAttribute('aria-label', 'Next episode for ' + programme.title);
          programme.episodes.forEach(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = episodeLabel(item); episode.append(option); });
          episode.value = programme.showProgress?.id || programme.episodes[0]?.id || '';
          const correct = document.createElement('button'); correct.type = 'button';
          correct.textContent = programme.showProgress ? 'Set Show Progress' : 'Restart show';
          correct.addEventListener('click', () => correctProgress(programme.id, episode.value, correct));
          details.append(progress, episode, correct);
        }
        if (approved) {
          if (programme.type === 'show') {
            const pause = document.createElement('button'); pause.type = 'button';
            pause.textContent = programme.pausedAt ? 'Resume show' : 'Pause show';
            pause.addEventListener('click', () => changeProgramme(programme.id, {paused: !programme.pausedAt}, pause));
            details.append(pause);
          }
          const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary';
          remove.textContent = 'Remove ' + (programme.type === 'show' ? 'show' : 'movie');
          remove.addEventListener('click', () => removeProgramme(programme.id, remove)); details.append(remove);
        }
        card.append(image, details); return {card, details};
      }
      function episodeLabel(episode) {
        return 'S' + String(episode.season).padStart(2, '0') + 'E' + String(episode.episode).padStart(2, '0') + ' — ' + episode.title;
      }
      async function loadTvState() {
        const response = await fetch('/api/households/${secret}/tv-state', {headers: headers()});
        const result = await response.json(); if (!response.ok) return;
        document.querySelector('#tv-current').textContent = result.current
          ? result.current.showTitle + ' — ' + episodeLabel(result.current.episode)
          : 'No Current Programme.';
        const schedule = document.querySelector('#tv-schedule'); schedule.replaceChildren();
        (result.schedule.length ? result.schedule : [{empty: 'No programmes scheduled.'}]).forEach(item => {
          const row = document.createElement('li'); row.textContent = item.empty || item.showTitle + ' — ' + episodeLabel(item.episode); schedule.append(row);
        });
        const history = document.querySelector('#tv-history'); history.replaceChildren();
        (result.recentPlayback.length ? result.recentPlayback : [{empty: 'No recent playback.'}]).forEach(item => {
          const row = document.createElement('li'); row.textContent = item.empty || item.showTitle + ' — ' + episodeLabel(item.episode); history.append(row);
        });
        document.querySelector('#undo-tv').hidden = !result.canUndo;
      }
      async function loadMovieState() {
        const response = await fetch('/api/households/${secret}/movie-state', {headers: headers()});
        const result = await response.json(); if (!response.ok) return;
        document.querySelector('#movie-current').textContent = result.current
          ? result.current.title
          : 'No Current Programme.';
        const rotation = document.querySelector('#movie-rotation'); rotation.replaceChildren();
        (result.remaining.length ? result.remaining : [{empty: 'No movies remaining.'}]).forEach(item => {
          const row = document.createElement('li'); row.textContent = item.empty || item.title; rotation.append(row);
        });
        const history = document.querySelector('#movie-history'); history.replaceChildren();
        (result.recentPlayback.length ? result.recentPlayback : [{empty: 'No recent playback.'}]).forEach(item => {
          const row = document.createElement('li'); row.textContent = item.empty || item.title; history.append(row);
        });
      }
      async function loadLibrary() {
        const response = await fetch('/api/households/${secret}/library', {headers: headers()});
        const result = await response.json(); const output = document.querySelector('#library'); output.replaceChildren();
        if (!result.programmes.length) { const empty = document.createElement('p'); empty.textContent = 'No programmes approved yet.'; output.append(empty); return; }
        result.programmes.forEach(programme => output.append(programmeCard(programme, true).card));
      }
      async function changeProgramme(programmeId, body, button) {
        button.disabled = true;
        const response = await fetch('/api/households/${secret}/library/' + encodeURIComponent(programmeId), {
          method: 'PATCH', headers: {...headers(), 'content-type': 'application/json'}, body: JSON.stringify(body)
        });
        const result = await response.json();
        if (!response.ok) { button.disabled = false; document.querySelector('#library-status').textContent = result.error; return; }
        document.querySelector('#library-status').textContent = result.message; await Promise.all([loadLibrary(), loadTvState(), loadMovieState()]);
      }
      async function correctProgress(programmeId, videoId, button) {
        button.disabled = true;
        const response = await fetch('/api/households/${secret}/library/' + encodeURIComponent(programmeId) + '/progress', {
          method: 'PATCH', headers: {...headers(), 'content-type': 'application/json'}, body: JSON.stringify({videoId})
        });
        const result = await response.json(); button.disabled = false;
        document.querySelector('#library-status').textContent = response.ok ? result.message : result.error;
        if (response.ok) await Promise.all([loadLibrary(), loadTvState()]);
      }
      async function removeProgramme(programmeId, button) {
        button.disabled = true;
        const response = await fetch('/api/households/${secret}/library/' + encodeURIComponent(programmeId), {method: 'DELETE', headers: headers()});
        const result = await response.json();
        if (!response.ok) { button.disabled = false; document.querySelector('#library-status').textContent = result.error; return; }
        document.querySelector('#library-status').textContent = result.message; await Promise.all([loadLibrary(), loadTvState(), loadMovieState()]);
      }
      async function approve(programme, startingEpisodeId, button) {
        button.disabled = true;
        const response = await fetch('/api/households/${secret}/library', {
          method: 'POST', headers: {...headers(), 'content-type': 'application/json'},
          body: JSON.stringify({type: programme.type, imdbId: programme.id, startingEpisodeId})
        });
        const result = await response.json();
        if (!response.ok) { button.disabled = false; button.textContent = result.error; return; }
        button.textContent = 'Approved'; await Promise.all([loadLibrary(), loadTvState(), loadMovieState()]);
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
        form.hidden = true; document.querySelector('#result').hidden = false; await Promise.all([loadLibrary(), loadTvState(), loadMovieState()]);
      });
      document.querySelector('#regenerate-tv').addEventListener('click', async (event) => {
        const button = event.currentTarget; button.disabled = true;
        const response = await fetch('/api/households/${secret}/tv-schedule/regenerate', {method: 'POST', headers: headers()});
        const result = await response.json(); button.disabled = false;
        document.querySelector('#library-status').textContent = response.ok ? result.message : result.error;
        if (response.ok) await loadTvState();
      });
      document.querySelector('#reset-movies').addEventListener('click', async (event) => {
        const button = event.currentTarget; button.disabled = true;
        const response = await fetch('/api/households/${secret}/movie-rotation/reset', {method: 'POST', headers: headers()});
        const result = await response.json(); button.disabled = false;
        document.querySelector('#movie-status').textContent = response.ok ? result.message : result.error;
        if (response.ok) await loadMovieState();
      });
      document.querySelector('#undo-tv').addEventListener('click', async (event) => {
        const button = event.currentTarget; button.disabled = true;
        const response = await fetch('/api/households/${secret}/tv-schedule/undo', {method: 'POST', headers: headers()});
        const result = await response.json(); button.disabled = false;
        document.querySelector('#tv-status').textContent = response.ok ? result.message : result.error;
        if (response.ok) await Promise.all([loadLibrary(), loadTvState()]);
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
      return new Response(null, { status: 204, headers: { ...jsonHeaders, "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "access-control-allow-headers": "content-type, authorization" } });
    }

    if (request.method === "GET" && path === "/") return html(homePage());
    if (request.method === "GET" && path === "/assets/tv-channel.svg") return channelPoster("tv");
    if (request.method === "GET" && path === "/assets/movie-channel.svg") return channelPoster("movie");
    if ((request.method === "GET" || request.method === "HEAD") && path === "/assets/movie-sign-off.mp4") return movieSignOff(request);

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
    if (libraryProgrammeMatch && (request.method === "PATCH" || request.method === "DELETE")) {
      const household = await findHousehold(env.DB, libraryProgrammeMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household.id, env.CONFIG_SECRET))) {
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

    const tvStateMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/tv-state$/);
    if (request.method === "GET" && tvStateMatch) {
      const household = await findHousehold(env.DB, tvStateMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household.id, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      return json(await parentTvChannelState(env.DB, household.id, env.TV_SCHEDULE_SEED));
    }

    const movieStateMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/movie-state$/);
    if (request.method === "GET" && movieStateMatch) {
      const household = await findHousehold(env.DB, movieStateMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household.id, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      return json(await parentMovieChannelState(env.DB, household.id, env.MOVIE_ROTATION_SEED));
    }

    const resetMoviesMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/movie-rotation\/reset$/);
    if (request.method === "POST" && resetMoviesMatch) {
      const household = await findHousehold(env.DB, resetMoviesMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household.id, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      await resetMovieRotation(env.DB, household.id, env.MOVIE_ROTATION_SEED);
      return json({ message: "Movie rotation reset without interrupting the Current Programme. Restart Stremio to refresh the Channel." });
    }

    const progressMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/library\/([A-Za-z0-9-]+)\/progress$/);
    if (request.method === "PATCH" && progressMatch) {
      const household = await findHousehold(env.DB, progressMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household.id, env.CONFIG_SECRET))) {
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
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household.id, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      const undone = await undoLatestTvAdvancement(env.DB, household.id, env.TV_SCHEDULE_SEED);
      if (!undone) return json({ error: "There is no latest TV advancement to undo." }, 409);
      return json({ message: "Most recent advancement undone without changing later corrections to other shows. The active stream was not interrupted. Restart Stremio to refresh the Channel." });
    }

    const regenerateMatch = path.match(/^\/api\/households\/([A-Za-z0-9_-]+)\/tv-schedule\/regenerate$/);
    if (request.method === "POST" && regenerateMatch) {
      const household = await findHousehold(env.DB, regenerateMatch[1]);
      if (!household || !env.CONFIG_SECRET || !(await authorizedParent(request, household.id, env.CONFIG_SECRET))) {
        return json({ error: "Parent authentication is required." }, 401);
      }
      await refreshTvChannelSchedule(env.DB, household.id, true, env.TV_SCHEDULE_SEED);
      return json({ message: "Upcoming TV selections regenerated without changing the Current Programme or Show Progress. Restart Stremio to refresh the Channel." });
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
      const schedule = await tvChannelSchedule(env.DB, household.id, env.TV_SCHEDULE_SEED);
      return json(tvChannelMetadata(schedule, url.origin), 200, { "cache-control": "no-store" });
    }

    const movieMetaMatch = path.match(/^\/addons\/([A-Za-z0-9_-]+)\/meta\/movie\/([^/]+)\.json$/);
    if (request.method === "GET" && movieMetaMatch) {
      const household = await findHousehold(env.DB, movieMetaMatch[1]);
      if (!household) return json({ error: "Household not found." }, 404);
      if (decodedPathSegment(movieMetaMatch[2]) !== MOVIE_CHANNEL_ID) return json({ meta: null });
      const programme = await movieChannelProgramme(env.DB, household.id, env.MOVIE_ROTATION_SEED);
      return json(movieChannelMetadata(programme, url.origin, household.secret), 200, { "cache-control": "no-store" });
    }

    const movieSignOffMatch = path.match(/^\/addons\/([A-Za-z0-9_-]+)\/media\/movie-sign-off\/(\d+)\/(\d+)\.mp4$/);
    if ((request.method === "GET" || request.method === "HEAD") && movieSignOffMatch) {
      const household = await findHousehold(env.DB, movieSignOffMatch[1]);
      if (!household) return json({ error: "Household not found." }, 404);
      await requestMovieSignOff(env.DB, household.id, Number(movieSignOffMatch[2]), Number(movieSignOffMatch[3]));
      return movieSignOff(request);
    }

    const streamMatch = path.match(/^\/addons\/([A-Za-z0-9_-]+)\/stream\/(series|movie)\/([^/]+)\.json$/);
    if (request.method === "GET" && streamMatch) {
      const household = await findHousehold(env.DB, streamMatch[1]);
      if (!household) return json({ error: "Household not found." }, 404);
      const videoId = decodedPathSegment(streamMatch[3]);
      if (streamMatch[2] === "series") {
        if (videoId) await requestTvProgramme(env.DB, household.id, videoId, env.TV_SCHEDULE_SEED);
        // Kids Channels observes schedule movement here. A separately installed provider supplies
        // the playable stream and must place bingeGroup on that stream object.
        return json({ streams: [] }, 200, { "cache-control": "no-store" });
      }

      const signOff = videoId ? parseSignOffId(videoId) : null;
      if (!signOff) {
        // Canonical IMDb identity lets installed providers own movie playback and subtitles.
        return json({ streams: [] }, 200, { "cache-control": "no-store" });
      }
      await requestMovieSignOff(env.DB, household.id, signOff.cycle, signOff.position);
      return json({ streams: [{
        name: "Kids Channels",
        description: "Five-second sign-off",
        url: `${url.origin}/assets/movie-sign-off.mp4`,
        behaviorHints: {
          bingeGroup: "kids-channels-movie-sign-off",
          filename: "kids-channels-sign-off.mp4",
        },
      }] }, 200, { "cache-control": "no-store" });
    }

    return json({ error: "Not found." }, 404);
  },
} satisfies ExportedHandler<Env>;
