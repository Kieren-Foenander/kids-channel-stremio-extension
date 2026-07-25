const manifestValue = process.env.PROVIDER_MANIFEST_URL;
if (!manifestValue) {
  console.error("Set PROVIDER_MANIFEST_URL to a configured HTTPS provider manifest URL.");
  process.exitCode = 2;
} else {
  try {
    const manifestUrl = new URL(manifestValue);
    if (manifestUrl.protocol !== "https:" || !manifestUrl.pathname.endsWith("/manifest.json")) throw new Error();

    const manifestResponse = await fetch(manifestUrl, { headers: { accept: "application/json" } });
    const manifest = await manifestResponse.json();
    if (!manifestResponse.ok || typeof manifest.id !== "string" || !Array.isArray(manifest.resources)) throw new Error();

    const streamUrl = new URL(manifestUrl);
    streamUrl.pathname = `${streamUrl.pathname.slice(0, -"manifest.json".length)}stream/movie/tt0111161.json`;
    const streamResponse = await fetch(streamUrl, { headers: { accept: "application/json" } });
    const body = await streamResponse.json();
    if (!streamResponse.ok || !Array.isArray(body.streams)) throw new Error();

    const direct = body.streams.filter((stream) => typeof stream?.url === "string" && /^https?:\/\//.test(stream.url));
    const cached = direct.filter((stream) => {
      const label = `${stream?.name ?? ""}\n${stream?.title ?? ""}`;
      return (/(?:^|[^a-z0-9])RD\+(?=$|[^a-z0-9])/i.test(label) && !/download/i.test(label))
        || /^\[RD⚡\]\s+Comet\b/i.test(stream?.name ?? "");
    });
    const acceptable = cached.filter((stream) => /\b1080p?\b/i.test(`${stream?.name ?? ""}\n${stream?.title ?? ""}`));
    console.log(`Probe succeeded: manifest valid; direct results=${direct.length}; cached Real-Debrid results=${cached.length}; acceptable 1080p results=${acceptable.length}.`);
  } catch {
    console.error("Probe failed: the manifest or representative stream request was not usable.");
    process.exitCode = 1;
  }
}
