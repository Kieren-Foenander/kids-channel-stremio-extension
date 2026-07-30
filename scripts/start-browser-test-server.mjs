import { spawn, spawnSync } from "node:child_process";
import http from "node:http";

const show = {
  id: "tt1234567", imdb_id: "tt1234567", type: "series", name: "The Example",
  description: "A recognisable family show.", poster: "https://placehold.co/300x450?text=Example+Show",
  releaseInfo: "2020–", genres: ["Family", "Animation"], imdbRating: "8.4",
  videos: [
    { id: "tt1234567:0:1", season: 0, episode: 1, title: "Special", released: "2019-12-01T00:00:00.000Z" },
    { id: "tt1234567:1:1", season: 1, episode: 1, title: "First", released: "2020-01-01T00:00:00.000Z" },
    { id: "tt1234567:1:2", season: 1, episode: 2, title: "Second", released: "2020-01-08T00:00:00.000Z" },
    { id: "tt1234567:1:3", season: 1, episode: 3, title: "Unreleased", released: "2999-01-01T00:00:00.000Z" },
  ],
};
const secondShow = {
  ...show,
  id: "tt1111111",
  imdb_id: "tt1111111",
  name: "The Example (1990)",
  releaseInfo: "1990",
  videos: show.videos.map((episode) => ({ ...episode, id: episode.id.replace("tt1234567", "tt1111111") })),
};
const movie = {
  id: "tt7654321", imdb_id: "tt7654321", type: "movie", name: "Example: The Movie",
  description: "A family film.", poster: "https://placehold.co/300x450?text=Example+Movie",
  releaseInfo: "2022", genres: ["Family"], imdbRating: "7.1",
};
const movies = [movie, ...Array.from({ length: 13 }, (_, index) => ({
  ...movie,
  id: `tt76543${String(index + 22).padStart(2, "0")}`,
  imdb_id: `tt76543${String(index + 22).padStart(2, "0")}`,
  name: `Example Movie ${index + 2}`,
  description: `Details for example movie ${index + 2}.`,
  poster: `https://placehold.co/300x450?text=Example+Movie+${index + 2}`,
}))];

const stub = http.createServer((request, response) => {
  let body;
  if (request.url === "/rest/1.0/user") {
    if (request.headers.authorization !== "Bearer browser-real-debrid-token") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "bad_token" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: 123, username: "browser-parent" }));
    return;
  }
  if (request.url?.includes("search=failure")) {
    response.writeHead(503); response.end(); return;
  }
  if (request.url?.startsWith("/catalog/series/top/search=")) {
    body = { metas: [show, secondShow] };
  } else if (request.url?.startsWith("/catalog/movie/top/search=")) body = { metas: movies };
  else if (request.url === "/meta/series/tt1234567.json") body = { meta: show };
  else if (request.url === "/meta/series/tt1111111.json") body = { meta: secondShow };
  else if (request.url?.startsWith("/meta/movie/")) {
    const id = request.url.match(/^\/meta\/movie\/(tt\d+)\.json$/)?.[1];
    const matchingMovie = movies.find((item) => item.imdb_id === id);
    if (matchingMovie) body = { meta: matchingMovie };
    else { response.writeHead(404); response.end(); return; }
  } else { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(body));
});
await new Promise((resolve) => stub.listen(8791, "127.0.0.1", resolve));

const build = spawnSync("pnpm", ["build"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
const migration = spawnSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "kids-channels-browser", "--local", "--config", "wrangler.browser.jsonc"], { stdio: "inherit" });
if (migration.status !== 0) process.exit(migration.status ?? 1);
const worker = spawn("pnpm", ["exec", "wrangler", "dev", "--config", "wrangler.browser.jsonc", "--port", "8790", "--ip", "127.0.0.1"], { stdio: "inherit" });

function stop() { worker.kill("SIGTERM"); stub.close(); }
process.on("SIGINT", stop); process.on("SIGTERM", stop);
worker.on("exit", (code) => { stub.close(); process.exit(code ?? 0); });
