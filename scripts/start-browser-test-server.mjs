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
const movie = {
  id: "tt7654321", imdb_id: "tt7654321", type: "movie", name: "Example: The Movie",
  description: "A family film.", poster: "https://placehold.co/300x450?text=Example+Movie",
  releaseInfo: "2022", genres: ["Family"], imdbRating: "7.1",
};

const stub = http.createServer((request, response) => {
  let body;
  if (request.url?.startsWith("/catalog/series/top/search=")) {
    body = { metas: [show, { ...show, id: "tt1111111", imdb_id: "tt1111111", name: "The Example (1990)", releaseInfo: "1990" }] };
  } else if (request.url?.startsWith("/catalog/movie/top/search=")) body = { metas: [movie] };
  else if (request.url === "/meta/series/tt1234567.json") body = { meta: show };
  else if (request.url === "/meta/movie/tt7654321.json") body = { meta: movie };
  else { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(body));
});
await new Promise((resolve) => stub.listen(8791, "127.0.0.1", resolve));

const migration = spawnSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "kids-channels-browser", "--local", "--config", "wrangler.browser.jsonc"], { stdio: "inherit" });
if (migration.status !== 0) process.exit(migration.status ?? 1);
const worker = spawn("pnpm", ["exec", "wrangler", "dev", "--config", "wrangler.browser.jsonc", "--port", "8790", "--ip", "127.0.0.1"], { stdio: "inherit" });

function stop() { worker.kill("SIGTERM"); stub.close(); }
process.on("SIGINT", stop); process.on("SIGTERM", stop);
worker.on("exit", (code) => { stub.close(); process.exit(code ?? 0); });
