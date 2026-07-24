import { createHousehold, findHousehold, validPin, verifyPin } from "./households";
import { catalogFor, manifestFor } from "./stremio";

export interface Env {
  DB: D1Database;
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
      "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
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
    input, button, .button { box-sizing: border-box; width: 100%; min-height: 3rem; border-radius: .6rem; border: 1px solid #566098; padding: .7rem 1rem; font: inherit; }
    input { background: #0e1224; color: white; font-size: 1.25rem; letter-spacing: .2em; }
    button, .button { display: block; cursor: pointer; background: #725cff; border-color: #8c7aff; color: white; font-weight: 800; text-align: center; text-decoration: none; margin-top: 1rem; }
    .secondary { background: transparent; }
    .notice { border-left: .25rem solid #ffca5c; padding-left: 1rem; }
    .error { color: #ff9292; min-height: 1.5rem; }
    code { overflow-wrap: anywhere; color: #aeb8ff; }
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
    </section>
    <script>
      const form = document.querySelector('#unlock-form');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const response = await fetch('/api/households/${secret}/unlock', {
          method: 'POST', headers: {'content-type': 'application/json'},
          body: JSON.stringify({pin: new FormData(form).get('pin')})
        });
        const result = await response.json();
        if (!response.ok) { document.querySelector('#error').textContent = result.error; return; }
        document.querySelector('#install').href = result.installUrl;
        document.querySelector('#manifest').textContent = result.manifestUrl;
        form.hidden = true;
        document.querySelector('#result').hidden = false;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...jsonHeaders, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" } });
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
      return json(installDetails(url.origin, unlockMatch[1]));
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

    return json({ error: "Not found." }, 404);
  },
} satisfies ExportedHandler<Env>;
